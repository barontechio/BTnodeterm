import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasMutation, CanvasMutationBatch, CanvasNodeState, Project } from '@shared/types'
import { createCanvasOrder } from '@shared/canvas-order'
import { applyMutationToFlow, flowToNodeStates, nodeStatesToFlow } from '../state/workspace'
import { createCanvasPublisher } from '@shared/canvas-publish'
import { useProjects, setStoredCanvasPublishHook } from '../state/projects'
import { applyStoredCanvasBatch, receiveCanvasBatch, reduceLiveCanvasBatch, subscribeCanvasBatches, type LiveBatchScene } from './received-batch'
import { rebaseOnLatest } from './nodesEpoch'

const n = (id: string, parentId?: string): CanvasNodeState => ({ id, kind: 'terminal', title: id,
  position: { x: 28, y: 62 }, size: { width: 300, height: 200 }, color: '#fff', group: null, parentId })
const group = (): CanvasNodeState => ({ ...n('g'), kind: 'group', size: { width: 1000, height: 800 },
  dynamicGroup: { version: 1, reservations: [] } })
const project = (id: string): Project => ({ id, name: id, color: '#fff', viewport: { x: 3, y: 4, zoom: 0.7 }, nodes: [n('a'), n('untouched')] })
const upsert = (node: CanvasNodeState, seq: number): CanvasMutation => ({ op: 'upsert', node, seq, src: 'host', origin: 'core' })
const initialProjects = useProjects.getState().projects
const initialActive = useProjects.getState().activeProjectId

afterEach(() => {
  setStoredCanvasPublishHook(null)
  useProjects.setState({ projects: initialProjects, activeProjectId: initialActive })
})

describe('received atomic canvas batches', () => {
  it('mounts a real batch subscriber and exposes one final scene, preserving local data and edges', () => {
    let listener: ((projectId: string, batch: CanvasMutationBatch) => void) | undefined
    const unsubscribe = vi.fn(() => { listener = undefined })
    const api = { onMutationBatch: vi.fn((fn: typeof listener) => { listener = fn; return unsubscribe }) }
    let scene: LiveBatchScene = { nodes: nodeStatesToFlow([n('a'), n('untouched')]),
      bridges: [{ id: 'edge', source: 'a', target: 'untouched', selected: true }], ropes: [] }
    const original = scene
    scene.nodes[0].selected = true
    scene.nodes[0].data.initialCommand = 'local launch'
    scene.nodes[0].data.respawnNonce = 99
    const seen = [scene]
    const order = createCanvasOrder('client')
    const stop = subscribeCanvasBatches(api, { order: () => order, relay: false, apply: (_id, accepted) => {
      scene = reduceLiveCanvasBatch(scene, accepted.mutations, accepted.layoutOnly)
      seen.push(scene)
    } })
    listener!('p', { mutations: [upsert(group(), 1), upsert(n('a', 'g'), 2),
      { op: 'edge-upsert', kind: 'rope', edge: { id: 'rope', source: 'a', target: 'untouched' }, seq: 3, src: 'host' }] })
    expect(seen).toHaveLength(2)
    expect(seen[0].nodes.some((n) => n.id === 'g')).toBe(false)
    expect(seen[1].nodes.find((n) => n.id === 'a')!.parentId).toBe('g')
    expect(scene.nodes.find((n) => n.id === 'a')!.selected).toBe(true)
    expect(scene.nodes.find((n) => n.id === 'a')!.data.initialCommand).toBe('local launch')
    expect(scene.nodes.find((n) => n.id === 'a')!.data.respawnNonce).toBe(99)
    expect(scene.nodes.find((n) => n.id === 'untouched')).toBe(original.nodes[1])
    expect(scene.bridges).toBe(original.bridges)
    expect(seen[0].ropes).toHaveLength(0)
    expect(seen[1].ropes[0]).toMatchObject({ id: 'rope', source: 'a', target: 'untouched' })
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(listener).toBeUndefined()
  })
  it('validates the entire envelope before advancing order or installing a child', () => {
    const order = createCanvasOrder('client')
    const invalid = { mutations: [upsert(group(), 10), { op: 'upsert', node: { id: 'broken' }, seq: 11 }] }
    expect(receiveCanvasBatch(invalid, 'p', order, false)).toBeUndefined()
    const result = receiveCanvasBatch({ mutations: [upsert(group(), 1)] }, 'p', order, false)!
    expect(result.mutations).toHaveLength(1)
    expect(receiveCanvasBatch({ mutations: [] }, 'p', order, false)).toBeUndefined()
    expect(receiveCanvasBatch({ mutations: [upsert(group(), 2)], extra: true }, 'p', order, false)).toBeUndefined()
    expect(receiveCanvasBatch({ mutations: Array(1025).fill(upsert(group(), 3)) }, 'p', order, false)).toBeUndefined()
  })
  it('keeps pending ordinary content while applying batch layout and retaining canonical ACK repair', () => {
    const order = createCanvasOrder('client')
    order.onLocal({ op: 'upsert', node: { ...n('a'), title: 'local pending edit' } }, 'p')
    const received = receiveCanvasBatch({ mutations: [upsert(group(), 1), upsert(n('a'), 2), upsert(n('other'), 3)] }, 'p', order, false)!
    expect(received.mutations.map((m) => m.op === 'upsert' ? m.node.id : '')).toEqual(['g', 'a', 'other'])
    expect(received.layoutOnly.has(received.mutations[1])).toBe(true)
    const base: LiveBatchScene = { nodes: nodeStatesToFlow([{ ...n('a'), title: 'local pending edit' }]), bridges: [], ropes: [] }
    const result = reduceLiveCanvasBatch(base, received.mutations, received.layoutOnly)
    expect(result.nodes.find((n) => n.id === 'a')).toBe(base.nodes[0])
    const repair = receiveCanvasBatch({ mutations: [{ ...upsert({ ...n('a'), title: 'local pending edit' }, 4), src: 'client' }] }, 'p', order, false)!
    expect(repair.mutations).toHaveLength(1)
    expect(repair.layoutOnly.size).toBe(0)
    expect(reduceLiveCanvasBatch(result, repair.mutations, repair.layoutOnly).nodes.find((n) => n.id === 'a')!.data.title).toBe('local pending edit')
    expect(receiveCanvasBatch({ mutations: [upsert(n('a', 'g'), 5)] }, 'p', order, false)!.mutations).toHaveLength(1)
  })
  it('keeps a frame-removal batch structurally complete while its child has a pending local title', () => {
    let listener: ((projectId: string, batch: CanvasMutationBatch) => void) | undefined
    const order = createCanvasOrder('client')
    const local = { ...n('a', 'g'), title: 'pending local title' }
    let scene: LiveBatchScene = { nodes: nodeStatesToFlow([group(), local]), bridges: [], ropes: [] }
    scene.nodes.find((n) => n.id === 'a')!.selected = true
    order.onLocal({ op: 'upsert', node: local }, 'p')
    const snapshots = [scene]
    const stop = subscribeCanvasBatches({ onMutationBatch: (fn) => { listener = fn; return () => {} } }, {
      order: () => order, relay: false, apply: (_projectId, accepted) => {
        scene = reduceLiveCanvasBatch(scene, accepted.mutations, accepted.layoutOnly)
        snapshots.push(scene)
      }
    })
    listener!('p', { mutations: [
      upsert({ ...n('a'), position: { x: 128, y: 262 } }, 1),
      { op: 'remove', id: 'g', src: 'host', origin: 'core', seq: 2 }
    ] })
    stop()
    expect(snapshots).toHaveLength(2)
    expect(scene.nodes.some((n) => n.id === 'g')).toBe(false)
    const child = scene.nodes.find((n) => n.id === 'a')!
    expect(child.parentId).toBeUndefined()
    expect(child.position).toEqual({ x: 128, y: 262 })
    expect(child.data.title).toBe('pending local title')
    expect(child.selected).toBe(true)
    expect(scene.nodes.every((n) => !n.parentId || scene.nodes.some((p) => p.id === n.parentId))).toBe(true)
  })
  it('never turns a stale batch replay into a layout override of newer structure', () => {
    const order = createCanvasOrder('client')
    const newParent = { ...group(), id: 'new-parent' }
    const currentChild = { ...n('a', newParent.id), position: { x: 100, y: 200 } }
    const current: LiveBatchScene = { nodes: nodeStatesToFlow([newParent, currentChild]), bridges: [], ropes: [] }
    order.accept(upsert(currentChild, 20), 'p')
    order.accept({ op: 'remove', id: 'g', src: 'host', seq: 21 }, 'p')
    order.onLocal({ op: 'upsert', node: { ...currentChild, title: 'new pending edit' } }, 'p')
    const old = receiveCanvasBatch({ mutations: [upsert(n('a', 'g'), 1),
      { op: 'remove', id: 'g', seq: 2, origin: 'core' }] }, 'p', order, false)!
    expect(old.mutations).toEqual([])
    expect(old.layoutOnly.size).toBe(0)
    expect(reduceLiveCanvasBatch(current, old.mutations, old.layoutOnly)).toBe(current)
  })
  it('keeps deletion tombstones effective even when a stale batch upsert also has a pending local edit', () => {
    const order = createCanvasOrder('client')
    order.onLocal({ op: 'upsert', node: { ...n('a', 'g'), title: 'pending before deletion' } }, 'p')
    order.accept({ op: 'remove', id: 'a', src: 'host', seq: 10 }, 'p')
    const scene: LiveBatchScene = { nodes: nodeStatesToFlow([group()]), bridges: [], ropes: [] }
    const old = receiveCanvasBatch({ mutations: [{ ...upsert(n('a'), 11), seen: 0 },
      { op: 'remove', id: 'g', seq: 12, src: 'host' }] }, 'p', order, false)!
    expect(old.mutations).toEqual([{ op: 'remove', id: 'g', seq: 12, src: 'host' }])
    expect(old.layoutOnly.size).toBe(0)
    expect(reduceLiveCanvasBatch(scene, old.mutations, old.layoutOnly).nodes).toEqual([])
  })
  it('does not apply an ordinary own ACK as a layout replay', () => {
    const order = createCanvasOrder('client')
    const local = { ...n('a', 'g'), title: 'pending title' }
    order.onLocal({ op: 'upsert', node: local }, 'p')
    order.accept(upsert(n('a'), 1), 'p')
    const current: LiveBatchScene = { nodes: nodeStatesToFlow([{ ...n('a'), title: local.title }]), bridges: [], ropes: [] }
    const echo = receiveCanvasBatch({ mutations: [{ ...upsert(local, 2), src: 'client' }] }, 'p', order, false)!
    expect(echo.mutations).toEqual([])
    expect(echo.layoutOnly.size).toBe(0)
    expect(reduceLiveCanvasBatch(current, echo.mutations, echo.layoutOnly)).toBe(current)
  })
  it('preserves a pending title through promotion, publisher adopt and the host-rebased late ACK', () => {
    const order = createCanvasOrder('client')
    let scene: LiveBatchScene = { nodes: nodeStatesToFlow([group(), n('a', 'g')]), bridges: [], ropes: [] }
    const casts: CanvasMutation[] = []
    const publisher = createCanvasPublisher((mutation) => {
      const stamped = order.stamp(mutation)
      order.onLocal(stamped, 'p')
      casts.push(stamped)
    }, { src: 'client' })
    publisher.adopt(flowToNodeStates(scene.nodes))
    scene = { ...scene, nodes: scene.nodes.map((node) => node.id === 'a' ? {
      ...node, data: { ...node.data, title: 'pending title' }
    } : node) }
    publisher.publish(flowToNodeStates(scene.nodes))
    expect(casts).toHaveLength(1)
    let listener: ((projectId: string, batch: CanvasMutationBatch) => void) | undefined
    const stop = subscribeCanvasBatches({ onMutationBatch: (fn) => { listener = fn; return () => {} } }, {
      order: () => order, relay: false, apply: (_id, accepted) => {
        scene = reduceLiveCanvasBatch(scene, accepted.mutations, accepted.layoutOnly)
        publisher.adopt(flowToNodeStates(scene.nodes))
      }
    })
    listener!('p', { mutations: [upsert(n('a'), 1), { op: 'remove', id: 'g', src: 'host', seq: 2 }] })
    expect(scene.nodes[0].parentId).toBeUndefined()
    expect(scene.nodes[0].data.title).toBe('pending title')
    publisher.publish(flowToNodeStates(scene.nodes))
    expect(casts).toHaveLength(1)
    // The host's revision fence replaces the old parent tuple, preserving the submitted title.
    const rebased = { ...n('a'), title: 'pending title' }
    const ack = receiveCanvasBatch({ mutations: [{ ...upsert(rebased, 3), src: 'client', seen: 0 }] }, 'p', order, false)!
    scene = reduceLiveCanvasBatch(scene, ack.mutations, ack.layoutOnly)
    expect(scene.nodes[0].parentId).toBeUndefined()
    expect(scene.nodes[0].data.title).toBe(rebased.title)
    expect(casts[0].op === 'upsert' && casts[0].node.parentId).toBe('g')
    stop()
    publisher.dispose()
  })
  it('keeps frame growth and slot facts atomic when the frame title itself is pending', () => {
    const order = createCanvasOrder('client')
    const local = { ...group(), title: 'pending frame title' }
    order.onLocal({ op: 'upsert', node: local }, 'p')
    const incoming = { ...group(), size: { width: 2000, height: 1200 }, dynamicGroup: { version: 1 as const,
      reservations: [{ id: 'slot', position: { x: 1500, y: 62 }, width: 300, height: 200, state: 'reserved' as const }] } }
    const member = { ...n('a', 'g'), size: { width: 1400, height: 800 } }
    const base: LiveBatchScene = { nodes: nodeStatesToFlow([local, n('a', 'g')]), bridges: [], ropes: [] }
    const accepted = receiveCanvasBatch({ mutations: [upsert(incoming, 1), upsert(member, 2)] }, 'p', order, false)!
    expect(accepted.layoutOnly.has(accepted.mutations[0])).toBe(true)
    const final = reduceLiveCanvasBatch(base, accepted.mutations, accepted.layoutOnly)
    const frame = final.nodes.find((n) => n.id === 'g')!
    const child = final.nodes.find((n) => n.id === 'a')!
    expect(frame.data.title).toBe('pending frame title')
    expect(frame.width).toBe(2000)
    expect(frame.data.dynamicGroup).toEqual(incoming.dynamicGroup)
    expect(child.position.x + child.width! + 28).toBeLessThanOrEqual(frame.width!)
  })
  it('projects relay batch layout after stripping launch provenance and SSH connection', () => {
    const order = createCanvasOrder('client')
    const local = { ...n('a', 'g'), title: 'pending relay title', pendingLaunch: { after: [], command: 'local', attempted: false } }
    order.onLocal({ op: 'upsert', node: local }, 'p')
    const base: LiveBatchScene = { nodes: nodeStatesToFlow([group(), local]), bridges: [], ropes: [] }
    const incoming = { ...n('a'), pendingLaunch: { after: [], command: 'foreign', attempted: false },
      sshRemoteTmux: true, ssh: { host: 'foreign', user: 'user' } }
    const accepted = receiveCanvasBatch({ mutations: [upsert(incoming, 1),
      { op: 'remove', id: 'g', seq: 2, origin: 'core' }] }, 'p', order, true)!
    expect(accepted.mutations[0].origin).toBeUndefined()
    expect(accepted.layoutOnly.has(accepted.mutations[0])).toBe(true)
    const final = reduceLiveCanvasBatch(base, accepted.mutations, accepted.layoutOnly)
    expect(final.nodes).toHaveLength(1)
    expect(final.nodes[0].parentId).toBeUndefined()
    expect(final.nodes[0].data.title).toBe(local.title)
    expect(final.nodes[0].data.pendingLaunch?.command).toBe('local')
    expect(final.nodes[0].data.ssh).toBeUndefined()
  })
  it('retains a deliberate later reparent while earlier corrected ACKs settle', () => {
    const order = createCanvasOrder('client')
    const local = { ...n('a', 'g'), title: 'pending title' }
    const nextFrame = { ...group(), id: 'next' }
    order.onLocal({ op: 'upsert', node: local }, 'p')
    let scene: LiveBatchScene = { nodes: nodeStatesToFlow([group(), nextFrame, local]), bridges: [], ropes: [] }
    const batch = receiveCanvasBatch({ mutations: [upsert(n('a'), 1), { op: 'remove', id: 'g', src: 'host', seq: 2 }] }, 'p', order, false)!
    scene = reduceLiveCanvasBatch(scene, batch.mutations, batch.layoutOnly)
    const intentional = order.stamp({ op: 'upsert' as const, node: { ...local, parentId: 'next' }, src: 'client' })
    expect(intentional.seen).toBe(2)
    order.onLocal(intentional, 'p')
    // This is the newer optimistic human edit; incoming ordinary corrections still use accept.
    scene = { ...scene, nodes: scene.nodes.map((node) => node.id === 'a' ? { ...node, parentId: 'next' } : node) }
    const corrections: CanvasMutation[] = [
      { ...upsert({ ...local, parentId: undefined }, 3), src: 'client' },
      { ...upsert({ ...local, parentId: undefined }, 4), src: undefined, seen: 0 },
      { ...intentional, seq: 5 }
    ]
    for (const mutation of corrections) if (order.accept(mutation, 'p')) scene = { ...scene, nodes: applyMutationToFlow(scene.nodes, mutation) }
    expect(scene.nodes.find((n) => n.id === 'a')!.parentId).toBe('next')
    expect(scene.nodes.find((n) => n.id === 'a')!.data.title).toBe('pending title')
    expect(scene.nodes.every((n) => !n.parentId || scene.nodes.some((p) => p.id === n.parentId))).toBe(true)
  })
  it('releases a held local remove on its echoed batch without reinstalling optimistic state', () => {
    const order = createCanvasOrder('client')
    order.onLocal({ op: 'remove', id: 'a' }, 'p')
    expect(order.pendingRemoveCount()).toBe(1)
    const received = receiveCanvasBatch({ mutations: [{ op: 'remove', id: 'a', src: 'client', seq: 1 }] }, 'p', order, false)!
    expect(received.mutations).toEqual([])
    expect(received.released).toBe(true)
    expect(order.pendingRemoveCount()).toBe(0)
  })
  it('strips relay launch provenance and dial-capable SSH fields before reducing', () => {
    const state = { ...n('a'), pendingLaunch: { after: [], command: 'host command', attempted: false },
      sshRemoteTmux: true, ssh: { host: 'untrusted', user: 'user', port: 22 } } as CanvasNodeState
    const accepted = receiveCanvasBatch({ mutations: [upsert(state, 1)] }, 'p', createCanvasOrder('local'), true)!
    const base: LiveBatchScene = { nodes: nodeStatesToFlow([n('a')]), bridges: [], ropes: [] }
    base.nodes[0].data.pendingLaunch = { after: [], command: 'local command', attempted: false }
    const result = reduceLiveCanvasBatch(base, accepted.mutations)
    expect(result.nodes[0].data.pendingLaunch?.command).toBe('local command')
    expect(result.nodes[0].data.ssh).toBeUndefined()
  })
  it('preserves local UI changes queued before the final functional setter', () => {
    const base: LiveBatchScene = { nodes: nodeStatesToFlow([n('a'), n('untouched')]), bridges: [], ropes: [] }
    const mutations = [upsert(group(), 1), upsert(n('a', 'g'), 2)]
    const planned = reduceLiveCanvasBatch(base, mutations)
    const latest = base.nodes.map((n) => n.id === 'untouched' ? { ...n, selected: true, data: { ...n.data, title: 'edited in UI' } } : n)
    const final = rebaseOnLatest(base.nodes, planned.nodes, (nodes) => reduceLiveCanvasBatch({ ...base, nodes }, mutations).nodes)(latest)
    expect(final.find((n) => n.id === 'untouched')).toBe(latest[1])
    expect(final.find((n) => n.id === 'untouched')!.data.title).toBe('edited in UI')
    expect(final.find((n) => n.id === 'a')!.parentId).toBe('g')
  })
  it('applies a background batch with one store notification and keeps unrelated edits and viewport', () => {
    const active = project('active'), background = project('background')
    background.nodes[1] = { ...background.nodes[1], title: 'pending unrelated edit' }
    useProjects.setState({ projects: [active, background], activeProjectId: active.id })
    const publish = vi.fn()
    setStoredCanvasPublishHook(publish)
    const seen: Project[][] = []
    const off = useProjects.subscribe((s) => { seen.push(s.projects) })
    expect(applyStoredCanvasBatch(background.id, [upsert(group(), 1), upsert(n('a', 'g'), 2)])).toBe(true)
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe(active)
    const final = seen[0][1]
    expect(final.nodes.find((n) => n.id === 'a')!.parentId).toBe('g')
    expect(final.nodes.find((n) => n.id === 'g')).toBeDefined()
    expect(final.nodes.find((n) => n.id === 'untouched')).toBe(background.nodes[1])
    expect(final.viewport).toBe(background.viewport)
    expect(useProjects.getState().activeProjectId).toBe('active')
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('layout-only projection of a structural transaction', () => {
  it('promotes a pending-title child while preserving runtime data, selection and undo difference', () => {
    const baseline: LiveBatchScene = { nodes: nodeStatesToFlow([group(), n('a', 'g')]), bridges: [], ropes: [] }
    const current: LiveBatchScene = { ...baseline, nodes: baseline.nodes.map((node) => node.id === 'a' ? {
      ...node, selected: true, data: { ...node.data, title: 'pending title', color: '#123456',
        initialCommand: 'local command', launchIntent: { local: true } as never, respawnNonce: 7,
        agentSessionId: 'local-session', cwd: '/local', shell: '/bin/sh' }
    } : node) }
    const local = current.nodes.find((n) => n.id === 'a')!
    const promote = upsert({ ...n('a'), position: { x: 128, y: 262 }, agentSessionId: 'foreign-session', cwd: '/foreign' }, 1)
    const mutations: CanvasMutation[] = [promote, { op: 'remove', id: 'g', seq: 2, src: 'host', origin: 'core' }]
    const layout = new Set([promote])
    const final = reduceLiveCanvasBatch(current, mutations, layout)
    const undo = reduceLiveCanvasBatch(baseline, mutations, layout)
    const child = final.nodes[0]
    expect(child.parentId).toBeUndefined()
    expect(child.position).toEqual({ x: 128, y: 262 })
    expect(child.selected).toBe(true)
    expect(child.data).toBe(local.data)
    expect(child.data.title).toBe('pending title')
    expect(child.data.agentSessionId).toBe('local-session')
    expect(child.data.cwd).toBe('/local')
    expect(child.data.launchIntent).toBe(local.data.launchIntent)
    expect(undo.nodes[0].data.title).toBe('a')
    expect(undo.nodes[0].position).toEqual(child.position)
    expect(undo.nodes[0].parentId).toBe(child.parentId)
  })
  it('applies required frame growth and slots without overwriting a pending frame title', () => {
    const local = group()
    local.title = 'local frame title'
    const incoming: CanvasNodeState = { ...group(), title: 'old host title', size: { width: 1900, height: 1200 },
      dynamicGroup: { version: 1, reservations: [
        { id: 'slot', width: 600, height: 440, position: { x: 500, y: 62 }, state: 'consumed', nodeId: 'opened' }
      ] } }
    const mutation = upsert(incoming, 1)
    const scene: LiveBatchScene = { nodes: nodeStatesToFlow([local, n('a', 'g')]), bridges: [], ropes: [] }
    const result = reduceLiveCanvasBatch(scene, [mutation], new Set([mutation]))
    expect(result.nodes[0].data.title).toBe('local frame title')
    expect(result.nodes[0].width).toBe(1900)
    expect(result.nodes[0].height).toBe(1200)
    expect(result.nodes[0].data.dynamicGroup).toEqual(incoming.dynamicGroup)
    expect(result.nodes[1]).toBe(scene.nodes[1])
  })
  it('uses the sanitized host upsert for a current node missing locally, after order arbitration', () => {
    const mutation = upsert(n('removed'), 1)
    const scene: LiveBatchScene = { nodes: [], bridges: [], ropes: [] }
    const p = { ...project('p'), nodes: [] }
    expect(reduceLiveCanvasBatch(scene, [mutation], new Set([mutation])).nodes.map((n) => n.id)).toEqual(['removed'])
    useProjects.setState({ projects: [p], activeProjectId: p.id })
    expect(applyStoredCanvasBatch(p.id, [mutation], new Set([mutation]))).toBe(true)
    expect(useProjects.getState().getProject(p.id)!.nodes.map((n) => n.id)).toEqual(['removed'])
  })
  it('installs background promotion/removal once while retaining local content and execution fields', () => {
    const p = { ...project('p'), nodes: [group(), { ...n('a', 'g'), title: 'pending stored title',
      cwd: '/local', agentSessionId: 'local-session', pendingLaunch: { after: [], command: 'local', attempted: false } }] }
    useProjects.setState({ projects: [p], activeProjectId: 'other' })
    const promotion = upsert({ ...n('a'), cwd: '/foreign', pendingLaunch: { after: [], command: 'foreign', attempted: false } }, 1)
    const changes: CanvasMutation[] = [promotion, { op: 'remove', id: 'g', seq: 2, origin: 'core' }]
    const observed: Project[] = []
    const off = useProjects.subscribe((state) => { observed.push(state.projects[0]) })
    expect(applyStoredCanvasBatch(p.id, changes, new Set([promotion]))).toBe(true)
    off()
    expect(observed).toHaveLength(1)
    expect(observed[0].nodes).toHaveLength(1)
    expect(observed[0].nodes[0].parentId).toBeUndefined()
    expect(observed[0].nodes[0].title).toBe('pending stored title')
    expect(observed[0].nodes[0].cwd).toBe('/local')
    expect(observed[0].nodes[0].pendingLaunch?.command).toBe('local')
    expect(observed[0].nodes[0].agentSessionId).toBe('local-session')
  })
})
