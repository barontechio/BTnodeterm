import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { OwnerLifetimes } from './owner-lifetimes'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * The core-side io of the headless launcher (#925): an output tap per node, and a write/release
 * pair that acts AS the synthetic client 0 `createHeadless` subscribes. Harness copied from
 * pty-coattach.test.ts: no `init()`, so there is no tmux and every session is a plain shell (its
 * node id lives on `nodeId`, not `persistKey`).
 */

/** One fake pty per spawn, recorded so a test can push output and see what was written. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  paused: boolean
  killed: boolean
}
const spawned: FakePty[] = []
let spawnHook: (() => void) | undefined

// Pin the persistence backend: `sessionHostSupported()` only asks whether
// out/session-host/host.cjs exists on disk, so whether this suite exercises the mocked
// `node-pty` spawn below or a real session-host shim depended on whether anyone had run
// `npm run build` (or `npm run host:build`). See src/core/__fixtures__/no-session-host.ts.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], _opts: unknown) => {
    spawnHook?.()
    const p: FakePty = { writes: [], resizes: [], paused: false, killed: false }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => p.writes.push(d),
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {
        p.paused = true
      },
      resume: () => {
        p.paused = false
      },
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

/**
 * A machine with pty devices to spare, always — otherwise the real `/dev` probe makes this suite
 * depend on how many terminals the developer running it has open (see pty-coattach.test.ts).
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('PtyManager headless taps (#925)', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    spawnHook = undefined
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }

  it('holds worktree members and new backend starts while unrelated live input remains available', async () => {
    const m = await manager()
    await m.createHeadless({ persistKey: 'member', cols: 80, rows: 24 })
    await m.createHeadless({ persistKey: 'outside', cols: 80, rows: 24 })
    let release!: () => void
    const pending = m.runWorktreeAction(['group', 'member'], { current: () => true },
      () => new Promise<void>((resolve) => { release = resolve }))
    await expect(m.createHeadless({ persistKey: 'new-node', cols: 80, rows: 24 })).rejects.toThrow('busy')
    await expect(m.createHeadless({ cols: 80, rows: 24 })).rejects.toThrow('busy')
    expect(m.writeHeadless('member', 'held')).toBe(false)
    expect(m.writeHeadless('outside', 'still available')).toBe(true)
    expect(spawned).toHaveLength(2)
    release(); await pending
    await m.createHeadless({ persistKey: 'new-node', cols: 80, rows: 24 })
    expect(spawned).toHaveLength(3)
    m.killAll()
  })

  it('refuses worktree dispatch while a backend start is unresolved, then releases after failure', async () => {
    const m = await manager()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const backend = m as unknown as { spawnNewInternal(clientId: number, options: PtyCreateOptions): Promise<PtyCreateResult> }
    const spawn = vi.spyOn(backend, 'spawnNewInternal').mockImplementation(async () => {
      await held; throw new Error('fixture spawn failed')
    })
    const creating = m.createHeadless({ persistKey: 'new-node', cols: 80, rows: 24 }); void creating.catch(() => {})
    const work = vi.fn()
    await expect(m.runWorktreeAction(['group'], { current: () => true }, work)).rejects.toThrow('busy')
    expect(work).not.toHaveBeenCalled()
    release(); await expect(creating).rejects.toThrow('fixture spawn failed'); spawn.mockRestore()
    await expect(m.runWorktreeAction(['group'], { current: () => true }, () => 'free')).resolves.toBe('free')
    m.killAll()
  })

  it('retains the creation barrier after owner departure until external work settles', async () => {
    const m = await manager(); const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
    let release!: () => void
    const pending = m.runWorktreeAction(['group'], { current: () => true, owner },
      () => new Promise<void>((resolve) => { release = resolve }))
    owners.forget(1)
    await expect(m.createHeadless({ persistKey: 'new-node', cols: 80, rows: 24 })).rejects.toThrow('busy')
    await expect(m.runWorktreeAction(['other'], { current: () => true }, () => {})).rejects.toThrow('busy')
    release(); await expect(pending).rejects.toThrow('expired')
    await m.createHeadless({ persistKey: 'new-node', cols: 80, rows: 24 })
    owners.dispose(); m.killAll()
  })

  it('releases the start barrier when a member is already busy or the transaction fails', async () => {
    const m = await manager(); let release!: () => void
    const occupied = m.runNodeAction('member', 'branch', { current: () => true }, () => new Promise<void>((resolve) => { release = resolve }))
    await expect(m.runWorktreeAction(['member'], { current: () => true }, () => {})).rejects.toThrow('busy')
    await m.createHeadless({ persistKey: 'outside', cols: 80, rows: 24 })
    release(); await occupied
    await expect(m.runWorktreeAction(['member'], { current: () => true }, () => { throw new Error('Git refused') })).rejects.toThrow('Git refused')
    await m.createHeadless({ persistKey: 'another', cols: 80, rows: 24 })
    m.killAll()
  })

  it('keeps a created backend alive without authorizing its expired application continuation', async () => {
    const m = await manager(); let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    let backend!: Promise<boolean>; let application!: Promise<boolean>
    spawnHook = () => { backend = hold.then(() => m.writeHeadless('n1', 'backend')) }
    await m.runNodeAction('n1', 'branch', { current: () => true }, async () => {
      application = hold.then(() => m.writeHeadless('n1', 'expired'))
      await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    })
    release(); expect(await backend).toBe(true); expect(await application).toBe(false)
    expect(spawned[0].writes).toEqual(['backend']); await m.killAll()
  })

  it('runs backend data/flush callbacks outside an expired action that delivered the event', async () => {
    const m = await manager(); let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve }); let event!: Promise<void>
    await m.runNodeAction('n1', 'branch', { current: () => true }, async () => {
      await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
      m.onOutput('n1', () => { m.writeHeadless('n1', 'driver reply') })
      event = hold.then(() => { spawned[0].onDataCb?.('output') })
    })
    release(); await event; await vi.advanceTimersByTimeAsync(50)
    expect(spawned[0].writes).toEqual(['driver reply']); await m.killAll()
  })

  it('onOutput receives flushed output for the node, and unsubscribes cleanly', async () => {
    const m = await manager()
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(r.sessionId).toBeTruthy()
    const seen: string[] = []
    const off = m.onOutput('n1', (c) => seen.push(c))
    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(50) // past FLUSH_MS
    expect(seen.join('')).toBe('hello')
    off()
    spawned[0].onDataCb?.('again')
    vi.advanceTimersByTime(50)
    expect(seen.join('')).toBe('hello')
  })

  it('writeHeadless writes only when client 0 holds a live session for that node', async () => {
    const m = await manager()
    expect(m.writeHeadless('n1', 'x')).toBe(false) // nothing spawned yet
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(m.writeHeadless('n1', 'abc')).toBe(true)
    expect(spawned[0].writes).toContain('abc')
    expect(m.writeHeadless('other', 'abc')).toBe(false)
  })

  it('writeHeadless refuses a live session that only a real client attached', async () => {
    const m = await manager()
    await fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, persistKey: 'n1' })
    expect(spawned).toHaveLength(1)
    expect(m.writeHeadless('n1', 'abc')).toBe(false) // client 0 never subscribed
    expect(spawned[0].writes).toEqual([])
    m.releaseHeadless('n1') // not client 0's to drop: the viewer's pty stays attached
    expect(spawned[0].killed).toBe(false)
  })

  it('releaseHeadless drops client 0, after which a headless write is refused', async () => {
    const m = await manager()
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    m.releaseHeadless('n1')
    // Client 0 was the only subscriber, so the pty client is released (a plain shell dies with it,
    // which is why the launcher gates on persistentSpawnAvailable) and the session is forgotten.
    expect(spawned[0].killed).toBe(true)
    expect(m.writeHeadless('n1', 'abc')).toBe(false)
    expect(spawned[0].writes).not.toContain('abc')
    m.releaseHeadless('n1') // idempotent: no live session, no throw
  })

  it('a throwing output tap does not break delivery to the others', async () => {
    const m = await manager()
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    m.onOutput('n1', () => {
      throw new Error('boom')
    })
    m.onOutput('n1', (c) => seen.push(c))
    spawned[0].onDataCb?.('z')
    vi.advanceTimersByTime(50)
    expect(seen).toEqual(['z'])
    expect(warn).toHaveBeenCalledWith('[pty] output tap failed', 'boom')
    warn.mockRestore()
  })

  it('fences all competing entry points and addresses a throttled notice only to the typing client', async () => {
    const m = await manager()
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    await fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, persistKey: 'n1' })
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const identity = m.nodeExecutionIdentity('n1')
    const action = m.runNodeAction('n1', 'branch', { current: () => m.nodeExecutionIdentity('n1') === identity }, async () => {
      expect(m.writeHeadless('n1', 'owned')).toBe(true)
      await hold
    })
    m.write(1, r.sessionId, 'other-tab')
    m.write(1, r.sessionId, 'more')
    expect(m.writeHeadless('n1', 'other-launch')).toBe(false)
    await expect(m.backgroundWrite('n1', 'background')).resolves.toBe(false)
    await expect(m.controlInput(r.sessionId, { kind: 'keys', data: 'remote' })).resolves.toBe(false)
    await expect(m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })).rejects.toThrow('busy')
    await expect(m.recycleSession(null, 'n1')).rejects.toThrow('busy')
    await expect(m.destroySession(null, 'n1')).rejects.toThrow('busy')
    expect(spawned[0].killed).toBe(false)
    expect(spawned[0].writes).toEqual(['owned'])
    expect(fake.sent.filter((e) => e.channel === IPC.ptyInputBlocked)).toEqual([
      { to: 1, channel: IPC.ptyInputBlocked, args: [{ nodeId: 'n1' }] }
    ])
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n2' })
    expect(m.writeHeadless('n2', 'independent')).toBe(true)
    release(); await action
    m.write(1, r.sessionId, 'after')
    expect(spawned[0].writes).toEqual(['owned', 'after'])
    await m.killAll()
  })

  it('does not acquire over a queued write, and refuses expired continuations before they create a replacement', async () => {
    const m = await manager()
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    const write = m.backgroundWrite('n1', 'queued')
    await expect(m.runNodeAction('n1', 'account', { current: () => true }, () => {})).rejects.toThrow('busy')
    await write
    let late!: Promise<unknown>; let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    await m.runNodeAction('n1', 'write', { current: () => true }, () => {
      late = hold.then(() => m.createHeadless({ cols: 80, rows: 24, persistKey: 'n2' }))
    })
    void late.catch(() => {})
    release(); await expect(late).rejects.toThrow('expired')
    expect(spawned).toHaveLength(1)
    await m.killAll()
    await expect(m.createHeadless({ cols: 80, rows: 24, persistKey: 'n2' })).rejects.toThrow('stopped')
  })
})
