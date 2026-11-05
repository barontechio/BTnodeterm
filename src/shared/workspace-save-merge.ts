// Rebase one owner's save onto the host's current workspace. Only changes since that
// owner's baseline belong to the save; omitted concurrent additions are not deletions.
import { stableStringify } from './canvas-mutations'
import { applyKanbanOp, diffKanbanOps } from './kanban-ops'
import { groupsFirst } from './node-order'
import type { Project, ProjectKanban, Workspace } from './types'

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b)

/** Fields are atomic: changing a position replaces that position, not an unrelated title. */
function fields<T extends object>(base: T, next: T, current: T, skip: readonly string[] = []): T {
  const entries = new Map(Object.entries(current))
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (skip.includes(key)) continue
    const before = (base as Record<string, unknown>)[key]
    const wanted = (next as Record<string, unknown>)[key]
    if (same(before, wanted)) continue
    if (Object.hasOwn(next, key)) entries.set(key, structuredClone(wanted))
    else entries.delete(key)
  }
  return Object.fromEntries(entries) as T
}

function items<T extends { id: string }>(
  base: readonly T[], next: readonly T[], current: readonly T[],
  merge: (before: T, wanted: T, fresh: T) => T
): T[] {
  const before = new Map(base.map((x) => [x.id, x]))
  const fresh = new Map(current.map((x) => [x.id, x]))
  const result: T[] = []
  const seen = new Set<string>()
  for (const wanted of next) {
    if (seen.has(wanted.id)) throw new Error(`workspace-save-duplicate-id: ${wanted.id}`)
    seen.add(wanted.id)
    const old = before.get(wanted.id)
    const now = fresh.get(wanted.id)
    // The host deleted it after this writer loaded it. A stale edit cannot resurrect it.
    if (old && !now) continue
    if (!old && now && !same(wanted, now)) {
      throw new Error(`workspace-save-conflict: concurrent creation of ${wanted.id}; reload before retrying`)
    }
    result.push(old && now ? merge(old, wanted, now) : structuredClone(now ?? wanted))
  }
  // A current item absent from the baseline was added by another writer, not deleted by this one.
  for (const now of current) if (!seen.has(now.id) && !before.has(now.id)) result.push(structuredClone(now))
  const oldOrder = base.filter((x) => seen.has(x.id) && fresh.has(x.id)).map((x) => x.id)
  const requestedOrder = next.filter((x) => before.has(x.id) && fresh.has(x.id)).map((x) => x.id)
  if (!same(oldOrder, requestedOrder)) return result // This writer explicitly reordered existing items.
  const kept = new Map(result.map((x) => [x.id, x]))
  const ordered = current.filter((x) => kept.has(x.id)).map((x) => kept.get(x.id)!)
  // Place new items by their next surviving neighbor without undoing a concurrent reorder.
  let successor: string | undefined
  for (let i = next.length - 1; i >= 0; i--) {
    const x = next[i]
    if (!kept.has(x.id)) continue
    if (!fresh.has(x.id)) {
      const at = successor ? ordered.findIndex((o) => o.id === successor) : ordered.length
      ordered.splice(at, 0, kept.get(x.id)!)
    }
    successor = x.id
  }
  return ordered
}

function board(base: ProjectKanban | undefined, next: ProjectKanban | undefined,
  current: ProjectKanban | undefined, projectId: string, nodeIds: ReadonlySet<string>): ProjectKanban | undefined {
  if (same(base, next)) return structuredClone(current)
  if (!next) return undefined
  let out = current
  for (const op of diffKanbanOps(base, next, projectId, nodeIds)) out = applyKanbanOp(out, op, projectId)
  if (!out) return structuredClone(next)
  return fields(base ?? { columns: [], assignments: [] }, next, out,
    ['columns', 'assignments', 'meta', 'labels', 'views'])
}

function project(base: Project, next: Project, current: Project, governed: boolean): Project {
  if (current.unavailable && !same(base, next)) {
    throw new Error(`workspace-save-unavailable: ${next.id}; resolve the project file before saving`)
  }
  // An unavailable placeholder never contributes a deletion or content replacement.
  if (next.unavailable) return structuredClone(current)
  const out = fields(base, next, current, ['nodes', 'bridges', 'ropes', 'kanban'])
  // The authority already merges content ops and must receive the owner's exec overlay unchanged.
  if (governed) return { ...out, nodes: next.nodes, bridges: next.bridges, ropes: next.ropes, kanban: next.kanban }
  out.nodes = groupsFirst(items(base.nodes, next.nodes, current.nodes, (old, wanted, fresh) => {
    if ((old.parentId ?? null) !== (fresh.parentId ?? null) &&
        (old.parentId ?? null) === (wanted.parentId ?? null) && !same(old.position, wanted.position)) {
      throw new Error(`workspace-save-conflict: ${wanted.id} changed coordinate frames; reload before retrying`)
    }
    return fields(old, wanted, fresh)
  }))
  const nodeIds = new Set(out.nodes.map((n) => n.id))
  const removed = new Set(base.nodes.filter((n) => !nodeIds.has(n.id)).map((n) => n.id))
  for (const n of out.nodes) if (n.parentId && removed.has(n.parentId)) {
    throw new Error(`workspace-save-conflict: parent ${n.parentId} was removed; reload before retrying`)
  }
  for (const key of ['bridges', 'ropes'] as const) {
    const edges = items(base[key] ?? [], next[key] ?? [], current[key] ?? [], fields)
      .filter((e) => !removed.has(e.source) && !removed.has(e.target))
    if (edges.length || current[key] !== undefined || next[key] !== undefined) out[key] = edges
    else delete out[key]
  }
  const merged = board(base.kanban, next.kanban, current.kanban, next.id, nodeIds)
  if (merged === undefined) delete out.kanban
  else out.kanban = merged
  return out
}

export function mergeWorkspaceSave(base: Workspace, next: Workspace, current: Workspace,
  governs: (id: string) => boolean = () => false): Workspace {
  const projects = items(base.projects, next.projects, current.projects,
    (a, b, c) => project(a, b, c, governs(b.id)))
  const active = next.activeProjectId === base.activeProjectId ? current.activeProjectId : next.activeProjectId
  return {
    version: 2,
    activeProjectId: active && !projects.some((p) => p.id === active)
      ? (projects.some((p) => p.id === current.activeProjectId) ? current.activeProjectId : projects[0]?.id ?? '')
      : active,
    projects
  }
}

/** Persistence comparison is independent of JSON object key order. */
export function sameWorkspaceSave(a: Workspace, b: Workspace): boolean {
  return same(a, b)
}
