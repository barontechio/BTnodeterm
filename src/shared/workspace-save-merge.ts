// Rebase one owner's save onto the host's current workspace. Only changes since that
// owner's baseline belong to the save; omitted concurrent additions are not deletions.
import { stableStringify } from './canvas-mutations'
import { applyKanbanOp, diffKanbanOps } from './kanban-ops'
import { groupsFirst } from './node-order'
import type { BridgeLink, CanvasNodeState, Project, ProjectKanban, Workspace } from './types'

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

/**
 * What to do when both sides hold an id the writer's baseline lacks. A project id can really collide
 * (one folder added twice), so by default that is refused. A node id is random and an edge id is built
 * from its endpoints, so there the writer got it from the host, through an op or a server-change:
 * `adopted` says what to keep. Refusing there failed this save and all later ones, because a baseline
 * only moves when a save lands.
 */
function items<T extends { id: string }>(
  base: readonly T[], next: readonly T[], current: readonly T[],
  merge: (before: T, wanted: T, fresh: T) => T,
  adopted?: (wanted: T, fresh: T) => T
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
      if (!adopted) throw new Error(`workspace-save-conflict: concurrent creation of ${wanted.id}; reload before retrying`)
      result.push(adopted(wanted, now))
      continue
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

/**
 * A node this writer adopted from the host: the host's copy stays, because the writer's copy may
 * predate it, and `baselineAfterSave` lets the writer's own changes through on its next save. Only a
 * launch claim cannot wait: the claimant reads a landed save as "durable, safe to type". It moves one
 * way, so this save cannot undo a host that already cleared or claimed the launch.
 */
function adoptedNode(wanted: CanvasNodeState, fresh: CanvasNodeState): CanvasNodeState {
  const held = fresh.pendingLaunch
  const claim = wanted.pendingLaunch
  const claimed = !!held && !held.attempted && !!claim?.attempted && claim.command === held.command
  return structuredClone(claimed ? { ...fresh, pendingLaunch: claim } : fresh)
}

/** As `adoptedNode`, and a one-way `reader` cannot wait either: without it the link reads both ways. */
function adoptedEdge(wanted: BridgeLink, fresh: BridgeLink): BridgeLink {
  return structuredClone(fresh.reader === undefined && wanted.reader !== undefined
    ? { ...fresh, reader: wanted.reader }
    : fresh)
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
  }, adoptedNode))
  const nodeIds = new Set(out.nodes.map((n) => n.id))
  const removed = new Set(base.nodes.filter((n) => !nodeIds.has(n.id)).map((n) => n.id))
  // A frame gone from this save can leave a child behind: one the writer took out itself, or one it
  // never saw (a node opened into the frame while it was being removed). Refusing failed this save and
  // all later ones, so the child moves up instead, as removing a frame moves its children.
  for (const n of out.nodes) {
    if (!n.parentId || !removed.has(n.parentId)) continue
    const wanted = next.nodes.find((candidate) => candidate.id === n.id)
    if (wanted && !(wanted.parentId && removed.has(wanted.parentId))) {
      n.position = structuredClone(wanted.position)
      if (wanted.parentId) n.parentId = wanted.parentId
      else delete n.parentId
      continue
    }
    const seen = new Set<string>()
    while (n.parentId && removed.has(n.parentId) && !seen.has(n.parentId)) {
      seen.add(n.parentId)
      const frame = current.nodes.find((c) => c.id === n.parentId) ?? base.nodes.find((c) => c.id === n.parentId)
      n.position = { x: n.position.x + (frame?.position.x ?? 0), y: n.position.y + (frame?.position.y ?? 0) }
      if (frame?.parentId) n.parentId = frame.parentId
      else delete n.parentId
    }
    if (n.parentId && removed.has(n.parentId)) delete n.parentId // A frame cycle in a hand-edited file.
  }
  out.nodes = groupsFirst(out.nodes)
  for (const key of ['bridges', 'ropes'] as const) {
    const edges = items(base[key] ?? [], next[key] ?? [], current[key] ?? [], fields, adoptedEdge)
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

/**
 * The base an adopted item's next save is diffed against, built so a difference can only mean the
 * writer changed something:
 * - A key the writer's copy lacks stays out, or its absence would read as a deletion. An op never
 *   carries a node's `shell` or `ssh.extraArgs` (node-exec.ts), and a copy can lag the host.
 * - A key in `own` takes the writer's own value, because its copy cannot speak for it: exec fields, a
 *   launch the host may already have claimed or cleared, a one-way `reader`.
 * - Otherwise the key takes the host's value, so what the writer changed lands whole, and a value only
 *   the writer holds (not in this base) lands as an addition.
 * - `always` keys come from the host even if the writer lacks them: leaving a frame is a real change.
 */
function adoptedBaseline<T extends object>(mine: T, host: T, own: readonly string[], always: readonly string[] = []): T {
  const m = mine as Record<string, unknown>
  const h = host as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(m)) {
    if (own.includes(key)) out[key] = m[key]
    else if (Object.hasOwn(h, key)) out[key] = h[key]
  }
  for (const key of always) if (Object.hasOwn(h, key)) out[key] = h[key]
  return structuredClone(out) as T
}

/**
 * The writer's baseline once its save landed: what it submitted, except for items it adopted in this
 * save. See `adoptedBaseline`. Using its own copy for those would make its earlier edits look already
 * saved, and a host copy in another frame would refuse its next move for good.
 */
export function baselineAfterSave(base: Workspace, submitted: Workspace, merged: Workspace): Workspace {
  const out = structuredClone(submitted)
  for (const project of out.projects) {
    const before = base.projects.find((p) => p.id === project.id)
    const landed = merged.projects.find((p) => p.id === project.id)
    if (!before || !landed) continue
    const rebase = <T extends { id: string }>(mine: T[], old: readonly T[], host: readonly T[], make: (m: T, h: T) => T): T[] =>
      mine.map((x) => {
        const copy = old.some((o) => o.id === x.id) ? undefined : host.find((h) => h.id === x.id)
        return copy ? make(x, copy) : x
      })
    const held = new Set(project.nodes.map((n) => n.id))
    project.nodes = rebase(project.nodes, before.nodes, landed.nodes, (m, h) => {
      const node = adoptedBaseline(m, h, ['shell', 'ssh', 'pendingLaunch'], ['parentId'])
      // Its copy still names a frame it removed, and this save moved the node up. That placement
      // means nothing to the host, so it must not read as a move on the next save.
      if (m.parentId && !held.has(m.parentId)) {
        node.parentId = m.parentId
        node.position = structuredClone(m.position)
      }
      return node
    })
    const edge = (m: BridgeLink, h: BridgeLink): BridgeLink => adoptedBaseline(m, h, ['reader'])
    if (project.bridges) project.bridges = rebase(project.bridges, before.bridges ?? [], landed.bridges ?? [], edge)
    if (project.ropes) project.ropes = rebase(project.ropes, before.ropes ?? [], landed.ropes ?? [], edge)
  }
  return out
}

/** Persistence comparison is independent of JSON object key order. */
export function sameWorkspaceSave(a: Workspace, b: Workspace): boolean {
  return same(a, b)
}
