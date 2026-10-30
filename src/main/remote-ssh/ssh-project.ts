import { findSshBinary, nativeMux, setNativePassphrasePrompt, useNativeSsh } from '../../core/remote-ssh/native/native-runtime'
import { runScpArgv, runSshArgv, startNativeMaster } from '../../core/remote-ssh/native/native-invoke'
import path from 'path'
import { spawn, execFile, execFileSync } from 'child_process'
import { app, ipcMain } from 'electron'
import { MASTER_STDERR_CAP, PROMPT_WAIT_MS } from '../../core/remote-ssh/ssh-project-limits'
import { IPC } from '../../shared/ipc'
import { getMainWindow, sendToMain } from '../main-window'
import { type SshConnection } from '../../shared/ssh'
import type { SshPassphraseRequest, SshProjectStatusEvent } from '../../shared/types'
import { findExecutableSync, shellPathNow } from '../../core/exec-path'
import { allowMediaPath } from '../media-protocol'
import { SshChildGate } from '../../core/remote-ssh/ssh-child-gate'

import { hookServer } from '../../core/agents/hook-server'
import { nodeIdsForCanvas, remoteNodeTokenMinter, setRemoteNodeTokenWriter } from '../../core/agents/node-token-service'
import { setRemoteSessionEnvWriter } from '../../core/remote-ssh/session-env'
import { askpassServer } from './ssh-askpass'
import { appSshAgent } from './ssh-agent'
import { probeAgentSockToPin } from '../../core/remote-ssh/agent-probe'

import { SshProjectManager, type SshProjectRunners as Runners } from '../../core/remote-ssh/ssh-project'
export { SshProjectManager, lastSshErrorLine, remoteCodexAccountSetupCommand, remoteCodexAppServerStartCommand } from '../../core/remote-ssh/ssh-project'
export type { ConnectResult } from '../../core/remote-ssh/ssh-project'

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

/**
 * Pending renderer answers to sshPassphraseRequest, keyed by requestId. One `ipcMain.handle` for
 * sshPassphraseSubmit resolves whichever entry the user answered.
 */
const pendingPassphrasePrompts = new Map<string, (value: string | null) => void>()

/**
 * Push to the renderer without ever letting the UI's health become load-bearing. `isDestroyed()`
 * on the window is NOT enough: `webContents.send` throws "Render frame was disposed" when the
 * frame is gone but the window object is not (a renderer crash, Cmd+R, navigation, quit). Left
 * unguarded that throw either abandoned an in-flight passphrase prompt (answered as empty, so ssh
 * dropped the key and the connect died with a bare Permission denied) or, from the expiry timer
 * below, escaped as an UNCAUGHT exception in the main process. Returns false when nothing could
 * be delivered.
 *
 * The explicit getMainWindow() probe is the other half: sendToMain's optional chain silently
 * NO-OPS when there is no window at all (macOS close-to-dock, or before the first window exists),
 * so without the probe this returned true for a send nobody received. That false "delivered" kept
 * promptForPassphrase's no-UI branch dead exactly when it was needed: with the window closed and
 * the watchdog respawning a master after a network drop, the prompt was "sent" to nothing and the
 * askpass curl held the ssh master for the full 5-minute expiry, repeating every watchdog cycle
 * until the window was reopened.
 *
 * ACCEPTED gap: `true` still only means "the webContents took the send". During a Cmd+R reload
 * the frame is alive before React has re-attached onPassphraseRequest, so a prompt raised in
 * that window is dropped and its connect rides the prompt expiry, after which the watchdog's
 * next reconnect prompts again into the now-attached listener. Closing it needs a renderer ack
 * handshake per prompt; a one-in-a-reload race that self-heals within one expiry does not buy
 * that machinery.
 */
function pushToRenderer(channel: string, payload: unknown): boolean {
  if (!getMainWindow()) return false
  try {
    sendToMain(channel, payload)
    return true
  } catch {
    return false
  }
}

/** `null` means the user actively declined; `undefined` means nobody ever answered (the prompt
 *  expired or there was no UI to ask). Only a real decline should be reported as a cancellation. */
type PromptOutcome = string | null | undefined

/** Exported for tests: the whole main-side prompt path (deliver, expire, dismiss, no-UI) runs
 *  without Electron, with the window faked through main-window's setMainWindow. */
export function promptForPassphrase(req: {
  identityFile: string
  retry: boolean
  /** `user@host` this unlock is for, when the asking master could be identified. One key can
   *  serve several servers and this prompt can fire from the watchdog long after any connect
   *  dialog closed, so without it the dialog names a key and no destination. */
  target?: string
}): Promise<PromptOutcome> {
  return new Promise((resolve) => {
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    // Auto-resolve an abandoned prompt (user walked away, never answered or hit Cancel) instead
    // of leaking the map entry and the askpass curl's HTTP request forever. Same bound as
    // PROMPT_WAIT_MS, so the connect() wait loop, this timeout, and the askpass script's own
    // curl --max-time all give up around the same point. The dismiss event closes the
    // renderer's dialog too, so a late answer cannot land in a request that no longer exists.
    const timer = setTimeout(() => {
      pendingPassphrasePrompts.delete(requestId)
      pushToRenderer(IPC.sshPassphraseDismiss, { requestId })
      resolve(undefined) // expired, not declined
    }, PROMPT_WAIT_MS)
    pendingPassphrasePrompts.set(requestId, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    const payload: SshPassphraseRequest = {
      requestId,
      identityFile: req.identityFile,
      retry: req.retry,
      target: req.target
    }
    if (!pushToRenderer(IPC.sshPassphraseRequest, payload)) {
      // No UI could receive it, so no answer is ever coming. Fail now rather than hold ssh (and
      // the connect) for the full expiry window.
      clearTimeout(timer)
      pendingPassphrasePrompts.delete(requestId)
      resolve(undefined)
    }
  })
}

/** The main-side half of the sshPassphraseSubmit IPC: resolve the pending prompt for
 *  `requestId` with the user's answer (null = declined). A stale/unknown requestId (already
 *  expired, double submit) is a silent no-op. Exported so the (requestId, value) contract is
 *  unit-testable; initSshProject's ipcMain.handle is a one-line delegate to this. */
export function resolvePassphrasePrompt(requestId: string, value: string | null): void {
  pendingPassphrasePrompts.get(requestId)?.(value)
  pendingPassphrasePrompts.delete(requestId)
}

/** One concurrency budget per ControlMaster, shared by every ssh exec child this process runs
 *  (the manager's own commands and every `sshRun` caller — transcript reads, remote git, the
 *  board-log poll, the session-memory sweep). Module-level so a manager rebuilt in a test does
 *  not hand a host two budgets. */
const sshChildGate = new SshChildGate()

/** In-process listeners for every project status event (beside the renderer push). Used by the
 *  dev-port forward registry to forget a disconnected project's forwards. */
const sshStatusListeners = new Set<(e: SshProjectStatusEvent) => void>()
export function onSshProjectStatus(listener: (e: SshProjectStatusEvent) => void): () => void {
  sshStatusListeners.add(listener)
  return () => sshStatusListeners.delete(listener)
}

export function initSshProject(
  onConnected?: (projectId: string) => void,
  askpassScriptPath?: string,
  /** Passed straight through to the manager's `onTunnelVerified` (see Runners). It lives on the
   *  caller because the resync it drives needs main's agent-status funnel and transcript readers,
   *  none of which this module knows about. */
  onTunnelVerified?: (projectId: string, controlPath: string, conn: SshConnection) => void,
  /** Resolves the standalone relay bundle (`out/main/codex-relay.js`, ws inlined) to upload to a
   *  Linux host. Injected by the caller (main/index.ts) so this module reads no build artifact
   *  itself. Undefined ⇒ no managed Codex runtime is installed, and every non-Codex path is
   *  unchanged (Server Edition passes nothing today — see the PR's I2 decision). */
  codexRelaySource?: () => Promise<string>,
  /** Current `settings.tmuxLeadPaneWidth` for the remote tmux conf (issue #119). Injected by
   *  main/index.ts because the settings store lives there; absent ⇒ 0 ⇒ pre-feature conf. */
  leadPaneWidth?: () => number,
  /** The managed Claude accounts pinned to a host (see Runners.claudeAccountIdsForHost). Injected
   *  for the same reason: the settings store lives in main/index.ts. */
  claudeAccountIdsForHost?: (hostKey: string) => string[],
  /** Agent-integration consent per host (see Runners.integrationsForHost / integrationReceipts). */
  integrations?: Pick<Runners, 'integrationsForHost' | 'integrationReceipts'>
): SshProjectManager {
  const ssh = sshBin()
  const scp = scpBin()
  // No window reference is threaded through here on purpose: every renderer push resolves the
  // live window AT SEND TIME (getMainWindow/sendToMain), because a captured BrowserWindow goes
  // stale across a macOS close/reopen cycle (see main-window.ts).
  ipcMain.handle(IPC.sshPassphraseSubmit, (_e, requestId: string, value: string | null) =>
    resolvePassphrasePrompt(requestId, value)
  )
  // WINDOWS (and NODETERM_NATIVE_SSH=1): OpenSSH cannot multiplex there, so every runner below is
  // served by the in-process transport instead (core/remote-ssh/native/). The manager does not
  // know: it still builds OpenSSH argv and reads OpenSSH-shaped answers. Decided ONCE here, at
  // boot, so a single app run never mixes the two transports for one ControlPath.
  const native = useNativeSsh()
  if (native) {
    setNativePassphrasePrompt(async (identityFile, req) =>
      (await promptForPassphrase({ identityFile, retry: req.retry, target: req.target })) ?? null
    )
  }
  const mgr = new SshProjectManager({
    userDataDir: app.getPath('userData'),
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
    onTunnelVerified,
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
    run: (args, stdin, timeoutMs) =>
      sshChildGate.run(args, () =>
        native
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
      ),
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
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    codexRelaySource,
    leadPaneWidth,
    claudeAccountIdsForHost,
    ...integrations,
    // Per-node identity for REMOTE nodes. Both come from the same module the local materialiser
    // uses, so one canvas cannot be judged by two different rules depending on where it runs.
    nodeIdsForProject: (projectId) => nodeIdsForCanvas(projectId),
    nodeTokenMinter: () => remoteNodeTokenMinter(),
    onStatus: (e) => {
      for (const listener of [...sshStatusListeners]) {
        try {
          listener(e)
        } catch {
          // an in-process listener must never break the status push to the UI
        }
      }
      // sendToMain resolves the window AT SEND TIME (see main-window.ts): the `win` captured here
      // is destroyed and recreated by a macOS close/reopen, and sending to the stale reference is
      // silently dropped. The try/catch is the other half: webContents.send THROWS when the render
      // frame is disposed even though isDestroyed() is false (renderer crash, reload, quit), and a
      // status push must never be load-bearing. It used to abort connect() mid-flight, which left
      // a dead entry in the map, discarded the real ssh error, and on the disconnectAll path
      // orphaned every remaining master.
      try {
        sendToMain(IPC.sshProjectStatus, e)
      } catch {
        // a UI that cannot hear us changes nothing about the connection itself
      }
    }
  })
  // The spawn-path leg of the remote materialiser: `pty-manager` (core) reaches the ControlMaster
  // through this registration, because the runner that owns it lives here, in main.
  setRemoteNodeTokenWriter((controlPath, nodeIds) => {
    void mgr.writeNodeTokenForNode(controlPath, nodeIds)
  })
  // Same seam, same shape: the pty spawn path stages a remote session's env file (gateway/custom
  // values, argv-free) through the manager that owns the ssh runner. See core/remote-ssh/session-env.ts.
  setRemoteSessionEnvWriter((controlPath, remotePath, content) => {
    void mgr.writeSessionEnvFile(controlPath, remotePath, content)
  })
  // Registered after `mgr` exists so the dialog can name the server: the askpass request carries
  // the asking master's pid, and only the manager can map it back to a connection.
  askpassServer.setPromptHandler((req) =>
    // A silent pre-warm never prompts: declining is what keeps a background dial from putting a
    // passphrase modal in front of a user who opened nothing. `null` is the same answer a decline
    // gives, so ssh abandons that key and the pre-warm's master simply fails, quietly.
    mgr.isQuietMasterPid(req.caller)
      ? Promise.resolve(null)
      : promptForPassphrase({ ...req, target: mgr.targetForMasterPid(req.caller) })
  )
  mgr.startWatchdog()
  ipcMain.handle(IPC.sshConnectProject, async (_e, projectId: string, conn: SshConnection, remoteCwd?: string) => {
    const res = await mgr.connect(projectId, conn, remoteCwd)
    // Connection is up (master in the map) → reconcile the remote project file with our cache.
    // Only fires on a successful connect; a throw above propagates without calling back.
    onConnected?.(projectId)
    return res
  })
  // `final`: the only USER-facing disconnect there is (a deleted project, or the connect dialog
  // dropping its browse master). Internal teardowns never reach here, which is what makes "no
  // connections left" a trustworthy signal to forget the key.
  ipcMain.handle(IPC.sshDisconnectProject, (_e, projectId: string) =>
    mgr.disconnect(projectId, { final: true })
  )
  ipcMain.handle(
    IPC.sshKillSessions,
    (_e, projectId: string, nodeIds: string[], opts?: { everySocket?: boolean }) =>
      mgr.killSessions(projectId, nodeIds, opts)
  )
  ipcMain.handle(IPC.sshListDir, (_e, projectId: string, dir: string) => mgr.listDir(projectId, dir))
  ipcMain.handle(IPC.sshMkdir, (_e, projectId: string, dir: string) => mgr.makeDir(projectId, dir))
  ipcMain.handle(IPC.sshUploadFile, (_e, projectId: string, localPath: string, fileName: string) =>
    mgr.uploadFile(projectId, localPath, fileName)
  )
  // The DESTINATION is resolved here, in main: the OS Downloads folder unless the renderer passed
  // a directory the user picked in the native folder dialog. The renderer never gets to name an
  // arbitrary local write target for a remote payload.
  ipcMain.handle(IPC.sshDownloadFile, (_e, projectId: string, remotePath: string, destDir?: string) =>
    mgr.downloadFile(projectId, remotePath, destDir || app.getPath('downloads'))
  )
  // A VideoNode in an SSH project plays a HOST file: pull it into the local media cache over the
  // ControlMaster, allowlist the cached copy, and hand back its nt-media:// URL.
  ipcMain.handle(IPC.sshMediaAllow, async (_e, projectId: string, remotePath: string) => {
    const r = await mgr.cacheMediaFile(
      projectId,
      remotePath,
      path.join(app.getPath('userData'), 'remote-media-cache')
    )
    return r.ok ? { ok: true, url: allowMediaPath(r.localPath) } : r
  })
  return mgr
}
