import { spawn, execFile, execFileSync } from 'node:child_process'
import { findSshBinary, nativeMux, useNativeSsh } from './native/native-runtime'
import { runScpArgv, runSshArgv, startNativeMaster } from './native/native-invoke'
import { findExecutableSync, shellPathNow } from '../exec-path'
import { SshChildGate } from './ssh-child-gate'
import { probeAgentSockToPin } from './agent-probe'
import { MASTER_STDERR_CAP } from './ssh-project-limits'
import type { SshProjectRunners } from './ssh-project'
import type { AppSshAgent } from './ssh-agent'
import type { AskpassServer } from './ssh-askpass'

// One process-wide budget for all callers sharing a ControlMaster.
const sshChildGate = new SshChildGate()

/**
 * Resolve an absolute ssh path; GUI apps don't inherit the shell PATH.
 * Mirrors findSsh() in pty-manager.ts: subprocess-free (the old sync login-shell probe + `-V`
 * spawns blocked the main thread) — walks the cached login-shell PATH from exec-path.ts, then
 * the common locations. A MISS is only memoized once the async PATH probe has settled.
 * (Do NOT use the brief's always-returns-first stub.)
 */
function sshBin(): string {
  return findSshBinary() ?? 'ssh'
}

/** Resolve an absolute `scp` path the same way `sshBin()` resolves `ssh` (GUI apps lack shell PATH). */
let cachedScp: string | null | undefined
function scpBin(): string {
  if (cachedScp !== undefined) return cachedScp ?? 'scp'
  const found = findExecutableSync('scp', [
    '/usr/bin/scp',
    '/usr/local/bin/scp',
    '/opt/homebrew/bin/scp'
  ])
  if (found || shellPathNow() !== undefined) cachedScp = found
  return found ?? 'scp'
}

type TransportField = 'spawnMaster' | 'masterEnvFor' | 'ensureAgent' | 'probeAgentSock' | 'onIdle' |
  'askpassWasCancelled' | 'askpassIsPrompting' | 'askpassAsked' | 'runSync' | 'run' | 'probe' | 'runScp'
export interface SshProcessRunnerOptions extends Omit<SshProjectRunners, TransportField> {
  agent: Pick<AppSshAgent, 'env' | 'start' | 'scheduleStop'>
  askpass: Pick<AskpassServer, 'envFor' | 'wasCancelledBy' | 'isPromptingAny' | 'askedBy'>
  askpassScriptPath?: string
  /** Capture before queueing; recheck immediately before an exec can use its control socket. */
  captureExecutionCheck?(args: readonly string[]): () => boolean
}
/** OpenSSH/native transport composition shared by the native and headless shells. */
export function makeSshProjectRunners(options: SshProcessRunnerOptions): SshProjectRunners {
  const { agent: appSshAgent, askpass: askpassServer, askpassScriptPath, captureExecutionCheck, ...rest } = options
  const ssh = sshBin(); const scp = scpBin(); const native = useNativeSsh()
  return {
    ...rest,
    spawnMaster: native ? (args) => startNativeMaster(nativeMux(), args) : (args, env) => {
      // Capture the master's stderr (stdin/stdout stay ignored) so a failed connect can report the
      // real ssh error instead of a generic timeout. Buffer is capped so a chatty host can't grow it
      // unbounded; the master is long-lived and mostly silent, so this holds only the connect-time
      // diagnostics we actually want.
      const child = spawn(ssh, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: env && Object.keys(env).length ? { ...process.env, ...env } : process.env
      })
      let stderr = ''
      let exited = false
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MASTER_STDERR_CAP) stderr += chunk.toString('utf-8')
      })
      // A spawn failure (ssh binary missing/unexecutable) surfaces on 'error', fold it into the
      // same stderr channel so the connect error still has a cause. Prevents an unhandled 'error'.
      child.on('error', (e: Error) => {
        exited = true
        if (stderr.length < MASTER_STDERR_CAP) stderr += `${e.message}\n`
      })
      // Exit is a meaningful signal both ways: with ControlPersist a SUCCESSFUL master
      // daemonizes and exits (socket already bound), and a failed one exits with the cause on
      // stderr. connect()'s wait loop reads it through the exited() probe.
      child.on('exit', () => {
        exited = true
      })
      return {
        kill: () => child.kill(),
        on: (ev, cb) => child.on(ev, cb),
        stderr: () => stderr,
        exited: () => exited,
        pid: () => child.pid
      }
    },
    masterEnvFor: (identityFile) => ({
      ...(askpassScriptPath ? askpassServer.envFor(identityFile, askpassScriptPath) : {}),
      ...appSshAgent.env()
    }),
    // No app-private ssh-agent on the native transport: Windows' ssh-agent is a service and has no
    // `-a <socket>`, and the native transport authenticates in-process (agent pipe, then key files).
    ensureAgent: native ? async () => {} : () => appSshAgent.start(),
    // The `ssh -G` probe that honors a config-level `IdentityAgent SSH_AUTH_SOCK` (issue #427):
    // shared with the pty spawn path in core, so the master and the fallback children can never
    // disagree about which agent a host is routed at.
    probeAgentSock: (conn) => probeAgentSockToPin(conn),
    // The last SSH project was disconnected by the user: forget the unlocked key (after a grace,
    // see scheduleStop — the connect dialog's throwaway browse master disconnects right before the
    // real project connects).
    onIdle: () => appSshAgent.scheduleStop(),
    // Native: a declined passphrase is reported in the master's own error text (native-mux.ts), and
    // the "key held only in your system agent" hint is about the app-private agent, which the
    // native transport does not use — so answer "asked" to keep that hint off.
    askpassWasCancelled: native ? () => false : (masterPid) => askpassServer.wasCancelledBy(masterPid),
    askpassIsPrompting: native ? () => false : () => askpassServer.isPromptingAny(),
    askpassAsked: native ? () => true : (masterPid) => askpassServer.askedBy(masterPid),
    runSync: native ? (args) => void runSshArgv(nativeMux(), args) : (args) => {
      // Quit path only (disconnectAll). Bounded hard: `before-quit` is blocked while this runs, and
      // an unreachable host must not add seconds to every quit.
      try {
        execFileSync(ssh, args, { timeout: 400, stdio: 'ignore' })
      } catch {
        // The master may already be gone, the host unreachable, or the timeout hit. Best effort.
      }
    },
    // Bounded per ControlMaster: a connect's install fan-out, a Source Control refresh and a
    // switch's mount burst all land on one multiplexed connection, and past the host's
    // `MaxSessions` every excess child silently becomes a full login — enough of those at once
    // and sshd's `MaxStartups` resets some outright, which the app sees as a dropped terminal.
    // Mux control commands and the terminals themselves are never queued (see ssh-child-gate.ts).
    run: (args, stdin, timeoutMs) => {
      const current = captureExecutionCheck?.(args)
      return sshChildGate.run(args, () => {
        if (current && !current()) return Promise.resolve({ code: 255, stdout: '' })
        return native
          ? // Still gated: sshd's MaxSessions bounds channels on ONE connection just as it bounds
            // mux clients on a ControlMaster.
            runSshArgv(nativeMux(), args, { stdin, timeoutMs: timeoutMs ?? 15000 }).then((r) => ({
              code: r.timedOut ? 1 : (r.code ?? 1),
              stdout: r.stdout.toString('utf-8')
            }))
          : new Promise<{ code: number; stdout: string }>((resolve) => {
          // 16 MB ceiling: remote transcript reads pull up to REMOTE_TRANSCRIPT_CAP (5 MB) via
          // RemoteFile; the default 1 MB maxBuffer would kill the child and silently break the
          // remote context meter / subagent transcript / content search for large transcripts.
          // (cf. pty-manager tmux capture 50 MB, git-service 20–50 MB.) Just a ceiling, safe for
          // the small Phase-1/2a control commands too.
          // The agent env rides along here too: `childArgs` uses `ControlMaster=auto`, so with the
          // master down the first child ssh authenticates for real, and the only place the unlocked
          // key lives is the app-private agent.
          const child = execFile(
            ssh,
            args,
            { timeout: timeoutMs ?? 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...appSshAgent.env() } },
            (err, stdout) =>
              resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? '' })
          )
          if (stdin !== undefined) {
            // ssh can die before draining stdin (unreachable host, bad option, instant auth
            // refusal) — that EPIPE is an async 'error' EVENT on the pipe, not a throw here, and
            // unhandled it kills the main process (issue #382's class). The execFile callback
            // above already reports the child's exit; log and stand by.
            child.stdin?.on('error', (e: NodeJS.ErrnoException) => {
              console.warn(`[ssh-project] ssh stdin write failed (${e.code ?? e})`)
            })
            child.stdin?.end(stdin)
          }
        })
      })
    },
    // Deliberately NOT through `sshChildGate`: after a sleep the gate is typically full of children
    // hung on the very master this probes, and queueing behind them would time the queue.
    probe: (args, timeoutMs) =>
      native
        ? runSshArgv(nativeMux(), args, { timeoutMs }).then((r) => (r.timedOut ? 'timeout' : 'answered'))
        : new Promise((resolve) => {
        execFile(
          ssh,
          args,
          { timeout: timeoutMs, env: { ...process.env, ...appSshAgent.env() } },
          (err) => resolve(err && (err as { killed?: boolean }).killed ? 'timeout' : 'answered')
        )
      }),
    runScp: (args) =>
      native
        ? runScpArgv(nativeMux(), args).then((r) => {
            if (r.renamed) console.warn(`[ssh] download: ${r.renamed} file name(s) were changed to be valid on this computer`)
            return { code: r.code }
          })
        : new Promise((resolve) => {
        // Same reason as `run`: scp re-authenticates when the master socket is gone.
        execFile(scp, args, { maxBuffer: 1024 * 1024, env: { ...process.env, ...appSshAgent.env() } }, (err) =>
          resolve({ code: err ? 1 : 0 })
        )
      }),
  }
}
