import type { Edge } from '@xyflow/react'
import type { BridgeLink, CanvasApi, CanvasMutation, CanvasNodeState, Project } from '@shared/types'
import type { CanvasOrder } from '@shared/canvas-order'
import { applyCanvasOp, contentOf } from '@shared/canvas-content'
import { applyCanvasLayout, canvasLayoutOf, isCanvasMutationBatch } from '@shared/canvas-batch'
import { applyEdgeMutationToScene } from '@shared/canvas-mutations'
import { receivedCanvasMutation } from '../session/relay-ssh'
import { applyMutationToFlow, applyDynamicLayoutToFlow, flowToNodeStates, groupsFirst, type CanvasNode } from '../state/workspace'
import { normalizeDynamicGroupState } from '@shared/dynamic-groups'
import { bridgeToEdge, edgeToBridge } from '../lib/noteLink'
import { useProjects } from '../state/projects'

/** Receive-only envelope guard, matching the host's bounded, flat batch contract. */
export function receiveCanvasBatch(value: unknown, projectId: string, order: CanvasOrder, relay: boolean): {
  mutations: CanvasMutation[]; layoutOnly: ReadonlySet<CanvasMutation>; received: CanvasMutation[]; released: boolean
} | undefined {
  if (!isCanvasMutationBatch(value)) return undefined
  // Validate EVERY child before advancing any order/ack state.
  const received = value.mutations.map((m) => receivedCanvasMutation(m, relay))
  const held = order.pendingRemoveCount()
  const layoutOnly = new Set<CanvasMutation>()
  const mutations = received.filter((m) => {
    const decision = order.acceptBatch(m, projectId)
    if (decision === 'layout') layoutOnly.add(m)
    return decision !== 'drop'
  })
  return { mutations, layoutOnly, received, released: order.pendingRemoveCount() < held }
}

/** A structural transaction owns geometry, not ordinary content or local execution data. */
export function projectBatchLayout(local: CanvasNodeState, incoming: CanvasNodeState): CanvasNodeState {
  const projected = applyCanvasLayout(local, canvasLayoutOf(incoming))
  return { ...projected, dynamicGroup: projected.kind === 'group'
    ? normalizeDynamicGroupState(projected.dynamicGroup) : undefined }
}

export function applyBatchMutationToFlow(nodes: CanvasNode[], mutation: CanvasMutation, layoutOnly = false): CanvasNode[] {
  if (!layoutOnly) return applyMutationToFlow(nodes, mutation)
  if (mutation.op !== 'upsert') return nodes
  const prev = nodes.find((n) => n.id === mutation.node.id)
  // Order already rejected tombstoned/stale nodes. A current host node missing locally takes
  // the ordinary sanitized upsert path, as the shared batch contract requires.
  if (!prev) return applyMutationToFlow(nodes, mutation)
  const before = flowToNodeStates([prev])[0]
  const projected = projectBatchLayout(before, mutation.node)
  if (projected.kind !== before.kind) return applyMutationToFlow(nodes, { ...mutation, node: projected })
  const next = applyDynamicLayoutToFlow([prev], [projected])[0]
  if (next === prev) return nodes
  const patched = nodes.map((n) => n === prev ? next : n)
  return prev.parentId === next.parentId ? patched : groupsFirst(patched)
}

export function reduceStoredCanvasBatch(project: Project, mutations: readonly CanvasMutation[], layoutOnly: ReadonlySet<CanvasMutation> = new Set()): Project {
  const before = contentOf(project)
  const after = mutations.reduce((content, m) => {
    if (!layoutOnly.has(m)) return applyCanvasOp(content, m, project.id)
    if (m.op !== 'upsert') return content
    const local = content.nodes.find((n) => n.id === m.node.id)
    return applyCanvasOp(content, local ? { ...m, node: projectBatchLayout(local, m.node) } : m, project.id)
  }, before)
  if (after === before) return project
  return { ...project,
    ...(after.nodes !== before.nodes ? { nodes: after.nodes } : {}),
    ...(after.bridges !== before.bridges ? { bridges: after.bridges } : {}),
    ...(after.ropes !== before.ropes ? { ropes: after.ropes } : {}),
    ...(after.kanban !== before.kanban ? { kanban: after.kanban } : {}) }
}

/** Fold into the latest store snapshot and notify subscribers once, without either publish hook. */
export function applyStoredCanvasBatch(projectId: string, mutations: readonly CanvasMutation[], layoutOnly: ReadonlySet<CanvasMutation> = new Set()): boolean {
  let changed = false
  useProjects.setState((state) => {
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) return state
    const next = reduceStoredCanvasBatch(project, mutations, layoutOnly)
    if (next === project) return state
    changed = true
    return { projects: state.projects.map((p) => p.id === projectId ? next : p) }
  })
  return changed
}

export interface LiveBatchScene { nodes: CanvasNode[]; bridges: Edge[]; ropes: Edge[] }
const rope = (e: BridgeLink): Edge => ({ id: e.id, source: e.source, target: e.target, type: 'floating' })

/** Detached reduction: no node/edge setter, callback, publisher or store observes a child op. */
export function reduceLiveCanvasBatch(scene: LiveBatchScene, mutations: readonly CanvasMutation[], layoutOnly: ReadonlySet<CanvasMutation> = new Set()): LiveBatchScene {
  const nodes = mutations.reduce((nodes, m) => applyBatchMutationToFlow(nodes, m, layoutOnly.has(m)), scene.nodes)
  const before = { bridges: scene.bridges.map(edgeToBridge), ropes: scene.ropes.map((e): BridgeLink => ({ id: e.id, source: e.source, target: e.target })) }
  const after = mutations.reduce((edges, m) => layoutOnly.has(m) ? edges : applyEdgeMutationToScene(edges, m), before)
  const keep = (previous: Edge[], e: BridgeLink, bridge: boolean): Edge => {
    const old = previous.find((held) => held.id === e.id && held.source === e.source && held.target === e.target)
    if (old && (!bridge || edgeToBridge(old).reader === e.reader)) return old
    const next = bridge ? bridgeToEdge(e) : rope(e)
    return old ? { ...next, selected: old.selected } : next
  }
  const bridges = after.bridges === before.bridges ? scene.bridges : after.bridges.map((e) => keep(scene.bridges, e, true))
  const ropes = after.ropes === before.ropes ? scene.ropes : after.ropes.map((e) => keep(scene.ropes, e, false))
  return nodes === scene.nodes && bridges === scene.bridges && ropes === scene.ropes ? scene : { nodes, bridges, ropes }
}

/** Advertise support only while the actual receiver is mounted. One callback per valid envelope. */
export function subscribeCanvasBatches(api: Pick<CanvasApi, 'onMutationBatch'>, options: {
  order(): CanvasOrder | null
  relay: boolean
  apply(projectId: string, accepted: NonNullable<ReturnType<typeof receiveCanvasBatch>>): void
}): () => void {
  return api.onMutationBatch?.((projectId, batch) => {
    const order = options.order()
    if (!order) return
    const accepted = receiveCanvasBatch(batch, projectId, order, options.relay)
    if (accepted) options.apply(projectId, accepted)
  }) ?? (() => {})
}
