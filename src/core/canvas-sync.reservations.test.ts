import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { CanvasContentWriter } from './canvas-content-writer'
import { createCanvasAuthority, type CanvasAuthority } from './canvas-authority'
import { applyCanvasOp, type CanvasContent } from '../shared/canvas-content'
import { placeDynamicGroupMember } from '../shared/dynamic-groups'
import { IPC } from '../shared/ipc'
import { initCanvasSync, publishCanvasMutation, publishCanvasMutationBatch, setReflectedListener, setReflectedBatchListener,
  setCanvasStructureResolver, setDynamicGroupMetadataResolver } from './canvas-sync'
import type { CanvasMutationBatch, CanvasNodeState, Workspace } from '../shared/types'

const n = (id: string, parentId?: string): CanvasNodeState => ({ id, kind: 'terminal', title: id,
  color: '#fff', group: null, position: { x: 28, y: 62 }, size: { width: 640, height: 440 }, ...(parentId ? { parentId } : {}) })
const facts = (state: 'reserved' | 'consumed' | 'released'): NonNullable<CanvasNodeState['dynamicGroup']> => ({
  version: 1, reservations: [{ id: 'late-slot', state, width: 800, height: 600, position: { x: 28, y: 502 },
    ...(state === 'consumed' ? { nodeId: 'review' } : {}) }]
})
const group = (state?: 'reserved' | 'consumed' | 'released'): CanvasNodeState => ({ ...n('g'), kind: 'group',
  position: { x: 0, y: 0 }, size: { width: 1200, height: 1500 },
  dynamicGroup: state ? facts(state) : { version: 1, reservations: [] } })
let p: FakePlatform, authority: CanvasAuthority, current: CanvasContent, persisted: CanvasContent
const ws = (content: CanvasContent): Workspace => ({ version: 2, activeProjectId: 'P', projects: [{
  id: 'P', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, ...content
}] })
const frame = () => current.nodes.find((node) => node.id === 'g')!
const cast = (node: CanvasNodeState, seen?: number) => p.senderListeners[IPC.canvasMut](1, 'P', { op: 'upsert', src: 'old-ui', node, seen })
const publish = (nodes: CanvasNodeState[]) => expect(publishCanvasMutationBatch('P', {
  mutations: nodes.map((node) => ({ op: 'upsert', node }))
})).toBe(true)
beforeEach(async () => {
  p = fakePlatform({ isOwnerClient: (id) => id === 1 }); p.clients.push(1, 2); initPlatform(p); initCanvasSync()
  p.clients.forEach((id) => p.senderListeners[IPC.canvasBatchSubscribe](id, true))
  current = { nodes: [group(), n('a', 'g')], bridges: [], ropes: [] }; persisted = structuredClone(current)
  authority = createCanvasAuthority({ sharedProjectIds: () => new Set(['P']), readContent: async () => persisted,
    writeContent: async () => false, publish: () => {}, setTimer: () => null, clearTimer: () => {}, log: () => {} })
  await authority.overlayLoad(ws(persisted))
  setReflectedListener((id, mutation) => { authority.onReflected(id, mutation); current = applyCanvasOp(current, mutation, id) })
  setReflectedBatchListener((id, batch) => {
    authority.onReflectedBatch(id, batch); current = batch.mutations.reduce((c, m) => applyCanvasOp(c, m, id), current)
  })
  // Intentionally remains the preceding persisted snapshot after every publication/failure.
  setCanvasStructureResolver(() => persisted.nodes)
  setDynamicGroupMetadataResolver((_project, id) => persisted.nodes.find((node) => node.id === id)?.dynamicGroup)
})
afterEach(async () => {
  await authority.stop(); setReflectedListener(null); setReflectedBatchListener(null)
  setCanvasStructureResolver(null); setDynamicGroupMetadataResolver(null); resetPlatformForTests()
})

describe('reservation publication facts and late single-cast geometry', () => {
  it('does not erase an in-flight ordinary drag when the host only renames content', () => {
    publishCanvasMutation('P', { op: 'upsert', node: n('a', 'g') })
    publishCanvasMutation('P', { op: 'upsert', node: { ...n('a', 'g'), title: 'Host renamed' } })
    cast({ ...n('a', 'g'), position: { x: 100, y: 50 } }, 1)
    expect(current.nodes.find((node) => node.id === 'a')!.position).toEqual({ x: 100, y: 50 })
  })

  it('does not invent another barrier for a content-only batch whose published tuple is unchanged', () => {
    publish([group(), n('a', 'g')])
    publish([{ ...n('a', 'g'), title: 'Host renamed' }])
    cast({ ...n('a', 'g'), position: { x: 100, y: 50 } }, 2)
    expect(current.nodes.find((node) => node.id === 'a')!.position).toEqual({ x: 100, y: 50 })
  })

  it.each([0, 2])('retains published consumed facts after failed disk acknowledgement, even with preceding getter and seen=%s', async (seen) => {
    persisted = { ...persisted, nodes: [group('reserved'), n('a', 'g')] }
    const writer = new CanvasContentWriter({ workspaceStore: {
      load: async () => ws(persisted), save: async () => { throw new Error('disk failed') },
      updateWorkspace: async (edit, beforeSave) => {
        const old = ws(structuredClone(persisted)), next = edit(ws(structuredClone(persisted)))
        beforeSave?.(old, next); throw new Error('disk acknowledgement failed after publication')
      }
    } })
    await expect(writer.editBatch((workspace) => {
      workspace.projects[0].nodes[0] = group('consumed')
      workspace.projects[0].nodes.push({ ...n('review', 'g'), position: { x: 28, y: 502 } })
    })).rejects.toMatchObject({ indeterminate: true })
    p.sent.length = 0
    cast({ ...group('reserved'), title: 'local title', position: { x: 100, y: 50 } }, seen)
    expect(frame().dynamicGroup).toEqual(facts('consumed'))
    expect(frame().title).toBe('local title')
    const received = p.sent.filter((ev) => ev.channel === IPC.canvasMut && ev.args[1].op === 'upsert' && ev.args[1].node.id === 'g')
    expect(received.length).toBeGreaterThan(0)
    expect(received.every((ev) => ev.args[1].node.dynamicGroup.reservations[0].state === 'consumed')).toBe(true)
    expect((await authority.overlayLoad(ws(persisted))).projects[0].nodes.find((node) => node.id === 'g')!.dynamicGroup).toEqual(facts('consumed'))
    expect(frame().position).toEqual(seen === 0 ? { x: 0, y: 0 } : { x: 100, y: 50 })
  })

  it('lets later complete host facts advance or clear state despite a preceding disk getter', () => {
    persisted = { ...persisted, nodes: [group('reserved'), n('a', 'g')] }
    publish([group('consumed')]); cast(group('reserved'), 50)
    expect(frame().dynamicGroup).toEqual(facts('consumed'))
    publish([group('released')]); cast(group('reserved'), 50)
    expect(frame().dynamicGroup).toEqual(facts('released'))
    const cleared = group(); delete cleared.dynamicGroup
    publish([cleared]); cast(group('reserved'), 50)
    expect(frame().dynamicGroup).toBeUndefined()
  })

  it('rejects a pending member drag into a later slot even when its own last barrier was already seen', () => {
    publish([group(), n('a', 'g')]) // member revision 2
    publish([group('reserved')]) // only frame changes; member's old revision still 2
    p.sent.length = 0
    cast({ ...n('a', 'g'), position: { x: 28, y: 700 } }, 2)
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    expect(current.nodes.find((node) => node.id === 'a')!.position).toEqual({ x: 28, y: 62 })
    const own = p.sent.filter((ev) => ev.channel === IPC.canvasMut && ev.to === 1)
    expect(own).toHaveLength(2)
    expect(own.every((ev) => ev.args[1].node.position.y === 62)).toBe(true)
    expect(placeDynamicGroupMember(current.nodes, 'g', n('review'), 'late-slot').ok).toBe(true)
  })

  it('accepts ordinary titles and successive non-conflicting individual geometry updates without repacking neighbors', () => {
    publish([group(), n('a', 'g')]); publish([group('reserved')])
    cast({ ...n('a', 'g'), title: 'local title' }, 2)
    expect(current.nodes.find((node) => node.id === 'a')!.title).toBe('local title')
    cast({ ...n('a', 'g'), position: { x: 50, y: 62 } }, 20)
    cast({ ...group('reserved'), size: { width: 1600, height: 1600 } }, 20)
    expect(current.nodes.find((node) => node.id === 'a')!.position).toEqual({ x: 50, y: 62 })
    expect(frame().size).toEqual({ width: 1600, height: 1600 })
    expect(placeDynamicGroupMember(current.nodes, 'g', n('review'), 'late-slot').ok).toBe(true)
  })

  it('refuses shrinking/removing an active-slot frame, including an empty frame', () => {
    publish([group('reserved')]); p.sent.length = 0
    cast({ ...group('reserved'), size: { width: 1200, height: 800 } }, 20)
    expect(frame().size).toEqual({ width: 1200, height: 1500 })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
    const removeMember: CanvasMutationBatch = { mutations: [{ op: 'remove', id: 'a' }] }
    publishCanvasMutationBatch('P', removeMember)
    p.senderListeners[IPC.canvasMut](1, 'P', { op: 'remove', id: 'g', src: 'old-ui', seen: 20 })
    expect(frame().dynamicGroup).toEqual(facts('reserved'))
  })

  it('also catches a nested child that would overflow into an ancestor slot', () => {
    const child = { ...n('inner', 'nested'), size: { width: 260, height: 160 } }
    publish([group('reserved'), { ...n('nested', 'g'), kind: 'group' }, child])
    publishCanvasMutationBatch('P', { mutations: [{ op: 'remove', id: 'a' }] })
    p.sent.length = 0
    cast({ ...child, position: { x: 28, y: 400 } }, 50)
    expect(current.nodes.find((node) => node.id === 'inner')!.position).toEqual({ x: 28, y: 62 })
    expect(p.sent.some((ev) => ev.channel === IPC.canvasMutationRejected)).toBe(true)
  })

  it('does not reserve a released footprint again through an old getter or block a valid move into it', () => {
    persisted = { ...persisted, nodes: [group('reserved'), n('a', 'g')] }
    publish([group('released'), n('a', 'g')])
    cast({ ...n('a', 'g'), position: { x: 28, y: 700 } }, 50)
    expect(current.nodes.find((node) => node.id === 'a')!.position.y).toBe(700)
    expect(frame().dynamicGroup).toEqual(facts('released'))
  })
})
