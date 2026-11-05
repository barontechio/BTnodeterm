import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import { controlPathFor } from '../../core/remote-ssh/control-master'
import type { SshProjectStatusEvent } from '@shared/types'
import type { SshConnection } from '@shared/ssh'

const conn: SshConnection = { host: 'h', user: 'u' }

/** `makeMgr` with the full status EVENTS retained (the shared harness keeps only `status`), and a
 *  `run` that lets the remote hook setup verify so a connect reaches `connected`. */
function makeMgr(over: Partial<ConstructorParameters<typeof SshProjectManager>[0]> = {}) {
  const events: SshProjectStatusEvent[] = []
  const setupCalls: string[] = []
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: () => 4242 }))
  const run = vi.fn(async (args: string[]) => {
    const j = args.join(' ')
    // Anything that is NOT the `-O check` is part of the post-master setup chain.
    if (!args.includes('-O')) setupCalls.push(j)
    if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
    if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
    return { code: 0, stdout: '' }
  })
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    runScp: vi.fn(async () => ({ code: 0 })),
    getHook: () => ({ port: 1, token: 't', version: '1' }),
    onStatus: (e) => events.push({ ...e }),
    ...over
  } as ConstructorParameters<typeof SshProjectManager>[0])
  return { mgr, events, spawnMaster, run, setupCalls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('early ControlMaster publication (PR 1 part A)', () => {
  it.each(['ssh-home', 'ssh-O-home'])('publishes the control path BEFORE setup with home %s', async (home) => {
    // A legal home (and thus ControlPath) containing "-O" is not an ssh mux operation.
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(os.homedir(), home))
    const seenSetupCallsAtPublish: number[] = []
    let setupCalls = 0
    const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: () => 1 }))
    const events: SshProjectStatusEvent[] = []
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster,
      run: vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (!args.includes('-O')) setupCalls++
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
        return { code: 0, stdout: '' }
      }),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => {
        events.push({ ...e })
        if (e.masterControlPath) seenSetupCallsAtPublish.push(setupCalls)
      }
    } as ConstructorParameters<typeof SshProjectManager>[0])

    await mgr.connect('p1', conn)

    const early = events.find((e) => e.masterControlPath)
    expect(early).toBeDefined()
    expect(early!.status).toBe('connecting') // additive: `connected` keeps its meaning
    expect(early!.masterControlPath).toBe(controlPathFor('p1'))
    // Nothing of the connect's remote setup chain had run yet — that is the whole point.
    expect(seenSetupCallsAtPublish).toEqual([0])
    // And the setup chain DID run afterwards, i.e. the early signal did not replace it.
    expect(setupCalls).toBeGreaterThan(0)
    expect(events.at(-1)?.status).toBe('connected')
  })

  it('does NOT publish early for an ADOPTED ORPHAN — that master can still be torn down', async () => {
    // A live leftover socket: connect adopts it instead of spawning. The tunnel-verification
    // failure path may `-O exit` and rebuild it, which would kill a terminal that attached early.
    vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
    const { mgr, events, spawnMaster } = makeMgr()

    await mgr.connect('p1', conn)

    expect(spawnMaster).not.toHaveBeenCalled() // adopted, not respawned
    expect(events.some((e) => e.masterControlPath)).toBe(false)
    expect(events.at(-1)?.status).toBe('connected') // the connect itself is unaffected
  })

  it('a REBUILT master (orphan whose tunnel failed) does publish early on its next pass', async () => {
    // The orphan is adopted, its hook tunnel fails to verify (curl never answers 204), so connect
    // drops it and spawns a fresh master — which is no longer an orphan and may publish.
    vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
    vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
    let respawned = false
    const spawnMaster = vi.fn(() => {
      respawned = true
      return { kill: vi.fn(), on: vi.fn(), pid: () => 7 }
    })
    const events: SshProjectStatusEvent[] = []
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster,
      run: vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        // The tunnel verifies only once a FRESH master exists.
        if (j.includes('%{http_code}')) return { code: 0, stdout: respawned ? '204' : '000' }
        return { code: 0, stdout: '' }
      }),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push({ ...e })
    } as ConstructorParameters<typeof SshProjectManager>[0])

    await mgr.connect('p1', conn)

    expect(spawnMaster).toHaveBeenCalledTimes(1)
    const early = events.filter((e) => e.masterControlPath)
    expect(early).toHaveLength(1)
    expect(early[0].masterControlPath).toBe(controlPathFor('p1'))
  })
})

describe('background pre-warm (PR 1 part B)', () => {
  it('connects silently — a pre-warm raises NO status event, and therefore no banner', async () => {
    const { mgr, events, spawnMaster } = makeMgr()

    await mgr.prewarm('p1', conn, '/srv')

    expect(spawnMaster).toHaveBeenCalledTimes(1)
    expect(mgr.refForProject('p1')).toBeDefined() // the master is up and reusable
    expect(events).toEqual([])
  })

  it('a FAILED pre-warm raises no error status either', async () => {
    const events: SshProjectStatusEvent[] = []
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      // Master exits at once and the socket never answers → connect fails.
      spawnMaster: vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        exited: () => true,
        stderr: () => 'Permission denied (publickey).',
        pid: () => 9
      })),
      run: vi.fn(async () => ({ code: 255, stdout: '' })),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push({ ...e })
    } as ConstructorParameters<typeof SshProjectManager>[0])

    // Never rejects: a pre-warm is not a user action.
    await expect(mgr.prewarm('p1', conn)).resolves.toBeUndefined()
    expect(events).toEqual([])
  })

  it('the same connect FAILING loudly still reports its error (the mark is per attempt)', async () => {
    const events: SshProjectStatusEvent[] = []
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        exited: () => true,
        stderr: () => 'Permission denied (publickey).',
        pid: () => 9
      })),
      run: vi.fn(async () => ({ code: 255, stdout: '' })),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push({ ...e })
    } as ConstructorParameters<typeof SshProjectManager>[0])

    await mgr.prewarm('p1', conn)
    events.length = 0
    await expect(mgr.connect('p1', conn)).rejects.toThrow(/SSH connection/)
    expect(events.map((e) => e.status)).toContain('error')
  })

  it('a LOUD connect that coalesces onto a pre-warm in flight lifts the silence', async () => {
    // The pre-warm's attempt is still waiting on `-O check` when the user opens the project.
    let answer = false
    const events: SshProjectStatusEvent[] = []
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: () => 3 })),
      run: vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (args.includes('-O') && !answer) return { code: 1, stdout: '' }
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
        return { code: 0, stdout: '' }
      }),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push({ ...e })
    } as ConstructorParameters<typeof SshProjectManager>[0])

    const warm = mgr.prewarm('p1', conn)
    await Promise.resolve()
    const loud = mgr.connect('p1', conn) // joins the SAME attempt
    answer = true
    await Promise.all([warm, loud])

    // From the moment the user asked, this attempt speaks again — including the early signal.
    expect(events.some((e) => e.masterControlPath === controlPathFor('p1'))).toBe(true)
    expect(events.at(-1)?.status).toBe('connected')
  })

  it('never starts a second attempt beside a live connection or one in flight', async () => {
    const { mgr, spawnMaster } = makeMgr()
    await mgr.connect('p1', conn)
    await mgr.prewarm('p1', conn)
    expect(spawnMaster).toHaveBeenCalledTimes(1)
    expect(mgr.isBusy('p1')).toBe(true)
    expect(mgr.isBusy('p2')).toBe(false)
  })

  it('declines the passphrase prompt while an attempt is a silent pre-warm', async () => {
    let answer = false
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: () => 31337 })),
      run: vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (args.includes('-O') && !answer) return { code: 1, stdout: '' }
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
        return { code: 0, stdout: '' }
      }),
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: () => {}
    } as ConstructorParameters<typeof SshProjectManager>[0])

    const warm = mgr.prewarm('p1', conn)
    // Wait until the master is REGISTERED (the connect does a few fs round trips first) but before
    // the socket answers — the window a real passphrase prompt would fire in.
    for (let i = 0; i < 50 && !mgr.isQuietMasterPid('31337'); i++) await new Promise((r) => setTimeout(r, 5))
    // The askpass helper's reported $PPID maps back to this project, which is a silent pre-warm.
    expect(mgr.isQuietMasterPid('31337')).toBe(true)
    expect(mgr.isQuietMasterPid('999')).toBe(false)
    answer = true
    await warm
    // Once the attempt settles the mark is gone: a later prompt for this project is the user's.
    expect(mgr.isQuietMasterPid('31337')).toBe(false)
  })
})
