import { describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { registerConversationBranchIpc } from './conversation-branch-ipc'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

describe('owner conversation branch RPC', () => {
  it('refuses guests, departed clients and invalid ids before invoking the service', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const run = vi.fn(async () => ({ ok: true })); const owners = registerConversationBranchIpc(platform, run)
    const call = platform.handlers[IPC.controlBranchClaude]
    expect(await call(2, 'node')).toMatchObject({ ok: false })
    expect(await call(1, '../node')).toMatchObject({ ok: false })
    for (const at of [{ x: NaN, y: 0 }, { x: 100_001, y: 0 }, { x: 0 }, '0,0']) {
      expect(await call(1, 'node', at)).toMatchObject({ ok: false, error: 'branch-invalid-position' })
    }
    platform.isOwnerClient = () => false
    expect(await call(1, 'node')).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled(); expect(isHostOnlyChannel(IPC.controlBranchClaude)).toBe(true)
    owners.dispose()
  })

  it('binds a call to the current document, even when reload reuses its client id', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const observed: Array<Parameters<Parameters<typeof registerConversationBranchIpc>[1]>[1]> = []
    const owners = registerConversationBranchIpc(platform, async (_id, owner) => { observed.push(owner); return { ok: true } })
    const call = platform.handlers[IPC.controlBranchClaude]
    await call(1, 'node'); owners.forget(1); await call(1, 'node')
    expect(observed[0].active()).toBe(false); expect(observed[1].active()).toBe(true)
    owners.dispose(); expect(observed[1].active()).toBe(false)
  })

  it('reports an uncertain effect after a lost response without invoking it twice', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const run = vi.fn(async () => { throw new Error('reply lost') })
    const owners = registerConversationBranchIpc(platform, run)
    expect(await platform.handlers[IPC.controlBranchClaude](1, 'node')).toMatchObject({ ok: false, error: expect.stringContaining('uncertain') })
    expect(run).toHaveBeenCalledOnce(); owners.dispose()
  })
})
