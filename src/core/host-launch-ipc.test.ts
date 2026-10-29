import { describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { registerHostLaunchIpc } from './host-launch-ipc'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

describe('host launch recovery entrance', () => {
  it('requires a classified owner and a valid node before invoking the scheduler', async () => {
    const platform = fakePlatform({ isOwnerClient: (id) => id === 1 })
    const run = vi.fn(async () => ({ ok: true, started: true }))
    registerHostLaunchIpc(platform, run)
    const call = platform.handlers[IPC.controlRunLaunch]
    expect(await call(2, 'node', 'task')).toMatchObject({ ok: false })
    expect(await call(1, '../node', 'task')).toMatchObject({ ok: false })
    expect(await call(1, 'node', '')).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
    expect(await call(1, 'node', 'task')).toMatchObject({ started: true })
    expect(run).toHaveBeenCalledWith('node', 'task')
    expect(isHostOnlyChannel(IPC.controlRunLaunch)).toBe(true)
  })

  it('reports an uncertain exception without retrying the side effect', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true })
    const run = vi.fn(async () => { throw new Error('connection ended after submission') })
    registerHostLaunchIpc(platform, run)
    expect(await platform.handlers[IPC.controlRunLaunch](1, 'node', 'task')).toMatchObject({ ok: false, started: false, error: expect.stringContaining('uncertain') })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
