// The shared registrar proves the sender boundary through actual registered calls.
import { describe, it, expect, vi } from 'vitest'
import { fakePlatform } from '../core/platform-fake'
import { registerBoardCommentDeliveryIpc } from '../core/agents/board-comment-ipc'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

describe('owner board-comment delivery boundary', () => {
  it('admits only the live main window on Desktop and refuses peers, guests and closed windows', async () => {
    let liveWindow = 1
    const platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 })
    const deliver = vi.fn(async () => ({ ok: true, result: { kind: 'queued' } }))
    registerBoardCommentDeliveryIpc(platform, { eligibleOwner: (id) => id === liveWindow, deliver })
    const call = platform.handlers[IPC.agentBoardCommentDeliver]
    const request = { commentId: 'comment-1' }
    expect(await call(1, request)).toMatchObject({ ok: true })
    expect(deliver).toHaveBeenCalledWith(request)
    for (const id of [2, 3, 99]) expect(await call(id, request)).toMatchObject({ ok: false, result: { reason: 'owner-required' } })
    liveWindow = 0
    expect(await call(1, request)).toMatchObject({ ok: false })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(isHostOnlyChannel(IPC.agentBoardCommentDeliver)).toBe(true)
  })

  it('admits authenticated owner tabs on Server and refuses an unclassified sender', async () => {
    const platform = fakePlatform({ isOwnerClient: (id) => id === 10 || id === 11 })
    const deliver = vi.fn(async () => ({ ok: true }))
    registerBoardCommentDeliveryIpc(platform, { eligibleOwner: () => true, deliver })
    const call = platform.handlers[IPC.agentBoardCommentDeliver]
    expect(await call(10, {})).toEqual({ ok: true })
    expect(await call(11, {})).toEqual({ ok: true })
    expect(await call(12, {})).toMatchObject({ ok: false })
    expect(deliver).toHaveBeenCalledTimes(2)
    const unknown = fakePlatform()
    registerBoardCommentDeliveryIpc(unknown, { eligibleOwner: () => true, deliver })
    expect(await unknown.handlers[IPC.agentBoardCommentDeliver](10, {})).toMatchObject({ ok: false })
    expect(deliver).toHaveBeenCalledTimes(2)
  })
})
