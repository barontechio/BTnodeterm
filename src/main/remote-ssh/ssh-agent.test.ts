// The app-private ssh-agent (ssh-agent.ts). No real `ssh-agent` is spawned: the spawner is
// injected and the "socket" is a file the fake creates, which is exactly what start() waits on.
// What matters here is not the process management but the two properties the feature rests on:
// env() never falls back to the ambient agent (a fallback would silently load the key into the
// user's login agent forever), and start() never hands a caller an agent that is not listening yet.
import { promises as fs, existsSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSshAgent, agentSockPath } from './ssh-agent'

let tmp: string | undefined

async function sock(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-agent-test-'))
  return path.join(tmp, 'agent.sock')
}

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  tmp = undefined
})

/** A stand-in for the spawned agent: binds (creates) the socket file, immediately by default or
 *  after `bindDelayMs` to model the real exec→bind gap. Immediate binding is synchronous on
 *  purpose, so the fake needs no timer and the fake-timer test below can still start an agent.
 *  Handlers registered via on() are REAL (kept and firable): the production 'exit'/'error'
 *  handlers are what let a dead agent be restarted, and a fake that discards them would leave
 *  that whole path unexercised - deleting those handlers kept an earlier version of this suite
 *  green. */
function fakeAgent(sockPath: string, bindDelayMs = 0) {
  const calls: string[][] = []
  const kills: number[] = []
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>()
  const emit = (ev: string): void => {
    for (const cb of handlers.get(ev) ?? []) cb()
  }
  const spawnAgent = vi.fn((args: string[]) => {
    calls.push(args)
    let timer: ReturnType<typeof setTimeout> | undefined
    if (bindDelayMs === 0) writeFileSync(sockPath, '')
    else timer = setTimeout(() => writeFileSync(sockPath, ''), bindDelayMs)
    return {
      pid: 1234,
      kill: () => {
        if (timer) clearTimeout(timer)
        kills.push(1)
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), cb])
      }
    }
  })
  return { spawnAgent, calls, kills, emit }
}

describe('agentSockPath', () => {
  it('is short, under the home dir, and differs per app instance', () => {
    const a = agentSockPath('/Users/u/Library/Application Support/node-terminal')
    const b = agentSockPath('/Users/u/dev/nodeterm-testdata')
    expect(a).not.toBe(b) // NT_MULTI: a second instance must not unlink the first one's socket
    expect(a.startsWith(path.join(os.homedir(), '.nodeterm'))).toBe(true)
    // A unix socket path is capped near 104 bytes; userData paths blow that, which is the whole
    // reason this lives in ~/.nodeterm rather than next to the app's data.
    expect(a.length).toBeLessThan(104)
  })
})

describe('AppSshAgent', () => {
  it('spawns a foreground agent with a key lifetime, on its own socket', async () => {
    const p = await sock()
    const { spawnAgent, calls } = fakeAgent(p)
    const agent = new AppSshAgent(spawnAgent, p)
    await agent.start()
    // -D keeps it a direct child (the default double-forks and would survive a kill); -t bounds an
    // agent orphaned by a crash, which is the only path where stop() never runs.
    expect(calls[0]).toEqual(['-D', '-t', '12h', '-a', p])
    expect(agent.isRunning()).toBe(true)
    agent.stop()
  })

  it('starts once for concurrent callers, and nobody is released before the socket is listening', async () => {
    const p = await sock()
    const { spawnAgent } = fakeAgent(p, 40) // binds late, like a real agent's exec
    const agent = new AppSshAgent(spawnAgent, p)
    // Two projects connecting at once: without a memoized start, the second returns immediately on
    // `if (this.child)` while the socket is still binding, ssh finds no agent, and its unlocked key
    // goes nowhere — every later connect in that run prompts again.
    const bound: boolean[] = []
    await Promise.all([
      agent.start().then(() => bound.push(existsSync(p))),
      agent.start().then(() => bound.push(existsSync(p)))
    ])
    expect(spawnAgent).toHaveBeenCalledTimes(1)
    expect(bound).toEqual([true, true])
    agent.stop()
  })

  it('points at its OWN socket even when the spawn fails (fail closed, never at the login agent)', async () => {
    const p = await sock()
    // spawn() reports a missing binary as an ASYNC 'error' event on the child, never a sync throw
    // - the earlier sync-throwing fake tested a failure mode child_process cannot produce.
    const handlers = new Map<string, (...a: unknown[]) => void>()
    const agent = new AppSshAgent((args) => {
      void args
      const child = {
        kill: vi.fn(),
        on: (ev: string, cb: (...a: unknown[]) => void) => handlers.set(ev, cb)
      }
      setImmediate(() => handlers.get('error')?.(new Error('spawn ssh-agent ENOENT')))
      return child
    }, p)
    await expect(agent.start()).resolves.toBeUndefined() // never fatal, and no unhandled 'error'
    expect(agent.isRunning()).toBe(false)
    // The load-bearing assertion of this whole file: returning {} here would let ssh inherit the
    // user's SSH_AUTH_SOCK, and AddKeysToAgent=yes would load the key into their login agent
    // permanently — the exact leak this feature exists to close, reached by a silent path.
    expect(agent.env()).toEqual({ SSH_AUTH_SOCK: p })
  })

  it('publishes the core-spawner env var even when the start throws synchronously (fail closed there too)', async () => {
    const p = await sock()
    const prev = process.env.NODETERM_APP_AGENT_SOCK
    delete process.env.NODETERM_APP_AGENT_SOCK
    const agent = new AppSshAgent(() => {
      throw new Error('EACCES') // e.g. mkdir/rm on ~/.nodeterm denied, or spawn itself throwing
    }, p)
    await expect(agent.start()).resolves.toBeUndefined()
    // env() is unconditional, but the CORE spawners (remote PTYs, remote git) read this env var
    // instead — left unset on the sync-throw path they silently fell back to the ambient agent,
    // the one asymmetry in an otherwise fail-closed design.
    expect(process.env.NODETERM_APP_AGENT_SOCK).toBe(p)
    agent.stop() // also unpublishes
    expect(process.env.NODETERM_APP_AGENT_SOCK).toBeUndefined()
    if (prev !== undefined) process.env.NODETERM_APP_AGENT_SOCK = prev
  })

  it('an agent that DIES mid-run is restarted by the next start(), not joined as a memoized ghost', async () => {
    const p = await sock()
    const { spawnAgent, emit } = fakeAgent(p)
    const agent = new AppSshAgent(spawnAgent, p)
    await agent.start()
    expect(agent.isRunning()).toBe(true)
    emit('exit') // the agent process died (crash, external kill)
    expect(agent.isRunning()).toBe(false)
    // Without the exit handler clearing the memoized `starting`, this start() would return the
    // stale resolved promise forever: no agent for the rest of the run, a prompt on every connect.
    await agent.start()
    expect(spawnAgent).toHaveBeenCalledTimes(2)
    expect(agent.isRunning()).toBe(true)
    agent.stop()
  })

  it('publishes the socket for core spawners while up, and unpublishes it on stop', async () => {
    // Remote PTYs (pty-manager) and remote git (remote-git) shell out to ssh from src/core, which
    // cannot import this main-process module - they find the agent through this env var. Losing
    // the publish reopens the pane-prompt / login-agent leak; losing the DELETE leaves core
    // pointing at a socket that no longer exists after quit-in-place (macOS window close).
    const p = await sock()
    const { spawnAgent } = fakeAgent(p)
    const agent = new AppSshAgent(spawnAgent, p)
    delete process.env.NODETERM_APP_AGENT_SOCK
    try {
      await agent.start()
      expect(process.env.NODETERM_APP_AGENT_SOCK).toBe(p)
      agent.stop()
      expect(process.env.NODETERM_APP_AGENT_SOCK).toBeUndefined()
    } finally {
      delete process.env.NODETERM_APP_AGENT_SOCK
    }
  })

  it('an unused instance cannot remove another agent socket or environment publication', async () => {
    const p = await sock(); const previous = process.env.NODETERM_APP_AGENT_SOCK
    writeFileSync(p, 'owned elsewhere')
    process.env.NODETERM_APP_AGENT_SOCK = p
    try {
      new AppSshAgent(vi.fn(), p).stop()
      expect(existsSync(p)).toBe(true)
      expect(process.env.NODETERM_APP_AGENT_SOCK).toBe(p)
    } finally {
      if (previous === undefined) delete process.env.NODETERM_APP_AGENT_SOCK
      else process.env.NODETERM_APP_AGENT_SOCK = previous
    }
  })

  it('stop() kills the agent, removes the socket, and a later start brings a fresh one up', async () => {
    const p = await sock()
    const { spawnAgent, kills } = fakeAgent(p)
    const agent = new AppSshAgent(spawnAgent, p)
    await agent.start()
    agent.stop()
    expect(kills).toHaveLength(1)
    expect(existsSync(p)).toBe(false) // no socket left for the next run to trip over
    expect(agent.isRunning()).toBe(false)
    await agent.start()
    expect(spawnAgent).toHaveBeenCalledTimes(2)
    agent.stop()
  })

  it('scheduleStop forgets the key after its grace, and a connect inside the window cancels it', async () => {
    const p = await sock()
    const { spawnAgent, kills } = fakeAgent(p)
    const agent = new AppSshAgent(spawnAgent, p)
    await agent.start() // real timers: the fake binds synchronously, so this settles at once
    vi.useFakeTimers()
    try {

      // The browse-master case: the connect dialog disconnects its throwaway master a moment
      // before the real project connects. Forgetting in that gap would charge a second prompt.
      agent.scheduleStop(10_000)
      vi.advanceTimersByTime(5_000)
      void agent.start()
      vi.advanceTimersByTime(10_000)
      expect(agent.isRunning()).toBe(true)

      // Nothing came back: the key is forgotten when the grace expires. `kills` is the assertion
      // that matters - isRunning() alone stayed green when stop() forgot to kill() the process.
      agent.scheduleStop(10_000)
      vi.advanceTimersByTime(10_001)
      expect(agent.isRunning()).toBe(false)
      expect(kills).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
