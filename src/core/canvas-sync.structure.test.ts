import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { createCanvasAuthority, type CanvasAuthority } from './canvas-authority'
import { createCanvasOrder } from '../shared/canvas-order'
import { applyCanvasLayout, canvasLayoutOf } from '../shared/canvas-batch'
import { applyCanvasOp, type CanvasContent } from '../shared/canvas-content'
import { IPC } from '../shared/ipc'
import { initCanvasSync, publishCanvasMutation, publishCanvasMutationBatch, setReflectedListener, setReflectedBatchListener,
  setCanvasStructureResolver, setDynamicGroupMetadataResolver } from './canvas-sync'
import type { CanvasMutation, CanvasMutationBatch, CanvasNodeState, Workspace } from '../shared/types'

const n = (id: string, parentId?: string, kind: CanvasNodeState['kind'] = 'terminal'): CanvasNodeState => ({
  id, kind, title: `saved ${id}`, color: '#fff', group: null, position: { x: 28, y: 62 }, size: { width: 640, height: 440 },
  ...(parentId ? { parentId } : {})
})
const initial = (): CanvasContent => ({ nodes: [n('g', undefined, 'group'), n('h', undefined, 'group'), n('a', 'g'), n('plain')], bridges: [], ropes: [] })
const promote = (): CanvasMutationBatch => ({ mutations: [
  { op: 'upsert', node: { ...n('a'), position: { x: 900, y: 500 } } }, { op: 'remove', id: 'g' }
] })
const orphan = (content: CanvasContent) => content.nodes.some((node) => node.parentId && !content.nodes.some((p) => p.id === node.parentId && p.kind === 'group'))
let p: FakePlatform
let authority: CanvasAuthority
let scene: CanvasContent
let ws: Workspace
beforeEach(async () => {
  p = fakePlatform({ isOwnerClient: (id) => id === 1 }); p.clients.push(1, 2); initPlatform(p); initCanvasSync()
  p.clients.forEach((id) => p.senderListeners[IPC.canvasBatchSubscribe](id, true))
  scene = initial()
  ws = { version: 2, activeProjectId: 'P', projects: [{ id: 'P', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: scene.nodes }] }
  authority = createCanvasAuthority({ sharedProjectIds: () => new Set(['P']), readContent: async () => initial(),
    writeContent: async () => true, publish: () => {}, setTimer: () => null, clearTimer: () => {} })
  await authority.overlayLoad(ws)
  setCanvasStructureResolver(() => scene.nodes)
  setReflectedListener((id, mutation) => { authority.onReflected(id, mutation); scene = applyCanvasOp(scene, mutation, id) })
  setReflectedBatchListener((id, batch) => {
    authority.onReflectedBatch(id, batch)
    scene = batch.mutations.reduce((c, m) => applyCanvasOp(c, m, id), scene)
  })
})
afterEach(async () => {
  await authority.stop(); setReflectedListener(null); setReflectedBatchListener(null)
  setCanvasStructureResolver(null); setDynamicGroupMetadataResolver(null); resetPlatformForTests()
})

describe('structural host revisions and canonical client rebasing', () => {
  it('keeps unstamped concurrent legacy movement after the first ordinary open/host publication', () => {
    publishCanvasMutation('P', { op: 'upsert', node: n('new-terminal') })
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', node: { ...n('new-terminal'), position: { x: 999, y: 7 } } })
    expect(scene.nodes.find((node) => node.id === 'new-terminal')?.position).toEqual({ x: 999, y: 7 })
    expect(p.sent.filter((ev) => ev.channel === IPC.canvasMut && ev.to === 1)).toHaveLength(1)
  })

  it('does not create a structural barrier for ordinary launch metadata patches on a known node', () => {
    publishCanvasMutation('P', { op: 'upsert', node: n('a', 'g') })
    publishCanvasMutation('P', { op: 'upsert', node: { ...n('a', 'g'), pendingLaunch: { after: [], command: 'held' } } })
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', node: { ...n('a', 'g'), position: { x: 5, y: 5 } } })
    expect(scene.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 5, y: 5 })
    // A later canonical launch completion also retains the move rather than inventing a fence.
    publishCanvasMutation('P', { op: 'upsert', node: { ...scene.nodes.find((node) => node.id === 'a')!, pendingLaunch: undefined } })
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', node: { ...n('a', 'g'), position: { x: 999, y: 7 } } })
    expect(scene.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 999, y: 7 })
  })

  it('still fences a known ordinary membership change without treating publication alone as a revision', () => {
    publishCanvasMutation('P', { op: 'upsert', node: n('a', 'g') })
    publishCanvasMutation('P', { op: 'upsert', node: n('a', 'h') })
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', node: { ...n('a', 'g'), title: 'local title' } })
    expect(scene.nodes.find((node) => node.id === 'a')).toMatchObject({ parentId: 'h', title: 'local title' })
  })

  it('keeps title local through batch promotion, late upsert, canonical ACK/correction and authority persistence', async () => {
    const order = createCanvasOrder('owner')
    const local = { ...n('a', 'g'), title: 'latest local title', text: 'local text' }
    const intent = order.stamp({ op: 'upsert' as const, node: local, src: 'owner' })
    order.onLocal(intent, 'P')
    let client: CanvasContent = { ...initial(), nodes: initial().nodes.map((node) => node.id === 'a' ? local : node) }
    expect(publishCanvasMutationBatch('P', promote())).toBe(true)
    const batch = p.sent.find((ev) => ev.to === 1 && ev.channel === IPC.canvasMutationBatch)!.args[1] as CanvasMutationBatch
    for (const m of batch.mutations) {
      const mode = order.acceptBatch(m, 'P')
      const previous = m.op === 'upsert' ? client.nodes.find((node) => node.id === m.node.id) : undefined
      const actual = mode === 'layout' && m.op === 'upsert' && previous ? { ...m, node: applyCanvasLayout(previous, canvasLayoutOf(m.node)) } : m
      if (mode !== 'drop') client = applyCanvasOp(client, actual, 'P')
    }
    expect(orphan(client)).toBe(false)
    expect(client.nodes.find((node) => node.id === 'a')?.title).toBe('latest local title')
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', intent)
    const own = p.sent.filter((ev) => ev.to === 1 && ev.channel === IPC.canvasMut).map((ev) => ev.args[1] as CanvasMutation)
    expect(own).toHaveLength(2)
    for (const m of own) {
      if (order.accept(m, 'P')) client = applyCanvasOp(client, m, 'P')
      expect(orphan(client)).toBe(false)
      expect(client.nodes.find((node) => node.id === 'a')).toMatchObject({ title: 'latest local title', position: { x: 900, y: 500 } })
    }
    expect(own[0].src).toBe('owner'); expect(own[1].src).toBeUndefined()
    expect(own.every((m) => m.seen === intent.seen)).toBe(true)
    const stored = (await authority.overlayLoad(ws)).projects[0].nodes
    expect(stored.find((node) => node.id === 'a')).toMatchObject({ title: 'latest local title', position: { x: 900, y: 500 } })
    expect(stored.find((node) => node.id === 'a')?.parentId).toBeUndefined()
    expect(orphan({ ...scene, nodes: stored })).toBe(false)
  })

  it('allows intentional valid post-batch reparent, then keeps that latest tuple against another stale title edit', () => {
    publishCanvasMutationBatch('P', promote()); p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen: 2,
      node: { ...n('a', 'h'), title: 'intentional move', position: { x: 70, y: 90 } } })
    expect(scene.nodes.find((node) => node.id === 'a')).toMatchObject({ parentId: 'h', position: { x: 70, y: 90 } })
    expect(p.sent.filter((ev) => ev.to === 1 && ev.channel === IPC.canvasMut)).toHaveLength(1)
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'other', seen: 0,
      node: { ...n('a', 'g'), title: 'another local title' } })
    expect(scene.nodes.find((node) => node.id === 'a')).toMatchObject({ parentId: 'h', title: 'another local title', position: { x: 70, y: 90 } })
  })

  it.each(['missing', 'plain', 'a'])('refuses invalid post-batch parent %s and ACKs only canonical structure', (parentId) => {
    publishCanvasMutationBatch('P', promote()); p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen: 2, node: { ...n('a', parentId), title: 'invalid intent' } })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    expect(scene.nodes.find((node) => node.id === 'a')?.parentId).toBeUndefined()
    expect(scene.nodes.find((node) => node.id === 'a')?.title).toBe('saved a')
    for (const ev of p.sent.filter((ev) => ev.channel === IPC.canvasMut)) expect(ev.args[1].node.parentId).toBeUndefined()
  })

  it('does not resurrect the removed frame from an unstamped or pre-batch client snapshot', () => {
    publishCanvasMutationBatch('P', promote())
    for (const seen of [undefined, 0]) {
      p.sent.length = 0
      p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen, node: n('g', undefined, 'group') })
      expect(scene.nodes.some((node) => node.id === 'g')).toBe(false)
      expect(p.sent.filter((ev) => ev.channel === IPC.canvasMut).every((ev) => ev.args[1].op === 'remove')).toBe(true)
    }
  })

  it('does not project a deleted frame alive when the authority rejects a stale host child by tombstone', async () => {
    publishCanvasMutationBatch('P', promote())
    publishCanvasMutationBatch('P', { mutations: [{ op: 'upsert', node: n('g', undefined, 'group'), seen: 0 }] })
    expect((await authority.overlayLoad(ws)).projects[0].nodes.some((node) => node.id === 'g')).toBe(false)
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen: 3, node: n('a', 'g') })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    expect((await authority.overlayLoad(ws)).projects[0].nodes.find((node) => node.id === 'a')?.parentId).toBeUndefined()
  })

  it('blocks cycles through ancestors and removal or kind change of a frame with surviving children', () => {
    publishCanvasMutationBatch('P', { mutations: [{ op: 'upsert', node: n('h', 'g', 'group') }] })
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen: 1, node: n('g', 'h', 'group') })
    expect(scene.nodes.find((node) => node.id === 'g')?.parentId).toBeUndefined()
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'remove', id: 'g', src: 'owner', seen: 10 })
    expect(scene.nodes.some((node) => node.id === 'g')).toBe(true)
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', node: n('g'), src: 'owner', seen: 10 })
    expect(scene.nodes.find((node) => node.id === 'g')?.kind).toBe('group')
  })

  it('keeps revisions project-local and refuses an unavailable current scene without treating it as absence', () => {
    publishCanvasMutationBatch('P', promote())
    setCanvasStructureResolver((id) => id === 'Q' ? [n('a')] : undefined)
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'Q', { op: 'upsert', seen: 0, src: 'owner', node: { ...n('a'), position: { x: 50, y: 60 } } })
    expect(p.sent.filter((ev) => ev.channel === IPC.canvasMut)[0].args[1].node.position).toEqual({ x: 50, y: 60 })
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', seen: 2, src: 'owner', node: n('a') })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
  })

  it('uses the published tuple for a safe local ACK if the fresh resolver fails after a layout batch', () => {
    const order = createCanvasOrder('owner')
    const intent = order.stamp({ op: 'upsert' as const, src: 'owner', node: { ...n('a', 'g'), title: 'pending title' } })
    order.onLocal(intent, 'P')
    publishCanvasMutationBatch('P', promote())
    const batch = p.sent.find((ev) => ev.to === 1 && ev.channel === IPC.canvasMutationBatch)!.args[1] as CanvasMutationBatch
    batch.mutations.forEach((m) => order.acceptBatch(m, 'P'))
    setCanvasStructureResolver(() => { throw new Error('snapshot unavailable') })
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', intent)
    const own = p.sent.filter((ev) => ev.to === 1 && ev.channel === IPC.canvasMut)
    expect(own).toHaveLength(1)
    expect(own[0].args[1].node.parentId).toBeUndefined()
    expect(own[0].args[1].node.position).toEqual({ x: 900, y: 500 })
    expect(order.accept(own[0].args[1], 'P')).toBe(true)
    expect(p.sent.some((ev) => ev.to === 2)).toBe(false)
    expect(scene.nodes.find((node) => node.id === 'a')?.title).toBe('saved a')
  })

  it('does not infer a parent from an ambiguous restored scene', () => {
    setCanvasStructureResolver(() => [...scene.nodes, n('g', undefined, 'group')])
    p.sent.length = 0
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'owner', seen: 0, node: n('a', 'g') })
    expect(p.sent.some((ev) => ev.to === 2)).toBe(false)
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
  })
})
