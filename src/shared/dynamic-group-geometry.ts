// Adapter only: legacy geometry commands and dynamic groups use one layout implementation.
import { nodeW, nodeH, type GeometryNode } from './canvas-geometry'
import { planDynamicGroups, reconcileDynamicGroups } from './dynamic-groups'
import { COLLAPSED_HEIGHT } from './node-sizing'
import type { CanvasNodeState } from './types'
import { rootPositionWith } from './root-position'
import type { GeometryControlVerb, GeometryControlReply } from './geometry-command'

const stateOf = (n: GeometryNode): CanvasNodeState => ({
  id: n.id, kind: n.type ?? 'terminal', title: n.id, color: '#8b8b8b', group: null,
  position: { ...n.position }, size: { width: nodeW(n), height: n.data.collapsed ? n.data.expandedHeight ?? nodeH(n) : nodeH(n) },
  ...(n.parentId ? { parentId: n.parentId } : {}),
  ...(n.data.collapsed ? { collapsed: true } : {}),
  ...(n.data.premaxRect ? { premaxRect: { ...n.data.premaxRect } } : {}),
  ...(n.data.dynamicGroup ? { dynamicGroup: structuredClone(n.data.dynamicGroup) } : {}),
  ...(n.data.cwd ? { cwd: n.data.cwd } : {}), ...(n.data.worktree ? { worktree: n.data.worktree } : {})
})
const tuple = (n: CanvasNodeState): string => JSON.stringify([n.position, n.size, n.parentId, n.collapsed, n.premaxRect, n.dynamicGroup])

/** Only gestures in a managed subtree or an enclosing frame opt into managed reconciliation. */
export function managedGeometryChanges(before: readonly CanvasNodeState[], after: readonly CanvasNodeState[], changed: readonly string[]): string[] {
  const oldById = new Map(before.map((n) => [n.id, n])), nextById = new Map(after.map((n) => [n.id, n]))
  const chain = (id: string, map: Map<string, CanvasNodeState>) => {
    const ids = new Set<string>(); let n = map.get(id)
    while (n && !ids.has(n.id)) { ids.add(n.id); n = n.parentId ? map.get(n.parentId) : undefined }
    return ids
  }
  const managed = [...before, ...after].filter((n) => n.dynamicGroup)
  return changed.filter((id) => {
    const oldChain = chain(id, oldById), newChain = chain(id, nextById)
    return managed.some((g) => oldChain.has(g.id) || newChain.has(g.id) ||
      chain(g.id, oldById).has(id) || chain(g.id, nextById).has(id))
  })
}

/** Preserve every renderer/runtime field; only the shared planner's visual projection crosses. */
function project<N extends GeometryNode>(original: N[], states: CanvasNodeState[]): N[] {
  const byId = new Map(original.map((n) => [n.id, n]))
  return states.map((s) => {
    const n = byId.get(s.id)!
    if (tuple(stateOf(n)) === tuple(s)) return n
    const height = s.collapsed ? COLLAPSED_HEIGHT : s.size.height
    return { ...n, position: { ...s.position }, parentId: s.parentId,
      ...(s.parentId ? { extent: 'parent' } : { extent: undefined }),
      width: s.size.width, height,
      ...(n.measured ? { measured: { ...n.measured, width: s.size.width, height } } : {}),
      ...(n.style ? { style: { ...n.style, width: s.size.width, height } } : {}),
      data: { ...n.data, dynamicGroup: s.dynamicGroup, expandedHeight: s.size.height, premaxRect: s.premaxRect } }
  })
}

export function finishDynamicGeometry<N extends GeometryNode>(verb: GeometryControlVerb, args: Record<string, string>,
  before: N[], planned: N[], reply: GeometryControlReply, grid: number):
  { nodes: N[]; changed: boolean; reply: GeometryControlReply; required?: string[] } {
  const fail = (error: string) => ({ nodes: before, changed: false, reply: { ok: false, error } })
  if (!reply.ok || before === planned || !before.some((n) => n.data.dynamicGroup)) {
    return { nodes: planned, changed: planned !== before, reply }
  }
  const old = before.map(stateOf), next = planned.map(stateOf)
  const oldById = new Map(old.map((n) => [n.id, n])), nextById = new Map(next.map((n) => [n.id, n]))
  const changed = old.filter((n) => !nextById.has(n.id) || tuple(n) !== tuple(nextById.get(n.id)!)).map((n) => n.id)
  const chain = (id: string, map: Map<string, CanvasNodeState>) => {
    const ids = new Set<string>(); let n = map.get(id)
    while (n && !ids.has(n.id)) { ids.add(n.id); n = n.parentId ? map.get(n.parentId) : undefined }
    return ids
  }
  const managed = old.filter((n) => n.dynamicGroup)
  const relevant = managedGeometryChanges(old, next, changed)
  if (!relevant.length) return { nodes: planned, changed: true, reply }
  let result
  if (verb === 'move') {
    const members = old.filter((n) => nextById.has(n.id) && n.parentId !== nextById.get(n.id)!.parentId)
      .map((n) => ({ id: n.id, group: nextById.get(n.id)!.parentId ?? null }))
    result = planDynamicGroups(old, { version: 1, groups: [], members, reserve: [], release: [], remove: [] }, { grid })
  } else if (verb === 'ungroup') {
    const frame = oldById.get(args.group.trim())
    result = planDynamicGroups(old, { version: 1, groups: [], members: [], reserve: [], release: [],
      remove: [{ id: frame!.id, promoteTo: frame!.parentId ?? null }] }, { grid })
  } else {
    // Legacy fitting can shrink manually enlarged frames; managed frames and their ancestors grow.
    for (const g of managed) for (const id of chain(g.id, oldById)) {
      const n = nextById.get(id), was = oldById.get(id)!
      if (n) n.size = { width: Math.max(n.size.width, was.size.width), height: Math.max(n.size.height, was.size.height) }
    }
    result = reconcileDynamicGroups(next, relevant.filter((id) => nextById.has(id)), { grid })
  }
  if (!result.ok) return fail(result.error)
  const nodes = project(planned, result.nodes)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const layout = result.nodes.filter((n) => !oldById.has(n.id) || tuple(n) !== tuple(oldById.get(n.id)!)).map((n) => ({
    id: n.id, parent: n.parentId ?? null, position: n.position, size: n.size,
    rootPosition: rootPositionWith(byId.get(n.id)!, (id) => byId.get(id)) }))
  const actual = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return entry
    const n = byId.get(entry.id)
    return n ? { ...entry, ...rootPositionWith(n, (id) => byId.get(id)) } : entry
  }
  return { nodes, changed: nodes.some((n, i) => n !== before[i]) || nodes.length !== before.length,
    required: result.required, reply: { ...reply,
      message: `${verb} applied with managed-group layout: ${JSON.stringify(layout)}`,
      result: { ...reply.result, ...(Array.isArray(reply.result?.placed) ? { placed: reply.result.placed.map(actual) } : {}), managedLayout: layout } } }
}
