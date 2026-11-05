// Pure geometry over a structural node shape, shared by Desktop and Server.
// React Flow supplies measurements in the renderer; headless callers supply persisted dimensions.
import type { NodeKind } from './types'
import { NODE_SIZE_MAX } from './default-node-size'
import { groupsFirstBy } from './node-order'
import { rootPositionWith } from './root-position'
import { openerByTarget, recordedOpenerOf } from './canvas-lineage'
import {
  COLLAPSED_HEIGHT, COLLAPSED_FALLBACK_HEIGHT, expandRectToGrid, NODE_MIN_SIZES, type Rect
} from './node-sizing'

export interface GeometryNodeData {
  collapsed?: boolean
  expandedHeight?: number
  premaxRect?: Rect
  openedBy?: unknown
}

export interface GeometryNode {
  id: string
  type?: NodeKind
  parentId?: string
  position: { x: number; y: number }
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  style?: { width?: number | string; height?: number | string }
  data: GeometryNodeData
  extent?: unknown
  selected?: boolean
}

/** Clearance a group frame keeps around its children on every side, and the extra strip above
 *  them for its label pill. Exported so anything that has to size a frame the way
 *  `fitGroupToChildren` does (canvas layouts grow a restored frame around nodes the layout
 *  predates) matches it exactly instead of re-guessing the numbers. */
export const GROUP_PAD = 28
export const GROUP_HEADER = 34

export const nodeW = (n: GeometryNode) => n.measured?.width ?? (n.width as number) ?? 0
export const nodeH = (n: GeometryNode) => n.measured?.height ?? (n.height as number) ?? 0

/**
 * Geometry for a frame that has to wrap `bounds`, with its label header above. `bounds` and the
 * result are both in the space of the frame's own container, which is where `parentId` points.
 *
 * With `grid` on, the frame is placed on the grid AT CREATION instead of being left off-grid for
 * every later resize to compensate: the padding is raised to at least one cell and the box then
 * grows OUTWARD to the surrounding grid lines, so all four edges land on the grid and the
 * clearance around the children can only increase. Snapping runs in ROOT space, because React
 * Flow snaps a drag there too — rounding this container-relative box directly would put a nested
 * frame on its parent's grid, which is the defect the rest of this change removes.
 *
 * `grid <= 0` (snapping off) reproduces the original fixed-padding box exactly.
 */
export function groupBox<N extends GeometryNode>(
  nodes: N[],
  parentId: string | undefined,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  grid: number
): Rect {
  const pad = grid > 0 ? Math.max(GROUP_PAD, grid) : GROUP_PAD
  const rect: Rect = {
    x: bounds.minX - pad,
    y: bounds.minY - pad - GROUP_HEADER,
    width: bounds.maxX - bounds.minX + pad * 2,
    height: bounds.maxY - bounds.minY + pad * 2 + GROUP_HEADER
  }
  if (grid <= 0) return rect
  const origin = containerOrigin(parentId, nodes)
  const snapped = expandRectToGrid(grid, 'group', {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height
  })
  return {
    x: snapped.x - origin.x + 0,
    y: snapped.y - origin.y + 0,
    width: snapped.width,
    height: snapped.height
  }
}

import type { ArrangeLayout, GroupArrangeLayout } from './arrange-verb'
import { ARRANGE_GAP_DEFAULT } from './arrange-verb'
export type { ArrangeLayout, GroupArrangeLayout }
export { GROUP_ARRANGE_LAYOUTS } from './arrange-verb'

/**
 * The single container the given ids all live in: `null` (all top-level), a group id (all
 * children of that one group), or `undefined` when they resolve to no node OR span more than
 * one container (a group's children mixed with top-level, or two different groups). Positions
 * are only comparable within one container — top-level positions are absolute, a group child's
 * are relative to its frame — so arrange/align refuse a mixed set rather than scramble it.
 */
export function commonParentId<N extends GeometryNode>(nodes: N[], ids: string[]): string | null | undefined {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id))
  if (members.length === 0) return undefined
  const parents = new Set(members.map((m) => m.parentId ?? null))
  return parents.size === 1 ? members[0].parentId ?? null : undefined
}

/**
 * Repositions the given ids into a non-overlapping layout starting at `origin` (default: the
 * bounding-box top-left of their current positions). 'row' packs left-to-right, 'column'
 * top-to-bottom, 'grid' wraps at `cols` (default ~square) with each row advancing by its tallest
 * member. The ids must share ONE container — all top-level, or all children of the same group
 * (the layout then runs in that group's coordinate space); a mixed set is a no-op. Unknown ids
 * are skipped; returns the input array unchanged when nothing resolves. Pure and deterministic.
 *
 * **Slots are filled in the order of `ids`, not in array order.** Every caller that sorts its ids
 * is stating the order it wants — `Tidy canvas` by reading order, a lineage band by the slot of
 * each node's opener — and the array order is persistence order (frames first, then creation),
 * which is nobody's intent. Placing by array order silently discarded both sorts.
 */
export function arrangeNodes<N extends GeometryNode>(
  nodes: N[],
  ids: string[],
  opts?: { layout?: ArrangeLayout; cols?: number; gap?: number; origin?: { x: number; y: number } }
): N[] {
  let byId = new Map(nodes.map((nd) => [nd.id, nd]))
  let members = [...new Set(ids)].flatMap((id) => byId.get(id) ?? [])
  // Only meaningful within one coordinate space (see commonParentId) — mixed containers → no-op.
  if (members.length === 0 || new Set(members.map((m) => m.parentId ?? null)).size > 1) return nodes
  const memberIds = new Set(members.map((m) => m.id))
  nodes = restoreMaximizedWhere(nodes, (nd) => memberIds.has(nd.id))
  byId = new Map(nodes.map((nd) => [nd.id, nd]))
  members = [...memberIds].flatMap((id) => byId.get(id) ?? [])
  const layout = opts?.layout ?? 'grid'
  const gap = opts?.gap ?? ARRANGE_GAP_DEFAULT
  const origin = opts?.origin ?? {
    x: Math.min(...members.map((m) => m.position.x)),
    y: Math.min(...members.map((m) => m.position.y))
  }
  const cols =
    layout === 'row' ? members.length : layout === 'column' ? 1 : Math.max(1, opts?.cols ?? Math.ceil(Math.sqrt(members.length)))

  const pos = new Map<string, { x: number; y: number }>()
  let x = origin.x
  let y = origin.y
  let rowH = 0
  members.forEach((m, i) => {
    if (i > 0 && i % cols === 0) {
      x = origin.x
      y += rowH + gap
      rowH = 0
    }
    pos.set(m.id, { x, y })
    x += nodeW(m) + gap
    rowH = Math.max(rowH, nodeH(m))
  })
  return nodes.map((nd) => (pos.has(nd.id) ? { ...nd, position: pos.get(nd.id)! } : nd))
}

/**
 * One lineage rope, as the canvas persists it (`project.ropes`): "opened by" or a wait (`--after`).
 * The `id` is what tells the two apart (`waitRopeId`, lib/edgeModel): pass it through, or every
 * rope reads as an opener rope.
 */
export interface LineageEdge {
  id?: string
  source: string
  target: string
}

/** Every node's opener (rule 1 of lib/teamProgress — `data.openedBy` first, else the first opener
 *  rope into it; wait ropes never), keyed by the opened node's id. */
function openersOf<N extends GeometryNode>(nodes: N[], edges: readonly LineageEdge[]): Map<string, string> {
  const byId = new Map(nodes.map((nd) => [nd.id, nd]))
  return openerByTarget(edges, (id) => recordedOpenerOf(byId.get(id)))
}

/**
 * For every node INSIDE `containerId` (`null` = the top level), the direct member of that
 * container it belongs to, by id. A rope points at the NODE an agent opened, which is routinely a
 * node inside a frame — and a frame moves as one rigid unit, so a layer layout has to ask which
 * member of the container being arranged that rope really reaches. A node outside the container,
 * a parentId naming no live node and a cycle (project.json is hand-editable) are simply absent
 * from the map, so a rope touching one is dropped rather than throwing.
 */
function containerAncestors<N extends GeometryNode>(nodes: N[], containerId: string | null): Map<string, string> {
  const byId = new Map(nodes.map((nd) => [nd.id, nd]))
  const out = new Map<string, string>()
  for (const nd of nodes) {
    let cur: N | undefined = nd
    const seen = new Set<string>([nd.id])
    while (cur && (cur.parentId ?? null) !== containerId) {
      const parent: N | undefined = cur.parentId ? byId.get(cur.parentId) : undefined
      cur = parent && !seen.has(parent.id) ? parent : undefined
      if (cur) seen.add(cur.id)
    }
    if (cur) out.set(nd.id, cur.id)
  }
  return out
}

/**
 * Splits the members of ONE container into lineage layers: layer 0 is every node nothing opened,
 * layer k is a node whose deepest opener sits in layer k-1, and `loose` holds the nodes no rope
 * touches at all. The container is the top level by default (`containerId` null) or a group frame,
 * whose DIRECT children are then the members — the same rules one level down, which is what lets
 * a frame's own contents be arranged by lineage.
 *
 * Three rules, each of which the naive version gets wrong:
 *
 * - **Ropes are LIFTED to the member that holds them.** The coordinator opens a team INSIDE a
 *   frame, so the rope ends on a child; the frame is what gets placed. An edge whose two ends lift
 *   to the same object is dropped — it is internal to that frame and would otherwise make it its
 *   own opener. An edge with an end OUTSIDE the container is dropped too: the opener of a frame's
 *   whole team usually sits outside the frame, and it says nothing about the order inside.
 * - **A node's layer is its LONGEST path from a root**, not its first: with `max` every rope points
 *   strictly downward, which is the whole reason the layout reads as a flow. Taking the shortest
 *   path would let a rope run backwards up the canvas.
 * - **A cycle never hangs and never throws.** Ropes are "opened by" and `--after`, so a cycle is
 *   not supposed to exist, but `--after` can be hand-built into one and project.json is editable.
 *   The edge that closes a cycle contributes nothing (`0`), so the result stays deterministic for
 *   a given edge order instead of recursing forever.
 *
 * `loose` is deliberately NOT layer 0: a node with no lineage is not a root of anything, and
 * mixing the two would put every sticky note beside the coordinator.
 */
export function lineageLayers<N extends GeometryNode>(
  nodes: N[],
  edges: readonly LineageEdge[],
  containerId: string | null = null
): { layers: string[][]; loose: string[] } {
  const tops = containerAncestors(nodes, containerId)
  // Named for the default container; with `containerId` set these are that frame's children.
  const topLevel = nodes.filter((nd) => (nd.parentId ?? null) === containerId)
  const live = new Set(topLevel.map((nd) => nd.id))

  const preds = new Map<string, string[]>()
  const touched = new Set<string>()
  for (const e of edges) {
    const from = tops.get(e.source)
    const to = tops.get(e.target)
    if (!from || !to || from === to || !live.has(from) || !live.has(to)) continue
    const list = preds.get(to)
    if (list) {
      if (!list.includes(from)) list.push(from)
    } else {
      preds.set(to, [from])
    }
    touched.add(from)
    touched.add(to)
  }

  const memo = new Map<string, number>()
  const onStack = new Set<string>()
  const levelOf = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (onStack.has(id)) return 0
    onStack.add(id)
    let level = 0
    for (const from of preds.get(id) ?? []) level = Math.max(level, levelOf(from) + 1)
    onStack.delete(id)
    memo.set(id, level)
    return level
  }

  // Reading order of the canvas as it stands, used as the tie-break everywhere below so the
  // result is stable and roughly preserves what the user already built.
  const order = new Map<string, number>()
  ;[...topLevel]
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : 1))
    .forEach((nd, i) => order.set(nd.id, i))
  const byReadingOrder = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0)

  const layers: string[][] = []
  const loose: string[] = []
  for (const nd of topLevel) {
    if (!touched.has(nd.id)) {
      loose.push(nd.id)
      continue
    }
    const level = levelOf(nd.id)
    while (layers.length <= level) layers.push([])
    layers[level].push(nd.id)
  }

  // The member that OPENED each member (lifted like the ropes), for the slot rule below.
  const openerOfMember = new Map<string, string>()
  for (const [target, source] of openersOf(nodes, edges)) {
    const to = tops.get(target)
    const from = tops.get(source)
    if (to && from && to !== from && live.has(to) && live.has(from) && !openerOfMember.has(to)) {
      openerOfMember.set(to, from)
    }
  }

  // Inside a layer, siblings sit together: a node follows its OPENER's slot in the layer above when
  // the opener is there, else its earliest predecessor's, so the ropes fan out instead of crossing.
  // Opener first because layering reads BOTH relations (a wait is a flow edge too, and longest-path
  // keeps it pointing down) while a node has exactly one opener — the team it belongs to. A node
  // opened by B that waits on A sits under B, with the rest of B's team. Layer 0 and `loose` have
  // no opener to follow and keep the canvas's own reading order.
  layers.forEach((layer, level) => {
    if (level === 0) {
      layer.sort(byReadingOrder)
      return
    }
    const above = new Map(layers[level - 1].map((id, i) => [id, i]))
    const slotOf = (id: string): number => {
      const opener = openerOfMember.get(id)
      const openerSlot = opener !== undefined ? above.get(opener) : undefined
      if (openerSlot !== undefined) return openerSlot
      let best = Number.MAX_SAFE_INTEGER
      for (const from of preds.get(id) ?? []) {
        const slot = above.get(from)
        if (slot !== undefined && slot < best) best = slot
      }
      return best
    }
    layer.sort((a, b) => slotOf(a) - slotOf(b) || byReadingOrder(a, b))
  })
  loose.sort(byReadingOrder)
  return { layers, loose }
}

/**
 * Lays the members of one container (the top level, or `opts.containerId`'s direct children) out
 * as lineage bands: one row per layer, growing downward, with the nodes no rope touches in a final
 * band of their own. Returns the input unchanged when there is nothing to arrange (under two
 * members, or no usable rope) — an unchanged array is the caller's signal to skip the undo entry
 * and the project.json write.
 *
 * Built ON `arrangeNodes` rather than beside it: each band is one `row` placement from a shared
 * left origin, so the packing, the gap and the mixed-container refusal all stay in ONE place.
 */
export function arrangeByLineage<N extends GeometryNode>(
  nodes: N[],
  edges: readonly LineageEdge[],
  opts?: { gap?: number; origin?: { x: number; y: number }; containerId?: string | null }
): N[] {
  const containerId = opts?.containerId ?? null
  if (nodes.filter((nd) => (nd.parentId ?? null) === containerId).length < 2) return nodes
  const { layers, loose } = lineageLayers(nodes, edges, containerId)
  // No rope reached two different members: every node would land in the single `loose` band,
  // which is a worse `Tidy canvas`, not a lineage view.
  if (layers.length === 0) return nodes
  nodes = restoreMaximizedWhere(nodes, (nd) => (nd.parentId ?? null) === containerId)
  const topLevel = nodes.filter((nd) => (nd.parentId ?? null) === containerId)

  const gap = opts?.gap ?? ARRANGE_GAP_DEFAULT
  const origin = opts?.origin ?? {
    x: Math.min(...topLevel.map((nd) => nd.position.x)),
    y: Math.min(...topLevel.map((nd) => nd.position.y))
  }
  const bands = loose.length > 0 ? [...layers, loose] : layers

  let out = nodes
  let y = origin.y
  for (const band of bands) {
    if (band.length === 0) continue
    out = arrangeNodes(out, band, { layout: 'row', gap, origin: { x: origin.x, y } })
    const tallest = Math.max(...band.map((id) => nodeH(out.find((nd) => nd.id === id)!)))
    y += tallest + gap
  }
  return out
}

/** A laid-out rectangle of units, positions relative to its own top-left. */
interface TidyBlock {
  w: number
  h: number
  place: { id: string; x: number; y: number }[]
}

/** `arrangeNodes`' grid flow, over blocks: left to right, wrapping at `cols`, each row advancing
 *  by its tallest block. */
function flowBlocks(blocks: TidyBlock[], cols: number, gap: number): TidyBlock {
  const place: TidyBlock['place'] = []
  let x = 0
  let y = 0
  let rowH = 0
  let w = 0
  blocks.forEach((b, i) => {
    if (i > 0 && i % cols === 0) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    for (const p of b.place) place.push({ id: p.id, x: p.x + x, y: p.y + y })
    w = Math.max(w, x + b.w)
    x += b.w + gap
    rowH = Math.max(rowH, b.h)
  })
  return { w, h: y + rowH, place }
}

/** Reading order of the canvas as it stands — Tidy canvas's own comparator, stable on array order. */
const byReadingPosition = (a: GeometryNode, b: GeometryNode): number =>
  a.position.y - b.position.y || a.position.x - b.position.x

/**
 * **Tidy canvas.** Packs every top-level node (a group frame is one rigid unit, its children ride
 * along) into a non-overlapping layout — and keeps each ORCHESTRATOR legible: a unit that opened
 * other units is placed first, at the top-left of its own cluster, with the units it opened packed
 * in a grid directly to its right, and a unit THEY opened clustered the same way inside that grid.
 * Clusters are packed in reading order of their orchestrators; every unit with no lineage at all is
 * packed after them, below, exactly as the plain grid packs it.
 *
 * The relation is OPENER ONLY (rule 1 of lib/teamProgress, through `openerByTarget`: the node's
 * recorded `data.openedBy` when it has one, else the first non-wait rope into it). Not waits:
 * a wait is sequencing between peers — a verify panel's reviewers wait on the node they review,
 * but the orchestrator opened them — so following waits would pull an orchestrator's team apart
 * under whichever station it waits on. And a node has exactly one opener, so the clusters are a
 * forest and the layout has one answer. (The bands of `arrangeByLineage` read both relations;
 * they answer "in what order does work flow", this answers "whose team is this".)
 *
 * - **Ropes are lifted to the top-level unit that holds their end**, as `lineageLayers` does: an
 *   orchestrator opens its stations inside a frame, and the frame is what moves. A rope internal
 *   to one frame says nothing at this level. A frame whose children were opened by different units
 *   belongs to the one that opened the most of them (ties: the earliest rope); a node's own opener
 *   always wins for that node.
 * - **A cycle never hangs.** Openers are not supposed to form one, but frames lift ropes into one
 *   easily (A in frame F opens B outside, B opens C inside F) and project.json is hand-editable.
 *   The member of a cycle that comes first in reading order loses its opener and leads the cluster.
 * - **A rope whose end is gone is ignored** — the canvas prunes it, and an opener that is not here
 *   cannot lead anything; its stations simply become loose.
 * - **No lineage ⇒ exactly the plain grid**: `arrangeNodes(grid)` over the reading-order ids, the
 *   transform this command has always run.
 *
 * Returns the SAME array when no unit moves (fewer than two units, or a canvas already tidied),
 * which is the caller's signal to skip the undo entry and the project.json write. Pure.
 */
export function tidyCanvas<N extends GeometryNode>(
  nodes: N[],
  edges: readonly LineageEdge[] = [],
  opts?: { gap?: number }
): N[] {
  if (nodes.filter((nd) => !nd.parentId).length < 2) return nodes
  // Every unit moves, and a frame is packed at the size its (maximized) child inflated it to.
  nodes = restoreMaximizedWhere(nodes, () => true)
  const units = nodes.filter((nd) => !nd.parentId).sort(byReadingPosition)
  const gap = opts?.gap ?? ARRANGE_GAP_DEFAULT
  const order = new Map(units.map((u, i) => [u.id, i]))
  const unitOf = containerAncestors(nodes, null)

  // Opener of each UNIT. A node's own opener is its opener; a frame takes the unit that opened the
  // most of its contents, ties going to the earliest rope.
  const parent = new Map<string, string>()
  const votes = new Map<string, Map<string, number>>()
  for (const [target, source] of openersOf(nodes, edges)) {
    const u = unitOf.get(target)
    const o = unitOf.get(source)
    if (!u || !o || u === o) continue
    if (target === u) {
      parent.set(u, o)
      continue
    }
    const forU = votes.get(u) ?? new Map<string, number>()
    forU.set(o, (forU.get(o) ?? 0) + 1) // first insertion = earliest rope, kept on a tie below
    votes.set(u, forU)
  }
  for (const [u, forU] of votes) {
    if (parent.has(u)) continue
    let best: string | undefined
    let bestN = 0
    for (const [o, n] of forU) {
      if (n > bestN) {
        best = o
        bestN = n
      }
    }
    if (best !== undefined) parent.set(u, best)
  }

  // Break every cycle at its member that reads first.
  for (const u of units) {
    for (;;) {
      const path: string[] = []
      const onPath = new Set<string>()
      let cur: string | undefined = u.id
      while (cur !== undefined && !onPath.has(cur)) {
        path.push(cur)
        onPath.add(cur)
        cur = parent.get(cur)
      }
      if (cur === undefined) break
      const cycle = path.slice(path.indexOf(cur))
      const lead = cycle.reduce((a, b) => ((order.get(a) ?? 0) <= (order.get(b) ?? 0) ? a : b))
      parent.delete(lead)
    }
  }

  const children = new Map<string, string[]>()
  for (const u of units) {
    const p = parent.get(u.id)
    if (p === undefined) continue
    const list = children.get(p) ?? []
    list.push(u.id) // `units` is in reading order, so every list is too
    children.set(p, list)
  }

  const roots = units.filter((u) => !parent.has(u.id) && children.has(u.id))
  const loose = units.filter((u) => !parent.has(u.id) && !children.has(u.id)).map((u) => u.id)
  const unmoved = (out: N[]): N[] =>
    out.every((nd, i) => nd.position.x === nodes[i].position.x && nd.position.y === nodes[i].position.y)
      ? nodes
      : out
  if (roots.length === 0) return unmoved(arrangeNodes(nodes, units.map((u) => u.id), { layout: 'grid', gap }))

  const byId = new Map(units.map((u) => [u.id, u]))
  const blockOf = (id: string): TidyBlock => {
    const self = byId.get(id)!
    const w = nodeW(self)
    const h = nodeH(self)
    const kids = children.get(id) ?? []
    if (kids.length === 0) return { w, h, place: [{ id, x: 0, y: 0 }] }
    const team = flowBlocks(kids.map(blockOf), Math.ceil(Math.sqrt(kids.length)), gap)
    return {
      w: w + gap + team.w,
      h: Math.max(h, team.h),
      place: [{ id, x: 0, y: 0 }, ...team.place.map((p) => ({ id: p.id, x: p.x + w + gap, y: p.y }))]
    }
  }
  const clusters = flowBlocks(roots.map((r) => blockOf(r.id)), Math.ceil(Math.sqrt(roots.length)), gap)

  const origin = {
    x: Math.min(...units.map((u) => u.position.x)),
    y: Math.min(...units.map((u) => u.position.y))
  }
  const pos = new Map(clusters.place.map((p) => [p.id, { x: origin.x + p.x, y: origin.y + p.y }]))
  let out = nodes.map((nd) => {
    const p = pos.get(nd.id)
    return p && (p.x !== nd.position.x || p.y !== nd.position.y) ? { ...nd, position: p } : nd
  })
  if (loose.length > 0) {
    out = arrangeNodes(out, loose, {
      layout: 'grid',
      gap,
      origin: { x: origin.x, y: origin.y + clusters.h + gap }
    })
  }
  return unmoved(out)
}

/**
 * Why `arrangeGroupChildren` has nothing to do for this frame, as a sentence a menu row can show
 * and a control reply can carry — or `null` when it can run. ONE definition for both, so the row's
 * disabled reason and the CLI's refusal cannot drift apart.
 */
export function groupArrangeRefusal<N extends GeometryNode>(
  nodes: N[],
  groupId: string,
  layout: GroupArrangeLayout,
  edges: readonly LineageEdge[] = []
): string | null {
  const group = nodes.find((nd) => nd.id === groupId)
  if (!group || group.type !== 'group') return `no group frame has the id ${groupId}`
  if (!nodes.some((nd) => nd.parentId === groupId)) return 'this group is empty'
  if (layout === 'lineage' && lineageLayers(nodes, edges, groupId).layers.length === 0) {
    return 'nothing in this group was opened by another node in it'
  }
  return null
}

/**
 * Organizes a group frame's own contents, then sizes the frame — and every ancestor frame — to
 * hold them. The members are the frame's DIRECT children: a nested frame moves as one rigid unit
 * with its own children untouched, exactly as `Tidy canvas` treats a top-level frame.
 *
 * - `grid` / `row` / `column` pack the children in their current reading order (y, then x), so the
 *   result roughly keeps what the user built; `lineage` lays them out as `arrangeByLineage` bands
 *   over the ropes that connect two of them.
 * - **The frame's own top-left stays where it is.** The layout starts at the offset a fitted frame
 *   keeps its content at (`GROUP_PAD`, plus the label header), so the fit that follows re-derives
 *   the same origin and the frame only grows or shrinks to the right and downward. Starting from
 *   the children's current bounding box instead would move the frame to wherever the top-left
 *   child happened to sit. (With snapping on, a frame that was OFF the grid still moves onto it —
 *   by under one cell.)
 * - **The fit walks UP the parent chain, innermost first** (`fitAncestorChain`). Fitting only the
 *   frame leaves a parent smaller than the child it holds, and `extent:'parent'` then makes React
 *   Flow clamp that child into an inverted range — the snap `groupSelectedNodes` documents.
 *
 * Returns the SAME array when there is nothing to do — a missing or empty frame, a lineage layout
 * with no usable rope, or a frame whose contents already sit exactly where the layout puts them —
 * which is the caller's signal to skip the undo entry and the project.json write. Pure.
 */
export function arrangeGroupChildren<N extends GeometryNode>(
  nodes: N[],
  groupId: string,
  opts?: {
    layout?: GroupArrangeLayout
    cols?: number
    gap?: number
    edges?: readonly LineageEdge[]
    grid?: number
  }
): N[] {
  const layout = opts?.layout ?? 'grid'
  const edges = opts?.edges ?? []
  if (groupArrangeRefusal(nodes, groupId, layout, edges)) return nodes
  const grid = opts?.grid ?? 0
  const pad = grid > 0 ? Math.max(GROUP_PAD, grid) : GROUP_PAD
  const origin = { x: pad, y: pad + GROUP_HEADER }
  const gap = opts?.gap
  let next: N[]
  if (layout === 'lineage') {
    next = arrangeByLineage(nodes, edges, { containerId: groupId, origin, gap })
  } else {
    const ids = nodes
      .filter((nd) => nd.parentId === groupId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .map((nd) => nd.id)
    next = arrangeNodes(nodes, ids, { layout, cols: opts?.cols, gap, origin })
  }
  next = fitAncestorChain(next, groupId, grid)
  // Every transform above maps the array in place, so index i is the same node before and after.
  const unchanged = next.every((nd, i) => {
    const was = nodes[i]
    return (
      was === nd ||
      (was.position.x === nd.position.x &&
        was.position.y === nd.position.y &&
        was.width === nd.width &&
        was.height === nd.height)
    )
  })
  return unchanged ? nodes : next
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

/**
 * Snaps the given ids to a shared edge/center computed from their joint bounding box.
 * left/right/hcenter move x; top/bottom/vcenter move y. The ids must share ONE container (all
 * top-level, or all children of the same group — see `arrangeNodes`); a mixed set is a no-op.
 * Unknown ids are skipped; returns the input array unchanged when nothing resolves. Pure.
 */
export function alignNodes<N extends GeometryNode>(nodes: N[], ids: string[], edge: AlignEdge): N[] {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id))
  if (members.length === 0 || new Set(members.map((m) => m.parentId ?? null)).size > 1) return nodes
  const minX = Math.min(...members.map((m) => m.position.x))
  const maxR = Math.max(...members.map((m) => m.position.x + nodeW(m)))
  const minY = Math.min(...members.map((m) => m.position.y))
  const maxB = Math.max(...members.map((m) => m.position.y + nodeH(m)))
  const cx = (minX + maxR) / 2
  const cy = (minY + maxB) / 2
  const move = (m: N): { x: number; y: number } => {
    switch (edge) {
      case 'left':
        return { x: minX, y: m.position.y }
      case 'right':
        return { x: maxR - nodeW(m), y: m.position.y }
      case 'hcenter':
        return { x: cx - nodeW(m) / 2, y: m.position.y }
      case 'top':
        return { x: m.position.x, y: minY }
      case 'bottom':
        return { x: m.position.x, y: maxB - nodeH(m) }
      case 'vcenter':
        return { x: m.position.x, y: cy - nodeH(m) / 2 }
    }
  }
  const set2 = new Set(members.map((m) => m.id))
  return nodes.map((nd) => (set2.has(nd.id) ? { ...nd, position: move(nd) } : nd))
}

/**
 * Parent-first order for the live React Flow array — the ONE definition is `groupsFirstBy`
 * (@shared/node-order), which also documents the downgrade contract this order keeps. Only the
 * group test differs here: a React Flow node says `type`, a persisted state says `kind`.
 */
export function groupsFirst<N extends GeometryNode>(nodes: N[]): N[] {
  return groupsFirstBy(nodes, (node) => node.type === 'group')
}

/** A node's position in ROOT space: its own position plus every ancestor frame's origin. */
export function rootPosition<N extends GeometryNode>(node: N, nodes: N[]): { x: number; y: number } {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  return rootPositionWith(node, (id) => byId.get(id))
}

/**
 * Root-space origin of the container `parentId` names: (0, 0) for a top-level object, else the
 * frame's own root position. A missing frame resolves to the root rather than throwing, matching
 * how the rest of the canvas treats a dangling parentId.
 *
 * Lives here rather than in `lib/gridSnap` (which re-exports it) because it is `rootPosition`
 * with one branch in front, and two homes for that would drift.
 */
export function containerOrigin<N extends GeometryNode>(
  parentId: string | undefined,
  nodes: N[]
): { x: number; y: number } {
  if (!parentId) return { x: 0, y: 0 }
  const frame = nodes.find((node) => node.id === parentId)
  if (!frame) return { x: 0, y: 0 }
  return rootPosition(frame, nodes)
}

export function isDescendant<N extends GeometryNode>(nodes: N[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let current = byId.get(candidateId)
  while (current?.parentId && !seen.has(current.parentId)) {
    if (current.parentId === ancestorId) return true
    seen.add(current.parentId)
    current = byId.get(current.parentId)
  }
  return false
}

/**
 * Returns only the selected subtree ROOTS. Box-selection routinely catches a frame together with
 * its children; a structural action must move that subtree ONCE, through its selected ancestor,
 * or the children are torn out of the frame that is being moved.
 */
export function selectedRootIds<N extends GeometryNode>(nodes: N[], ids: string[]): string[] {
  const selected = new Set(ids)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return ids.filter((id) => {
    let node = byId.get(id)
    if (!node) return false
    const seen = new Set<string>()
    while (node.parentId && !seen.has(node.parentId)) {
      if (selected.has(node.parentId)) return false
      seen.add(node.parentId)
      const parent = byId.get(node.parentId)
      if (!parent) break
      node = parent
    }
    return true
  })
}

/**
 * Re-fits `groupId` and then every ancestor frame above it to hug its children again, innermost
 * first. A frame that gained a child bigger than itself must be re-fitted BEFORE its own parent
 * is, or the parent is fitted around a size that is about to change.
 */
export function fitAncestorChain<N extends GeometryNode>(
  nodes: N[],
  groupId: string | undefined,
  grid = 0
): N[] {
  let next = nodes
  const seen = new Set<string>()
  let currentId = groupId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    next = fitGroupToChildren(next, currentId, grid)
    currentId = next.find((n) => n.id === currentId)?.parentId
  }
  return next
}

/**
 * Maximize (issue #399): resize `nodeId` to occupy `rect` — the visible viewport in ROOT/flow
 * coordinates, computed by the caller from the camera (`maximizeTargetRect`) — remembering the
 * node's own rect in `data.premaxRect` so `restoreMaximizedNode` can put everything back. This is
 * a real resize, not a camera move: the node goes through its normal resize path, so a terminal
 * reflows and the pty gets its new cols/rows.
 *
 * Grouped nodes work too: the new position is written parent-relative and every ancestor frame is
 * re-fitted (`fitAncestorChain`) in the SAME transform — `extent:'parent'` would otherwise clamp a
 * child bigger than its frame into an inverted range (the snap `groupSelectedNodes` documents).
 *
 * Refused (returned unchanged): unknown id, a group frame (maximizing the container would drag its
 * whole subtree), a collapsed node (header-only; expand first), and a node already maximized.
 */
export function maximizeNodeToRect<N extends GeometryNode>(
  nodes: N[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): N[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'group' || node.data.collapsed || node.data.premaxRect) return nodes
  // The remembered position is ROOT-space, not parent-relative: re-fitting the frame around the
  // maximized child MOVES the frame's origin (it hugs), so a parent-relative restore would come
  // back a few px off — and root-space also survives the frame being ungrouped meanwhile.
  const root = rootPosition(node, nodes)
  const premaxRect = {
    x: root.x,
    y: root.y,
    width: nodeW(node) || (node.style?.width as number) || 0,
    height: nodeH(node) || (node.style?.height as number) || 0
  }
  if (!(premaxRect.width > 0) || !(premaxRect.height > 0)) return nodes
  return withNodeRect(nodes, node, rect, { premaxRect })
}

/**
 * Zone snap (issue #394 v1): place `nodeId` at `rect` — a zone of the visible viewport in
 * ROOT/flow coordinates (`zoneTargetRect`). Plain placement, no toggle state: unlike maximize it
 * writes no `premaxRect` (a node sent to "left half" has simply been MOVED, exactly as if by
 * hand) and an existing `premaxRect` is left alone, so a maximized node snapped into a zone still
 * restores to its pre-maximize spot. Refusals match the maximize matrix minus already-maximized:
 * unknown id, group frame, collapsed node.
 */
export function placeNodeInRect<N extends GeometryNode>(
  nodes: N[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): N[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'group' || node.data.collapsed) return nodes
  return withNodeRect(nodes, node, rect, {})
}

/** `rect`'s size raised to the node kind's NodeResizer minimum. */
function clampToMinSize<N extends GeometryNode>(node: N, rect: { width: number; height: number }) {
  const min = NODE_MIN_SIZES[node.type ?? 'terminal'] ?? { width: 0, height: 0 }
  return { width: Math.max(rect.width, min.width), height: Math.max(rect.height, min.height) }
}

/** What `resizeNodes` did to one node: the size it now has, and what the reply must say about it. */
export interface ResizeApplied {
  id: string
  width: number
  /** For a COLLAPSED node this is the height it will expand to — it still draws header-only. */
  height: number
  /** A requested axis was outside [kind minimum, NODE_SIZE_MAX] and was held to the bound. */
  clamped: boolean
  /** Header-only: the width applied now, the height was recorded for when it is expanded. */
  collapsed: boolean
  /** It was maximized, and went back to its own rect before the new size was applied. */
  restored: boolean
}

export type ResizeOutcome<N extends GeometryNode = GeometryNode> =
  | { ok: false; error: string }
  | {
      ok: true
      /** The SAME array when nothing changed — the caller's signal to skip the write. */
      nodes: N[]
      applied: ResizeApplied[]
      /** Ids that name no node, skipped (the rest still applied, like `group`). */
      unknown: string[]
    }

/**
 * `resize` (issue #1288): give existing nodes an explicit size, one axis or both. Pure.
 *
 * - **Clamped, never refused, on size**: each REQUESTED axis is held between the kind's resizer
 *   minimum (`NODE_MIN_SIZES` — the smallest the user can drag it to; a programmatic resize bypasses
 *   the resizer, lib/nodeSizing.ts) and `NODE_SIZE_MAX` (the ceiling of the default-size setting,
 *   `terminalNodeSize`). An axis the caller did not name is kept as it is. `clamped` tells the reply
 *   to say what was actually applied.
 * - **Exact, no grid snapping.** The caller named the pixels; a snapped size is one it did not ask
 *   for. (Align-to-grid is there for whoever wants it.)
 * - **A group frame refuses the WHOLE call**, naming the frame: a frame is sized by what it holds
 *   (`fitGroupToChildren`), so any size given to it is undone by the next fit. Refusing beats
 *   resizing the rest — a refusal means nothing happened.
 * - **Collapsed** (header-only): the width applies now; the height becomes `expandedHeight`, which
 *   is what the expand gives back and what `flowToNodeStates` persists for a collapsed node. The
 *   node keeps its collapsed look — expanding it is the user's call, not a side effect of sizing.
 * - **Maximized**: restored to its own rect first, then sized. Left maximized, the explicit size
 *   would be undone by the next panel-pin refit (`refitMaximizedNode` re-claims the viewport for
 *   any node holding `premaxRect`), and the restore button would later teleport it back to the
 *   old rect. Same rule every layout pass follows (`restoreMaximizedWhere`).
 * - The stale `measured` is dropped in the same tick (as `withNodeRect` does): `flowToNodeStates`
 *   prefers it, and a save racing the re-measure would persist the OLD size. A terminal's cols/rows
 *   follow through its own ResizeObserver — there is no second path to tmux here.
 * - A framed node's frame — and every frame around it — re-fits (`fitAncestorChain`), or
 *   `extent:'parent'` clamps a child that outgrew its frame into an inverted range.
 */
export function resizeNodes<N extends GeometryNode>(
  nodes: N[],
  ids: readonly string[],
  size: { width?: number; height?: number },
  grid = 0
): ResizeOutcome<N> {
  const wanted = [...new Set(ids)]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const unknown = wanted.filter((id) => !byId.has(id))
  const known = wanted.filter((id) => byId.has(id))
  if (known.length === 0) return { ok: false, error: 'resize: none of the given node ids exist' }
  const frame = known.find((id) => byId.get(id)!.type === 'group')
  if (frame) {
    return {
      ok: false,
      error: `resize: ${frame} is a group frame — a frame sizes itself to what it holds; resize the nodes inside it, or \`arrange --group ${frame}\``
    }
  }
  const set = new Set(known)
  const wasMaximized = new Set(known.filter((id) => !!byId.get(id)!.data.premaxRect))
  let next = restoreMaximizedWhere(nodes, (n) => set.has(n.id))
  const applied: ResizeApplied[] = []
  const touchedParents = new Set<string>()
  let changed = wasMaximized.size > 0
  next = next.map((n) => {
    if (!set.has(n.id)) return n
    const kind = n.type ?? 'terminal'
    const min = NODE_MIN_SIZES[kind] ?? { width: 0, height: 0 }
    const collapsed = !!n.data.collapsed
    const curW = nodeW(n) || (n.style?.width as number) || 0
    const curH = collapsed
      ? ((n.data.expandedHeight as number | undefined) ?? COLLAPSED_FALLBACK_HEIGHT[kind] ?? 300)
      : nodeH(n) || (n.style?.height as number) || 0
    const hold = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
    const width = size.width === undefined ? curW : hold(size.width, min.width, NODE_SIZE_MAX.width)
    const height = size.height === undefined ? curH : hold(size.height, min.height, NODE_SIZE_MAX.height)
    const clamped =
      (size.width !== undefined && width !== size.width) || (size.height !== undefined && height !== size.height)
    const restored = wasMaximized.has(n.id)
    applied.push({ id: n.id, width, height, clamped, collapsed, restored })
    if (samePx(curW, width) && samePx(curH, height)) return n
    changed = true
    if (n.parentId) touchedParents.add(n.parentId)
    // Collapsed: it keeps drawing header-only, so only the width and the recorded expand height move.
    const drawnH = collapsed ? ((n.height as number | undefined) ?? COLLAPSED_HEIGHT) : height
    return {
      ...n,
      width,
      height: drawnH,
      style: { ...n.style, width, height: drawnH },
      measured: undefined,
      data: { ...n.data, expandedHeight: height }
    }
  })
  if (!changed) return { ok: true, nodes, applied, unknown }
  for (const parentId of touchedParents) next = fitAncestorChain(next, parentId, grid)
  return { ok: true, nodes: next, applied, unknown }
}

/** Where `placeNodes` put one of the nodes it was asked to move, in ROOT (canvas) space. */
export interface PlaceApplied {
  id: string
  x: number
  y: number
  /** It was maximized, and went back to its own size before it was placed. */
  restored: boolean
}

export type PlaceOutcome<N extends GeometryNode = GeometryNode> =
  | { ok: false; error: string }
  | {
      ok: true
      /** The SAME array when nothing moved — the caller's signal to skip the write. */
      nodes: N[]
      placed: PlaceApplied[]
      unknown: string[]
      /** Listed ids that rode along inside a listed frame instead of being moved twice. */
      carried: string[]
    }

/**
 * `place` (issue #1288): put nodes at canvas coordinates, or shift them by an offset. Pure.
 *
 * - **Root space in, parent kept.** `x`/`y` are canvas coordinates — the numbers `list` reports —
 *   and a framed node STAYS in its frame: the root-space delta is applied to its parent-relative
 *   position (the two differ by the parent chain's origin, which is not moving), and its frame plus
 *   every frame around it re-fit to hold it (`fitAncestorChain`, which keeps root positions fixed —
 *   so the node ends exactly where it was put). That is why this is not `move --x`: `move` without
 *   `--group` means "to the top level".
 * - **Several ids with `x`/`y` move as ONE block**: the set keeps its own shape and its bounding
 *   box's top-left lands on (x, y). It is the only reading in which the call is a placement rather
 *   than a collision — every node at the same point is not a layout — and it makes "pin this
 *   arranged block to the corner" one call. With `dx`/`dy` each node simply shifts.
 * - **A frame carries its subtree**: a listed frame moves with everything in it, and a listed
 *   descendant of a listed frame is NOT moved a second time (`selectedRootIds`) — it is reported as
 *   `carried`.
 * - **Maximized** nodes in what moves are restored first (same reason as `resizeNodes`: left
 *   maximized, the next panel-pin refit would put them back over the viewport). Collapsed nodes need
 *   nothing: placement does not touch a size.
 * - **Exact, no grid snapping** — only a frame's own re-fit snaps (to the grid, as every frame does),
 *   and that never moves what it holds.
 */
export function placeNodes<N extends GeometryNode>(
  nodes: N[],
  ids: readonly string[],
  to: { x?: number; y?: number; dx?: number; dy?: number },
  grid = 0
): PlaceOutcome<N> {
  const wanted = [...new Set(ids)]
  const known = wanted.filter((id) => nodes.some((n) => n.id === id))
  const unknown = wanted.filter((id) => !known.includes(id))
  if (known.length === 0) return { ok: false, error: 'place: none of the given node ids exist' }
  const roots = selectedRootIds(nodes, known)
  const rootSet = new Set(roots)
  const carried = known.filter((id) => !rootSet.has(id))
  const moves = (n: N): boolean => rootSet.has(n.id) || roots.some((r) => isDescendant(nodes, n.id, r))
  const wasMaximized = new Set(roots.filter((id) => !!nodes.find((n) => n.id === id)!.data.premaxRect))
  const restoredAny = nodes.some((n) => !!n.data.premaxRect && moves(n))
  let next = restoreMaximizedWhere(nodes, moves)
  const at = new Map(roots.map((id) => [id, rootPosition(next.find((n) => n.id === id)!, next)]))
  let dx = to.dx ?? 0
  let dy = to.dy ?? 0
  if (to.x !== undefined || to.y !== undefined) {
    const xs = [...at.values()].map((p) => p.x)
    const ys = [...at.values()].map((p) => p.y)
    dx = to.x === undefined ? 0 : to.x - Math.min(...xs)
    dy = to.y === undefined ? 0 : to.y - Math.min(...ys)
  }
  const placedAt = (out: N[]): PlaceApplied[] =>
    roots.map((id) => {
      const p = rootPosition(out.find((n) => n.id === id)!, out)
      return { id, x: p.x, y: p.y, restored: wasMaximized.has(id) }
    })
  if (dx === 0 && dy === 0) {
    return restoredAny
      ? { ok: true, nodes: next, placed: placedAt(next), unknown, carried }
      : { ok: true, nodes, placed: placedAt(nodes), unknown, carried }
  }
  const parents = new Set<string>()
  next = next.map((n) => {
    if (!rootSet.has(n.id)) return n
    if (n.parentId) parents.add(n.parentId)
    // `+ 0` normalizes a -0 that would otherwise ride out to project.json.
    return { ...n, position: { x: n.position.x + dx + 0, y: n.position.y + dy + 0 } }
  })
  for (const parentId of parents) next = fitAncestorChain(next, parentId, grid)
  return { ok: true, nodes: next, placed: placedAt(next), unknown, carried }
}

/**
 * The shared placement core: put `node` at the ROOT-space `rect` (converted to parent-relative),
 * patch its data, and re-fit the ancestor frames in the same transform — `extent:'parent'` would
 * otherwise clamp a child bigger than its frame into an inverted range (the snap
 * `groupSelectedNodes` documents).
 */
function withNodeRect<N extends GeometryNode>(
  nodes: N[],
  node: N,
  rect: { x: number; y: number; width: number; height: number },
  dataPatch: Partial<GeometryNodeData>
): N[] {
  // rect is root-space; a grouped node's position is relative to its frame, so subtract the
  // ancestor origins (root position minus own offset = the parent chain's origin).
  const root = rootPosition(node, nodes)
  const originX = root.x - node.position.x
  const originY = root.y - node.position.y
  // A programmatic resize bypasses the NodeResizer's minimums (lib/nodeSizing.ts), and a zone
  // of a zoomed-in viewport is routinely smaller than a kind's floor — clamp here, once, for
  // maximize, zones, refit and restore alike.
  const { width, height } = clampToMinSize(node, rect)
  const next = nodes.map((n) =>
    n.id === node.id
      ? {
          ...n,
          position: { x: rect.x - originX, y: rect.y - originY },
          width,
          height,
          style: { ...n.style, width, height },
          // Drop the stale measurement in the same tick: flowToNodeStates prefers `measured` over
          // `width`/`height`, and a commit racing the re-measure would persist the OLD size.
          measured: undefined,
          data: { ...n.data, expandedHeight: height, ...dataPatch }
        }
      : n
  )
  return fitAncestorChain(next, node.parentId)
}

/** Sub-pixel tolerance for "the node is already there". Exact equality is not available: a grouped
 *  node's rect round-trips through `rootPosition` in floats, and `nodeW` prefers React Flow's
 *  `measured` width, which it repopulates from the DOM device-pixel-snapped — at fractional zoom
 *  that never equals `innerW / zoom` exactly. Without the tolerance every re-measure would rewrite
 *  the node and bump the workspace rev, which on a shared SSH/git project is a commit per toggle. */
const SAME_PX = 0.5
const samePx = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_PX

/**
 * Re-fit an ALREADY maximized node to a new frame, keeping its restore rect.
 *
 * Maximize is a MODE, not a one-shot placement: while it is on, the node claims the whole usable
 * canvas. Pinning or unpinning a side panel changes what "whole" means, so the node follows.
 * A node that is not maximized is left alone — that one was put where it is by hand or by a zone
 * verb, and those are placements the user owns.
 */
export function refitMaximizedNode<N extends GeometryNode>(
  nodes: N[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): N[] {
  const node = nodes.find((n) => n.id === nodeId)
  const premaxRect = node?.data.premaxRect
  if (!node || !premaxRect) return nodes
  // Idempotent: the caller re-measures on every panel change, and most of those land on the rect
  // the node already has. Returning the same array keeps the workspace out of the dirty/save path
  // and lets the caller decide by identity whether anything actually moved.
  const root = rootPosition(node, nodes)
  const size = clampToMinSize(node, rect)
  if (
    samePx(root.x, rect.x) &&
    samePx(root.y, rect.y) &&
    samePx(nodeW(node) || (node.style?.width as number) || 0, size.width) &&
    samePx(nodeH(node) || (node.style?.height as number) || 0, size.height)
  ) {
    return nodes
  }
  return withNodeRect(nodes, node, rect, { premaxRect })
}

/**
 * Take every maximized node `pick` selects back to its remembered rect. A layout pass packs nodes
 * by size: left maximized, a node is packed at full-viewport size, keeps a restore rect that later
 * teleports it onto the new layout, and the panel-pin refit snaps it back to fullscreen.
 */
function restoreMaximizedWhere<N extends GeometryNode>(nodes: N[], pick: (n: N) => boolean): N[] {
  return nodes.reduce(
    (acc, n) => (n.data.premaxRect && pick(n) ? restoreMaximizedNode(acc, n.id) : acc),
    nodes
  )
}

/**
 * The ids whose user gesture ENDED in `changes` having actually moved or resized the node: a drag
 * end (`dragging: false`, which React Flow emits only when positions changed) or a resize end that
 * followed at least one live `resizing: true` change for that id. React Flow's resizer emits
 * `resizing: false` on every mouseup — a plain click on a grab band included — so the end alone is
 * not evidence of a resize. `resizing` is the caller's gesture memory (ids mid-resize), carried
 * across change batches and updated here. A re-measure carries neither flag.
 */
export function movedGestureEnds(
  changes: readonly { type: string; id?: string; dragging?: boolean; resizing?: boolean }[],
  resizing: Set<string>
): Set<string> {
  const ids = new Set<string>()
  for (const c of changes) {
    if (!c.id) continue
    if (c.type === 'position' && c.dragging === false) ids.add(c.id)
    else if (c.type === 'dimensions' && c.resizing === true) resizing.add(c.id)
    else if (c.type === 'dimensions' && c.resizing === false && resizing.delete(c.id)) ids.add(c.id)
  }
  return ids
}

/**
 * A user drag or resize ends maximize MODE for those nodes where they now stand: the node is no
 * longer the viewport-sized window "Restore" assumes, so keeping `premaxRect` would leave a stale
 * Restore in the header and let the panel-pin refit snap the user's placement back to fullscreen.
 * `ids` comes from movedGestureEnds; programmatic placements never reach onNodesChange.
 */
export function endMaximizeOnUserGeometry<N extends GeometryNode>(nodes: N[], ids: ReadonlySet<string>): N[] {
  if (!nodes.some((n) => ids.has(n.id) && n.data.premaxRect)) return nodes
  return nodes.map((n) =>
    ids.has(n.id) && n.data.premaxRect ? { ...n, data: { ...n.data, premaxRect: undefined } } : n
  )
}

/**
 * The toggle's second click: give the node back the rect `maximizeNodeToRect` remembered — the
 * exact canvas spot it occupied, converted from root-space into wherever its parent chain sits
 * now — and re-fit the ancestor frames back down around it. No-op when the node is missing or
 * not maximized.
 */
export function restoreMaximizedNode<N extends GeometryNode>(nodes: N[], nodeId: string): N[] {
  const node = nodes.find((n) => n.id === nodeId)
  const prev = node?.data.premaxRect
  if (!node || !prev) return nodes
  return withNodeRect(nodes, node, prev, { premaxRect: undefined })
}


/**
 * Resizes a group frame to hug its current children (same padding as `groupSelectedNodes`), and
 * re-anchors the frame + rewrites the children's relative positions so nothing moves on canvas.
 * Used after arranging inside a frame: the frame's width came from wherever the children happened
 * to sit when they were grouped, so a tidy inner layout still leaves an oversized box. No-op for a
 * missing/non-group id or a frame with no children. Pure.
 */
export function fitGroupToChildren<N extends GeometryNode>(
  nodes: N[],
  groupId: string,
  grid = 0
): N[] {
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.type !== 'group') return nodes
  const children = nodes.filter((n) => n.parentId === groupId)
  if (children.length === 0) return nodes
  // Child positions are group-relative; convert to absolute via the current frame origin.
  const absX = (c: N) => group.position.x + c.position.x
  const absY = (c: N) => group.position.y + c.position.y
  const minX = Math.min(...children.map(absX))
  const minY = Math.min(...children.map(absY))
  const maxX = Math.max(...children.map((c) => absX(c) + nodeW(c)))
  const maxY = Math.max(...children.map((c) => absY(c) + nodeH(c)))
  // Same box as a fresh grouping, so a re-fit cannot pull a frame off the grid that
  // `groupSelectedNodes` just put on it.
  const box = groupBox(nodes, group.parentId, { minX, minY, maxX, maxY }, grid)
  const { x: gx, y: gy, width, height } = box
  return nodes.map((n) => {
    if (n.id === groupId) {
      return { ...n, position: { x: gx, y: gy }, width, height, style: { ...n.style, width, height } }
    }
    if (n.parentId === groupId) {
      return { ...n, position: { x: absX(n) - gx, y: absY(n) - gy } }
    }
    return n
  })
}

/**
 * Removes a group frame, promoting its DIRECT children into the frame's own parent (the top
 * level for an unnested frame) without moving them on canvas. A nested frame's children land in
 * the grandparent, not at the root — sending them to the root would move them by the whole
 * ancestor offset.
 */
export function ungroupNodes<N extends GeometryNode>(nodes: N[], groupId: string): N[] {
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.type !== 'group') return nodes
  const parentId = group.parentId ?? null
  const moved = nodes.map((node) =>
    node.parentId === groupId ? repositionForParent(node, parentId, nodes) : node
  )
  return groupsFirst(moved.filter((node) => node.id !== groupId))
}

/**
 * Returns `node` repositioned for a new parent (`targetParentId`, or null for top level),
 * keeping its on-canvas position fixed via root↔relative conversion across arbitrary nesting
 * (the old math added ONE parent's origin, which is wrong the moment frames nest). Returns the
 * node unchanged if the target group is missing or not a group.
 */
export function repositionForParent<N extends GeometryNode>(
  node: N,
  targetParentId: string | null,
  nodes: N[]
): N {
  const abs = rootPosition(node, nodes)
  if (targetParentId === null) {
    return { ...node, parentId: undefined, extent: undefined, position: abs }
  }
  const group = nodes.find((n) => n.id === targetParentId)
  if (!group || group.type !== 'group') return node
  const groupAbs = rootPosition(group, nodes)
  return {
    ...node,
    parentId: group.id,
    extent: 'parent' as const,
    position: { x: abs.x - groupAbs.x, y: abs.y - groupAbs.y }
  }
}

/**
 * Moves a node — or a whole group subtree — into an existing frame (`groupId` set) or out to the
 * top level (`groupId` null), keeping its root-space position fixed. Returns a new array with
 * frames kept before their descendants (React Flow requires parents first). No-op when the node
 * is missing, it already has the requested parent, the target is not a group, or the move would
 * create a cycle (a frame cannot be parented into itself or into one of its own descendants).
 */
export function reparentNode<N extends GeometryNode>(
  nodes: N[],
  nodeId: string,
  groupId: string | null
): N[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return nodes
  if ((node.parentId ?? null) === groupId) return nodes
  if (groupId === nodeId || (groupId && isDescendant(nodes, groupId, nodeId))) return nodes

  const updated = repositionForParent(node, groupId, nodes)
  if (updated === node) return nodes // target group missing / not a group
  return groupsFirst(nodes.map((n) => (n.id === nodeId ? updated : n)))
}

/** Wrap sibling nodes, preserving root coordinates; the host owns frame identity and metadata. */
export function wrapGeometryNodes<N extends GeometryNode>(
  nodes: N[],
  ids: string[],
  makeGroup: (box: Rect) => N,
  grid = 0
): N[] {
  const set = new Set(ids)
  const members = nodes.filter((n) => set.has(n.id))
  if (members.length === 0 || new Set(members.map((n) => n.parentId ?? null)).size !== 1) {
    return nodes
  }
  if (
    members.some((member) =>
      members.some((other) => other.id !== member.id && isDescendant(nodes, other.id, member.id))
    )
  ) {
    return nodes
  }

  const minX = Math.min(...members.map((n) => n.position.x))
  const minY = Math.min(...members.map((n) => n.position.y))
  const maxX = Math.max(...members.map((n) => n.position.x + nodeW(n)))
  const maxY = Math.max(...members.map((n) => n.position.y + nodeH(n)))

  const parentId = members[0].parentId
  const box = groupBox(nodes, parentId, { minX, minY, maxX, maxY }, grid)
  const group = makeGroup(box)
  if (parentId) {
    group.parentId = parentId
    group.extent = 'parent'
  }

  const updated = nodes.map((n) =>
    set.has(n.id)
      ? {
          ...n,
          parentId: group.id,
          extent: 'parent' as const,
          position: { x: n.position.x - box.x, y: n.position.y - box.y },
          selected: false
        }
      : n
  )
  return fitAncestorChain(groupsFirst([group, ...updated]), parentId, grid)
}
