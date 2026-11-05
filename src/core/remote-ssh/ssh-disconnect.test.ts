import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'

const project = 'disconnect-fixture'
const endpoint = { host: 'fixture.invalid', user: 'fixture' }

async function fixture(masterAbsent?: () => Promise<boolean>) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let exitCode = 0
  let entered = false
  const kill = vi.fn()
  const spawnMaster = vi.fn(() => ({ kill, on: vi.fn() }))
  const onIdle = vi.fn()
  const manager = new SshProjectManager({
    userDataDir: '/fixture', spawnMaster, onIdle, masterAbsent,
    run: async (args) => {
      if (args.includes('-O') && args.includes('exit')) {
        entered = true
        await gate
        return { code: exitCode, stdout: '' }
      }
      return { code: 0, stdout: '' }
    },
    runScp: async () => ({ code: 0 }),
    getHook: () => ({ port: 0, token: '', version: '1' }), onStatus: vi.fn()
  })
  await manager.connect(project, endpoint)
  return { manager, spawnMaster, kill, onIdle, release,
    setExitCode: (code: number) => { exitCode = code },
    entered: () => vi.waitFor(() => expect(entered).toBe(true)) }
}

describe('SSH disconnect completion', () => {
  it('holds completion and a queued reconnect until the old exit settles', async () => {
    const f = await fixture()
    let closed = false
    const closing = f.manager.disconnect(project).then(() => { closed = true })
    const reconnect = f.manager.connect(project, endpoint)
    try {
      await f.entered()
      expect(closed).toBe(false)
      expect(f.spawnMaster).toHaveBeenCalledTimes(1)
    } finally { f.release() }
    await closing
    await reconnect
    expect(f.spawnMaster).toHaveBeenCalledTimes(2)
    f.manager.disconnectAll()
  })

  it('a second disconnect cancels the queued reconnect and preserves the final idle request', async () => {
    const f = await fixture()
    const closing = f.manager.disconnect(project)
    const reconnect = expect(f.manager.connect(project, endpoint)).rejects.toThrow('cancelled')
    await f.entered()
    const final = f.manager.disconnect(project, { final: true })
    f.release()
    await Promise.all([closing, final, reconnect])
    expect(f.spawnMaster).toHaveBeenCalledTimes(1)
    expect(f.onIdle).toHaveBeenCalledOnce()
  })

  it('a failed exit retains its identity and refuses queued work until an explicit successful retry', async () => {
    const f = await fixture()
    const original = f.manager.connectionKeyFor(project)
    f.setExitCode(255)
    const closing = f.manager.disconnect(project)
    const reconnect = expect(f.manager.connect(project, endpoint)).rejects.toThrow('unconfirmed')
    await f.entered()
    f.release()
    await Promise.all([closing, reconnect])
    expect(f.manager.connectionKeyFor(project)).toBe(original)
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.spawnMaster).toHaveBeenCalledTimes(1)
    await expect(f.manager.connect(project, endpoint)).rejects.toThrow('unconfirmed')
    f.setExitCode(0)
    await f.manager.disconnect(project)
    await f.manager.connect(project, endpoint)
    expect(f.manager.connectionKeyFor(project)).not.toBe(original)
    f.manager.disconnectAll()
  })

  it('an endpoint replacement cannot open until the original close settles', async () => {
    const f = await fixture()
    const original = f.manager.connectionKeyFor(project)
    const closing = f.manager.disconnect(project)
    const replacement = f.manager.connect(project, { ...endpoint, host: 'replacement.invalid' })
    await f.entered()
    expect(f.manager.connectionKeyFor(project)).toBe(original)
    expect(f.spawnMaster).toHaveBeenCalledTimes(1)
    f.release()
    await Promise.all([closing, replacement])
    expect(f.manager.refForProject(project)?.conn.host).toBe('replacement.invalid')
    expect(f.manager.connectionKeyFor(project)).not.toBe(original)
    expect(f.kill).toHaveBeenCalledOnce()
    f.manager.disconnectAll()
  })

  it('rechecks request authority before a queued reconnect can dispatch', async () => {
    const f = await fixture()
    const closing = f.manager.disconnect(project)
    let authorized = true
    const reconnect = expect(f.manager.connect(project, endpoint, undefined, { current: () => authorized }))
      .rejects.toThrow('cancelled')
    await f.entered()
    authorized = false
    f.release()
    await Promise.all([closing, reconnect])
    expect(f.spawnMaster).toHaveBeenCalledTimes(1)
  })

  it('releases an already-absent transport after a failed exit when absence is positively checked', async () => {
    const f = await fixture(async () => true)
    f.setExitCode(255)
    const closing = f.manager.disconnect(project)
    await f.entered()
    f.release()
    await closing
    expect(f.manager.refForProject(project)).toBeUndefined()
    await f.manager.connect(project, endpoint)
    expect(f.spawnMaster).toHaveBeenCalledTimes(2)
    f.manager.disconnectAll()
  })

  it('does not turn a failed presence probe into absence', async () => {
    const f = await fixture(async () => { throw new Error('probe failed') })
    const original = f.manager.connectionKeyFor(project)
    f.setExitCode(255)
    const closing = f.manager.disconnect(project)
    await f.entered()
    f.release()
    await closing
    expect(f.manager.connectionKeyFor(project)).toBe(original)
    await expect(f.manager.connect(project, endpoint)).rejects.toThrow('unconfirmed')
    f.manager.disconnectAll()
  })

  it('close cancels queued reconnects and old completion cannot publish or kill again', async () => {
    const f = await fixture()
    const closing = f.manager.disconnect(project)
    const reconnect = expect(f.manager.connect(project, endpoint)).rejects.toThrow('cancelled')
    await f.entered()
    f.manager.disconnectAll()
    expect(f.kill).toHaveBeenCalledOnce()
    f.release()
    await Promise.all([closing, reconnect])
    expect(f.kill).toHaveBeenCalledOnce()
    expect(f.manager.refForProject(project)).toBeUndefined()
  })
})
