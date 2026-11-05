import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { createCanvasOrder } from '../shared/canvas-order'
import { IPC } from '../shared/ipc'
import {
  initCanvasSync, publishCanvasMutation, setDynamicGroupMetadataResolver,
  setReflectedListener, setClientMutationAdmission
} from './canvas-sync'
import type { CanvasMutation, CanvasNodeState } from '../shared/types'

const state = (status: 'reserved' | 'consumed' | 'released'): NonNullable<CanvasNodeState['dynamicGroup']> => ({
  version: 1, reservations: [{ id: 'review', width: 640, height: 440, position: { x: 28, y: 62 }, state: status,
    ...(status === 'consumed' ? { nodeId: 'agent-review' } : {}) }]
})
const frame = (metadata?: CanvasNodeState['dynamicGroup']): CanvasNodeState => ({
  id: 'group', kind: 'group', title: 'Group', color: '#fff', group: null,
  position: { x: 900, y: 100 }, size: { width: 800, height: 600 },
  ...(metadata ? { dynamicGroup: metadata } : {})
})
let p: FakePlatform
const cast = (node: CanvasNodeState, sender = 1, src?: string) => p.senderListeners[IPC.canvasMut](sender, 'P', { op: 'upsert', node, ...(src ? { src } : {}) })
const reflected = () => p.sent.filter((ev) => ev.channel === IPC.canvasMut)
beforeEach(() => { p = fakePlatform({ isOwnerClient: (id) => id === 1 }); p.clients.push(1, 2); initPlatform(p); initCanvasSync() })
afterEach(() => {
  setDynamicGroupMetadataResolver(null); setReflectedListener(null); setClientMutationAdmission(null); resetPlatformForTests()
})

describe('host-owned group metadata at client mutation ingress', () => {
  it.each([undefined, state('reserved'), state('released')])('keeps the latest consumed fact when an old/stale owner UI edits geometry (%j)', (incoming) => {
    const facts = state('consumed')
    setDynamicGroupMetadataResolver((project, id) => project === 'P' && id === 'group' ? facts : undefined)
    const observe = vi.fn(); setReflectedListener(observe)
    cast(frame(incoming))
    expect(observe).toHaveBeenCalledOnce()
    for (const ev of reflected()) expect(ev.args[1]).toMatchObject({ node: { dynamicGroup: facts, position: { x: 900, y: 100 } } })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(false)
    expect(facts).toEqual(state('consumed'))
  })

  it('ACKs a stale optimistic update before a canonical no-src correction, so the sender also applies the facts', () => {
    setDynamicGroupMetadataResolver(() => state('consumed'))
    const order = createCanvasOrder('owner')
    const intent = order.stamp({ op: 'upsert', node: frame(state('reserved')), src: 'owner' })
    order.onLocal(intent, 'P')
    p.senderListeners[IPC.canvasMut](1, 'P', intent)
    const own = reflected().filter((ev) => ev.to === 1).map((ev) => ev.args[1] as CanvasMutation)
    const other = reflected().filter((ev) => ev.to === 2)
    expect(own).toHaveLength(2); expect(other).toHaveLength(1)
    expect(order.accept(own[0], 'P')).toBe(false)
    expect(order.accept(own[1], 'P')).toBe(true)
    expect(own[1].src).toBeUndefined()
    expect(own[1]).toMatchObject({ node: { dynamicGroup: state('consumed') } })
  })

  it('does not turn a metadata correction of an old drag into authority to recreate a deleted frame', () => {
    setDynamicGroupMetadataResolver(() => undefined)
    const order = createCanvasOrder('owner')
    const intent = order.stamp({ op: 'upsert', node: frame(state('reserved')), src: 'owner' })
    order.onLocal(intent, 'P')
    publishCanvasMutation('P', { op: 'remove', id: 'group' })
    const removed = reflected().find((ev) => ev.to === 1)!.args[1] as CanvasMutation
    expect(order.accept(removed, 'P')).toBe(true)
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', intent)
    const own = reflected().filter((ev) => ev.to === 1).map((ev) => ev.args[1] as CanvasMutation)
    expect(own).toHaveLength(2)
    const accepted = own.filter((m) => order.accept(m, 'P'))
    expect(accepted.every((m) => m.op === 'remove')).toBe(true)
    expect(own[0].seen).toBe(intent.seen)
  })

  it('strips forged facts from owners and guests when the host has none, and scopes the lookup to this project/node', () => {
    const resolve = vi.fn(() => undefined); setDynamicGroupMetadataResolver(resolve)
    cast(frame(state('reserved')), 1); cast(frame(state('consumed')), 2)
    expect(resolve.mock.calls).toEqual([['P', 'group'], ['P', 'group']])
    for (const ev of reflected()) expect(ev.args[1].node.dynamicGroup).toBeUndefined()
  })

  it('never treats an uninstalled resolver as client permission to author facts', () => {
    cast(frame(state('reserved')))
    for (const ev of reflected()) expect(ev.args[1].node.dynamicGroup).toBeUndefined()
  })

  it('does not consult or replace host facts for a trusted Core publication', () => {
    const resolve = vi.fn(() => state('consumed')); setDynamicGroupMetadataResolver(resolve)
    expect(publishCanvasMutation('P', { op: 'upsert', node: frame(state('released')) })).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    for (const ev of reflected()) expect(ev.args[1].node.dynamicGroup).toEqual(state('released'))
  })

  it('refuses unavailable/corrupt host facts or a client kind change before authority or peers receive an edit', () => {
    const observe = vi.fn(); setReflectedListener(observe)
    const broken = [
      () => { throw new Error('ambiguous host snapshot') },
      () => ({ version: 1, reservations: [{ id: 'corrupt' }] } as unknown as CanvasNodeState['dynamicGroup']),
      () => state('consumed')
    ]
    for (const resolve of broken) {
      p.sent.length = 0; setDynamicGroupMetadataResolver(resolve)
      cast({ ...frame(), kind: 'terminal' })
      expect(observe).not.toHaveBeenCalled()
      expect(p.sent.some((ev) => ev.to === 2)).toBe(false)
      expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    }
  })

  it('runs ordinary admission on the canonical facts before publishing a correction', () => {
    setDynamicGroupMetadataResolver(() => state('consumed'))
    const admit = vi.fn((_project, mutation) => {
      expect(mutation.node.dynamicGroup).toEqual(state('consumed'))
      return { reason: 'Reserved by another domain action.' }
    })
    setClientMutationAdmission(admit)
    const observe = vi.fn(); setReflectedListener(observe)
    cast(frame(state('reserved')), 1, 'owner')
    expect(admit).toHaveBeenCalledOnce(); expect(observe).not.toHaveBeenCalled()
    expect(p.sent.some((ev) => ev.to === 2)).toBe(false)
  })

  it('does not reuse another platform lifetime resolver', () => {
    setDynamicGroupMetadataResolver(() => state('consumed'))
    p = fakePlatform(); p.clients.push(1); initPlatform(p); initCanvasSync()
    cast(frame(state('reserved')))
    expect(reflected()[0].args[1].node.dynamicGroup).toBeUndefined()
  })
})
