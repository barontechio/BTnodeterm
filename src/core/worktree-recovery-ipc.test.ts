import { describe, expect, it, vi } from 'vitest'
import { registerWorktreeRecoveryIpc } from './worktree-recovery-ipc'
import { fakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'
import type { AccountOwner } from './owner-lifetimes'

describe('physical owner worktree recovery RPC', () => {
  it('refuses peers, departed clients and invalid references before invoking a service', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const service = { list: vi.fn(), inspect: vi.fn(), keep: vi.fn() }
    const owners = registerWorktreeRecoveryIpc(platform, () => service)
    for (const channel of [IPC.worktreeRecoveryList, IPC.worktreeRecoveryInspect, IPC.worktreeRecoveryKeep]) {
      expect(isHostOnlyChannel(channel)).toBe(true)
      const answer = await platform.handlers[channel](2, 'record')
      if (channel === IPC.worktreeRecoveryList) expect(answer).toBeNull()
      else expect(answer).toMatchObject({ ok: false })
    }
    platform.clients.push(2); platform.isOwnerClient = (id) => id === 1
    expect(await platform.handlers[IPC.worktreeRecoveryList](2)).toBeNull()
    expect(await platform.handlers[IPC.worktreeRecoveryInspect](2, 'record')).toMatchObject({ ok: false })
    expect(await platform.handlers[IPC.worktreeRecoveryKeep](2, 'record')).toMatchObject({ ok: false, outcome: 'refused' })
    for (const bad of ['../record', '', {}, null, 'x'.repeat(129)]) {
      expect(await platform.handlers[IPC.worktreeRecoveryInspect](1, bad)).toMatchObject({ ok: false })
      expect(await platform.handlers[IPC.worktreeRecoveryKeep](1, bad)).toMatchObject({ ok: false, outcome: 'refused' })
    }
    expect(service.list).not.toHaveBeenCalled(); expect(service.inspect).not.toHaveBeenCalled(); expect(service.keep).not.toHaveBeenCalled()
    owners.dispose()
  })

  it('pins the document lifetime across list and actions, including reload that reuses the sender id', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const seen: AccountOwner[] = []
    const owners = registerWorktreeRecoveryIpc(platform, () => ({
      list: (owner) => { seen.push(owner); return { ok: true, records: [] } },
      inspect: async (_id, owner) => { seen.push(owner); return { ok: false, error: 'fixture' } },
      keep: async (_id, owner) => { seen.push(owner); return { ok: true, outcome: 'kept', message: 'fixture' } }
    }))
    await platform.handlers[IPC.worktreeRecoveryList](1)
    await platform.handlers[IPC.worktreeRecoveryKeep](1, 'record')
    expect(seen[0]).toBe(seen[1]); owners.forget(1)
    await platform.handlers[IPC.worktreeRecoveryInspect](1, 'record')
    expect(seen[0].active()).toBe(false); expect(seen[2].active()).toBe(true)
    owners.dispose(); expect(seen[2].active()).toBe(false)
  })

  it('negotiates unavailable administration and never repeats a possibly completed action', async () => {
    const platform = fakePlatform({ isOwnerClient: () => true }); platform.clients.push(1)
    const absent = registerWorktreeRecoveryIpc(platform, () => null)
    expect(await platform.handlers[IPC.worktreeRecoveryList](1)).toBeNull(); absent.dispose()
    const keep = vi.fn(async () => { throw new Error('reply lost') })
    const owners = registerWorktreeRecoveryIpc(platform, () => ({ list: () => ({ ok: true, records: [] }),
      inspect: async () => ({ ok: false, error: 'fixture' }), keep }))
    expect(await platform.handlers[IPC.worktreeRecoveryKeep](1, 'record')).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(keep).toHaveBeenCalledOnce(); owners.dispose()
  })
})
