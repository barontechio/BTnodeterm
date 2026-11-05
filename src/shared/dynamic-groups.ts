import type { CanvasNodeState } from './types'
import { GROUP_HEADER, GROUP_PAD } from './canvas-geometry'
import { COLLAPSED_HEIGHT, NODE_MIN_SIZES, type Rect } from './node-sizing'
import { NODE_SIZE_MAX } from './default-node-size'
import { isSafeNodeId } from './safe-id'

export interface DynamicGroupReservation {
  id: string
  width: number
  height: number
  position: { x: number; y: number }
  state: 'reserved' | 'consumed' | 'released'
  nodeId?: string
}
export interface DynamicGroupState {
  version: 1
  reservations: DynamicGroupReservation[]
}
export interface DynamicGroupsSpec {
  version: 1
  groups: { id: string; title?: string; parent?: string | null }[]
  members: { id: string; group: string | null }[]
  reserve: { id: string; group: string; width: number; height: number }[]
  release: { id: string; group: string }[]
  remove: { id: string; promoteTo: string | null }[]
}
export type DynamicGroupsResult = {
  ok: true; nodes: CanvasNodeState[]; required: string[]; created: string[]; removed: string[]
} | { ok: false; error: string }
type Options = { origin?: { x: number; y: number }; grid?: number }

// Bound both untrusted persisted data and the geometry search. These are resource limits,
// not the terminal size ceiling: group frames can grow beyond NODE_SIZE_MAX.
const MAX_NODES = 4096
const MAX_OPS = 256
const MAX_SLOTS = 256
const MAX_TOTAL_SLOTS = 4096
const MAX_COORD = 10_000_000
const MAX_DEPTH = 64
const MAX_CANDIDATES = 65_536
const compareIds = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && isSafeNodeId(v)
const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD
const point = (v: unknown): v is { x: number; y: number } => record(v) && coord(v.x) && coord(v.y)
function fail(message: string): never { throw new Error(`groups: ${message}`) }
function keys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some((k) => !allowed.includes(k))) fail('unknown schema field')
}
function slotSize(width: unknown, height: unknown): boolean {
  return coord(width) && coord(height) && width >= NODE_MIN_SIZES.terminal.width &&
    height >= NODE_MIN_SIZES.terminal.height && width <= NODE_SIZE_MAX.width && height <= NODE_SIZE_MAX.height
}

/** Invalid metadata is discarded as a whole; no truncated list can resurrect a tombstone. */
export function normalizeDynamicGroupState(value: unknown): DynamicGroupState | undefined {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.reservations) || value.reservations.length > MAX_SLOTS) return undefined
  const seen = new Set<string>()
  const reservations: DynamicGroupReservation[] = []
  for (const r of value.reservations) {
    if (!record(r) || !id(r.id) || seen.has(r.id) || !slotSize(r.width, r.height) || !point(r.position) ||
      !['reserved', 'consumed', 'released'].includes(r.state as string) ||
      (r.nodeId !== undefined && !id(r.nodeId)) || (r.state === 'consumed' && !id(r.nodeId)) ||
      (r.state === 'reserved' && r.nodeId !== undefined)) return undefined
    seen.add(r.id)
    reservations.push({ id: r.id, width: r.width as number, height: r.height as number,
      position: { ...r.position }, state: r.state as DynamicGroupReservation['state'],
      ...(r.nodeId !== undefined ? { nodeId: r.nodeId as string } : {}) })
  }
  return { version: 1, reservations }
}

function validateSpec(value: unknown): DynamicGroupsSpec {
  if (!record(value) || value.version !== 1) fail('spec version must be 1')
  keys(value, ['version', 'groups', 'members', 'reserve', 'release', 'remove'])
  const out: DynamicGroupsSpec = { version: 1, groups: [], members: [], reserve: [], release: [], remove: [] }
  let count = 0
  for (const key of ['groups', 'members', 'reserve', 'release', 'remove'] as const) {
    const entries = value[key] === undefined ? [] : value[key]
    if (!Array.isArray(entries) || (count += entries.length) > MAX_OPS) fail('invalid operation budget')
    const seen = new Set<string>()
    for (const e of entries) {
      if (!record(e) || !id(e.id)) fail(`invalid ${key} id`)
      const identity = key === 'reserve' || key === 'release' ? `${e.group}/${e.id}` : e.id
      if (seen.has(identity)) fail(`duplicate ${key} id`)
      seen.add(identity)
      if (key === 'groups') {
        keys(e, ['id', 'title', 'parent'])
        if (e.title !== undefined && (typeof e.title !== 'string' || e.title.length > 256 || /[\x00-\x1f]/.test(e.title))) fail('invalid group title')
        if (e.parent !== undefined && e.parent !== null && !id(e.parent)) fail('invalid group parent')
        out.groups.push({ id: e.id, ...(e.title !== undefined ? { title: e.title as string } : {}),
          ...(e.parent !== undefined ? { parent: e.parent as string | null } : {}) })
      } else if (key === 'members') {
        keys(e, ['id', 'group'])
        if (e.group !== null && !id(e.group)) fail('invalid member group')
        out.members.push({ id: e.id, group: e.group as string | null })
      } else if (key === 'reserve') {
        keys(e, ['id', 'group', 'width', 'height'])
        if (!id(e.group) || !slotSize(e.width, e.height)) fail('invalid reservation size or group')
        out.reserve.push({ id: e.id, group: e.group, width: e.width as number, height: e.height as number })
      } else if (key === 'release') {
        keys(e, ['id', 'group'])
        if (!id(e.group)) fail('invalid release group')
        out.release.push({ id: e.id, group: e.group })
      } else {
        keys(e, ['id', 'promoteTo'])
        if (e.promoteTo !== null && !id(e.promoteTo)) fail('removal needs explicit promoteTo')
        out.remove.push({ id: e.id, promoteTo: e.promoteTo as string | null })
      }
    }
  }
  const removals = new Set(out.remove.map((r) => r.id))
  if (out.groups.some((g) => removals.has(g.id)) || out.members.some((m) => removals.has(m.id) || out.groups.some((g) => g.id === m.id))) fail('conflicting group operations')
  if (out.reserve.some((r) => out.release.some((s) => s.id === r.id && s.group === r.group))) fail('conflicting reservation operations')
  return out
}
export function parseDynamicGroupsSpec(raw: string): { ok: true; spec: DynamicGroupsSpec } | { ok: false; error: string } {
  try {
    if (typeof raw !== 'string' || raw.length > 128 * 1024) fail('spec exceeds size budget')
    return { ok: true, spec: validateSpec(JSON.parse(raw)) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'groups: invalid spec' } }
}

function cloneScene(input: readonly CanvasNodeState[]): CanvasNodeState[] {
  if (!Array.isArray(input) || input.length > MAX_NODES) fail('scene exceeds node budget')
  let slots = 0
  const nodes = input.map((n) => {
    if (!n || !id(n.id) || !Object.hasOwn(NODE_MIN_SIZES, n.kind) || !point(n.position) ||
      !n.size || !coord(n.size.width) || !coord(n.size.height) || n.size.width <= 0 || n.size.height <= 0) fail('invalid node geometry or type')
    const state = n.dynamicGroup === undefined ? undefined : normalizeDynamicGroupState(n.dynamicGroup)
    if (n.dynamicGroup !== undefined && (!state || n.kind !== 'group')) fail(`invalid reservation metadata: ${n.id}`)
    slots += state?.reservations.length ?? 0
    if (slots > MAX_TOTAL_SLOTS) fail('scene exceeds reservation budget')
    return { ...n, position: { ...n.position }, size: { ...n.size }, ...(state ? { dynamicGroup: state } : {}) }
  })
  validateTree(nodes)
  return nodes
}
/**
 * A parent missing from the scene reads as top level, as in stored-canvas-geometry.ts: one lost frame
 * must not refuse every group operation in the project. A plan cannot create one: `setParent` requires
 * an existing group, and removing a frame promotes its children.
 */
function validateTree(nodes: readonly CanvasNodeState[]): void {
  if (nodes.length > MAX_NODES) fail('scene exceeds node budget')
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (byId.size !== nodes.length) fail('duplicate node ids')
  for (const n of nodes) {
    const seen = new Set([n.id])
    let p = n.parentId
    while (p !== undefined) {
      if (!id(p)) fail(`invalid parent or cycle: ${n.id}`)
      const parent = byId.get(p)
      if (!parent) break
      if (parent.kind !== 'group' || seen.has(p) || seen.size > MAX_DEPTH) fail(`invalid parent or cycle: ${n.id}`)
      seen.add(p)
      p = parent.parentId
    }
  }
}
function absolute(n: CanvasNodeState, byId: Map<string, CanvasNodeState>): { x: number; y: number } {
  let x = n.position.x, y = n.position.y
  const p = n.parentId
  for (let parent = p ? byId.get(p) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
    x += parent.position.x
    y += parent.position.y
  }
  if (!coord(x) || !coord(y)) fail('canvas coordinate budget exceeded')
  return { x, y }
}
function ancestry(ids: Iterable<string>, nodes: readonly CanvasNodeState[], into: Set<string>): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const id of ids) {
    let n = byId.get(id)
    while (n) { into.add(n.id); n = n.parentId ? byId.get(n.parentId) : undefined }
  }
}
function context(n: CanvasNodeState, byId: Map<string, CanvasNodeState>): string {
  let cwd: string | undefined, binding: string | undefined
  let current: CanvasNodeState | undefined = n
  while (current) {
    cwd ??= current.worktree?.path || current.cwd || undefined
    if (!binding && current.worktree) binding = current.id
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return JSON.stringify([cwd ?? null, binding ?? null])
}
function assertInheritance(old: readonly CanvasNodeState[], nodes: readonly CanvasNodeState[]): void {
  const before = new Map(old.map((n) => [n.id, n])), after = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const original = before.get(n.id)
    if (original && context(original, before) !== context(n, after)) fail(`reparent changes cwd/worktree inheritance: ${n.id}`)
  }
}
function rect(n: CanvasNodeState): Rect {
  return { ...n.position, width: n.size.width, height: n.collapsed ? COLLAPSED_HEIGHT : n.size.height }
}
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Candidate edges contain the nearest free point of each axis-aligned obstacle cell.
 * Static obstacles never move. Bounded searches refuse rather than publish a partial layout. */
function freePosition(wanted: Rect, obstacles: Rect[], min: { x: number; y: number }, grid: number, origin: { x: number; y: number }): { x: number; y: number } {
  const valid = (r: Rect) => r.x >= min.x && r.y >= min.y && coord(r.x) && coord(r.y) &&
    coord(r.x + r.width) && coord(r.y + r.height) && obstacles.every((o) => !overlaps(r, o))
  if (valid(wanted) && (grid <= 0 ||
    (Number.isInteger((wanted.x + origin.x) / grid) && Number.isInteger((wanted.y + origin.y) / grid)))) return { x: wanted.x, y: wanted.y }
  const xs = [Math.max(min.x, wanted.x), min.x], ys = [Math.max(min.y, wanted.y), min.y]
  for (const o of obstacles) { xs.push(o.x - wanted.width, o.x + o.width); ys.push(o.y - wanted.height, o.y + o.height) }
  const candidates = (values: number[], lower: number, offset: number): number[] => [...new Set(values.flatMap((v) => grid > 0 ?
    [Math.floor((v + offset) / grid) * grid - offset, Math.ceil((v + offset) / grid) * grid - offset] : [v]))]
    .filter((v) => coord(v) && v >= lower)
  const xValues = candidates(xs, min.x, origin.x), yValues = candidates(ys, min.y, origin.y)
  if (xValues.length * yValues.length > MAX_CANDIDATES) fail('layout conflict: free-space search budget exceeded')
  let best: { x: number; y: number } | undefined, distance = Infinity
  for (const y of yValues) for (const x of xValues) {
    const d = (x - wanted.x) ** 2 + (y - wanted.y) ** 2
    if (d > distance || !valid({ ...wanted, x, y })) continue
    if (d < distance || !best || y < best.y || (y === best.y && x < best.x)) { best = { x, y }; distance = d }
  }
  if (!best) fail('layout conflict: no bounded free position')
  return best
}

function layout(nodes: CanvasNodeState[], touched: Set<string>, grid: number): void {
  ancestry([...touched], nodes, touched)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parentOf = (n: CanvasNodeState) => (n.parentId && byId.has(n.parentId) ? n.parentId : undefined)
  const depth = (n: CanvasNodeState) => { let d = 0, p = parentOf(n); while (p) { d++; p = parentOf(byId.get(p)!) } return d }
  const containers = nodes.filter((n) => n.kind === 'group' && touched.has(n.id)).sort((a, b) => depth(b) - depth(a) || compareIds(a, b))
  const solve = (group?: CanvasNodeState) => {
    const children = nodes.filter((n) => parentOf(n) === group?.id)
    const slots = group?.dynamicGroup?.reservations.filter((r) => r.state === 'reserved') ?? []
    if (group) {
      const footprints = children.map(rect)
      let shiftX = Math.max(0, ...footprints.map((r) => GROUP_PAD - r.x))
      let shiftY = Math.max(0, ...footprints.map((r) => GROUP_PAD + GROUP_HEADER - r.y))
      if (slots.some((r) => r.position.x < 0 || r.position.y < 0)) fail('layout conflict: reservation lies outside its frame')
      // Expand left/top first, compensating children to preserve their root positions. Slot
      // coordinates are durable host facts: keep them relative to the frame, including inactive
      // tombstones. They move with its origin, just as they do during an ordinary frame drag.
      if (shiftX || shiftY) {
        const staticBounds = children.filter((n) => !touched.has(n.id)).map(rect)
        const reservedBounds = slots.map((r) => ({ ...r.position, width: r.width, height: r.height }))
        const sweepsStaticChild = staticBounds.some((child) => reservedBounds.some((slot) =>
          overlaps({ ...child, x: child.x + shiftX, y: child.y + shiftY }, slot)))
        if (sweepsStaticChild) {
          if (staticBounds.length * reservedBounds.length > MAX_CANDIDATES) fail('layout conflict: reservation compensation budget exceeded')
          // In compensation space each slot/child pair forbids an open rectangle of offsets.
          // Find the nearest offset beyond the required growth that avoids EVERY pair, without
          // moving static children in root space or rewriting any slot position.
          const forbidden = staticBounds.flatMap((child) => reservedBounds.map((slot) => {
            // Cancellation at an offset edge can leave a subpixel overlap after translation.
            // Keep integer layouts exact; fractional geometry gets bounded roundoff clearance.
            const clearance = [child.x, child.y, child.width, child.height, slot.x, slot.y, slot.width, slot.height]
              .every(Number.isInteger) ? 0 : Number.EPSILON * MAX_COORD * 16
            return { x: slot.x - child.x - child.width - clearance, y: slot.y - child.y - child.height - clearance,
              width: slot.width + child.width + clearance * 2, height: slot.height + child.height + clearance * 2 }
          }))
          const compensation = freePosition({ x: shiftX, y: shiftY, width: 0, height: 0 }, forbidden,
            { x: shiftX, y: shiftY }, 0, { x: 0, y: 0 })
          shiftX = compensation.x; shiftY = compensation.y
        }
        group.position.x -= shiftX; group.position.y -= shiftY
        for (const child of children) { child.position.x += shiftX; child.position.y += shiftY }
        group.size.width += shiftX; group.size.height += shiftY
      }
    }
    const staticChildren = children.filter((n) => !touched.has(n.id))
    const obstacles = [...staticChildren.map(rect), ...slots.map((r) => ({ ...r.position, width: r.width, height: r.height }))]
    const origin = group ? absolute(group, byId) : { x: 0, y: 0 }
    const min = group ? { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER } : { x: -MAX_COORD, y: -MAX_COORD }
    const affected = children.filter((n) => touched.has(n.id)).sort((a, b) => compareIds(a, b))
    // Reserve already-valid affected footprints before searching for conflicted members.
    // Otherwise an early relocation could steal a later member's unchanged position.
    const stable = new Set(affected.filter((n) => {
      const r = rect(n)
      return r.x >= min.x && r.y >= min.y && obstacles.every((o) => !overlaps(r, o)) &&
        affected.every((other) => other.id === n.id || !overlaps(r, rect(other)))
    }).map((n) => n.id))
    obstacles.push(...affected.filter((n) => stable.has(n.id)).map(rect))
    for (const child of affected.filter((n) => !stable.has(n.id))) {
      child.position = freePosition(rect(child), obstacles, min, grid, origin)
      obstacles.push(rect(child))
    }
    if (!group) return
    const minSize = NODE_MIN_SIZES.group
    group.size.width = Math.max(minSize.width, group.size.width, ...obstacles.map((r) => r.x + r.width + GROUP_PAD))
    group.size.height = Math.max(minSize.height, group.size.height, ...obstacles.map((r) => r.y + r.height + GROUP_PAD))
    if (!coord(group.size.width) || !coord(group.size.height)) fail('layout conflict: group exceeds canvas budget')
  }
  for (const group of containers) solve(group)
  solve()
  // Check absolute descendants after all ancestor translations, including coordinate overflow.
  for (const n of nodes) absolute(n, byId)
}
function finish(old: readonly CanvasNodeState[], nodes: CanvasNodeState[], explicit: Set<string>, touched: Set<string>, options: Options): DynamicGroupsResult {
  if (options.grid !== undefined && (!coord(options.grid) || options.grid < 0 || options.grid > 4096)) fail('invalid grid')
  if (nodes.reduce((sum, n) => sum + (n.dynamicGroup?.reservations.length ?? 0), 0) > MAX_TOTAL_SLOTS) fail('scene exceeds reservation budget')
  validateTree(nodes)
  assertInheritance(old, nodes)
  layout(nodes, touched, options.grid ?? 0)
  const before = new Map(old.map((n) => [n.id, n])), after = new Map(nodes.map((n) => [n.id, n]))
  const changed = new Set(explicit)
  for (const n of nodes) {
    const prev = before.get(n.id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(n) || JSON.stringify(absolute(prev, before)) !== JSON.stringify(absolute(n, after))) changed.add(n.id)
  }
  for (const n of old) if (!after.has(n.id)) changed.add(n.id)
  const required = new Set(changed)
  ancestry(changed, old, required); ancestry(changed, nodes, required)
  return { ok: true, nodes, required: [...required].sort(),
    created: nodes.filter((n) => !before.has(n.id)).map((n) => n.id), removed: old.filter((n) => !after.has(n.id)).map((n) => n.id) }
}
function guarded(work: () => DynamicGroupsResult): DynamicGroupsResult {
  try { return work() } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'groups: invalid input' } }
}

export function planDynamicGroups(input: readonly CanvasNodeState[], spec: DynamicGroupsSpec, options: Options = {}): DynamicGroupsResult {
  return guarded(() => {
    const desired = validateSpec(spec)
    const nodes = cloneScene(input)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const oldById = new Map(input.map((n) => [n.id, n]))
    const positions = new Map(input.map((n) => [n.id, absolute(n, oldById)]))
    const explicit = new Set<string>(), touched = new Set<string>(), parents = new Map<string, string | null>()
    const newGroups = new Set<string>()
    const requireGroup = (id: string): CanvasNodeState => {
      explicit.add(id)
      const g = byId.get(id)
      if (!g || g.kind !== 'group') fail(`unknown group: ${id}`)
      return g
    }
    const setParent = (n: CanvasNodeState, parent: string | null) => {
      if (parent !== null) requireGroup(parent)
      if ((n.parentId ?? null) !== parent) { touched.add(n.id); parents.set(n.id, parent) }
      if (parent) n.parentId = parent; else delete n.parentId
    }
    if (options.origin !== undefined && !point(options.origin)) fail('invalid origin')
    for (const g of desired.groups) {
      explicit.add(g.id)
      let n = byId.get(g.id)
      if (n && n.kind !== 'group') fail(`group id has another type: ${g.id}`)
      if (!n) {
        n = { id: g.id, kind: 'group', title: g.title ?? g.id, color: '#8b8b8b', group: null,
          position: { ...(options.origin ?? { x: 0, y: 0 }) }, size: { ...NODE_MIN_SIZES.group },
          dynamicGroup: { version: 1, reservations: [] } }
        nodes.push(n); byId.set(n.id, n); touched.add(n.id); newGroups.add(n.id)
      }
      // Naming an existing frame opts it into the same gesture reconciliation as a new one.
      n.dynamicGroup ??= { version: 1, reservations: [] }
      if (g.title !== undefined) n.title = g.title
    }
    for (const g of desired.groups) if (g.parent !== undefined) setParent(byId.get(g.id)!, g.parent)
    for (const m of desired.members) {
      explicit.add(m.id)
      const n = byId.get(m.id)
      if (!n || !['terminal', 'group'].includes(n.kind)) fail(`member must name an existing terminal or group: ${m.id}`)
      setParent(n, m.group)
    }
    const removals = new Set(desired.remove.map((r) => r.id))
    for (const r of desired.remove) {
      explicit.add(r.id)
      if (r.promoteTo !== null) { requireGroup(r.promoteTo); if (removals.has(r.promoteTo)) fail('promotion target is removed') }
      const g = byId.get(r.id)
      if (!g) continue // Desired absence is idempotent.
      if (g.kind !== 'group' || g.worktree) fail('cannot remove a worktree or non-group frame')
      if (g.dynamicGroup?.reservations.some((slot) => slot.state === 'reserved')) fail('cannot remove a group with active reservations; release them before removing the frame')
      if (desired.reserve.some((s) => s.group === r.id) || desired.release.some((s) => s.group === r.id)) fail('reservation target is removed')
      for (const n of nodes) if (n.parentId === g.id && !removals.has(n.id)) { explicit.add(n.id); setParent(n, r.promoteTo) }
    }
    for (let i = nodes.length - 1; i >= 0; i--) if (removals.has(nodes[i].id)) { byId.delete(nodes[i].id); nodes.splice(i, 1) }
    validateTree(nodes)
    // A new frame with existing members starts around their real root bounds. Starting every
    // frame at zero can cover distant static obstacles and needlessly move an entire session.
    const anchorNewGroup = (key: string): { x: number; y: number } | undefined => {
      if (positions.has(key)) return positions.get(key)
      if (!newGroups.has(key)) return undefined
      const g = byId.get(key)!
      const contents = nodes.filter((n) => n.parentId === key).flatMap((n) => {
        const anchor = anchorNewGroup(n.id)
        return anchor ? [{ ...anchor, width: n.size.width, height: n.collapsed ? COLLAPSED_HEIGHT : n.size.height }] : []
      })
      if (!contents.length) return undefined
      const x = Math.min(...contents.map((r) => r.x)) - GROUP_PAD
      const y = Math.min(...contents.map((r) => r.y)) - GROUP_PAD - GROUP_HEADER
      g.size.width = Math.max(g.size.width, ...contents.map((r) => r.x + r.width - x + GROUP_PAD))
      g.size.height = Math.max(g.size.height, ...contents.map((r) => r.y + r.height - y + GROUP_PAD))
      const anchor = { x, y }
      positions.set(key, anchor)
      return anchor
    }
    for (const key of newGroups) {
      if (!byId.has(key)) continue
      if (options.origin === undefined) anchorNewGroup(key)
      parents.set(key, byId.get(key)!.parentId ?? null)
    }
    // Convert existing reparented nodes from their old root position into the final parent space.
    // Ancestors first ensures each destination already has its final root coordinates.
    const pending = new Set([...parents.keys()].filter((key) => byId.has(key)))
    while (pending.size) {
      let progress = false
      for (const key of pending) {
        const n = byId.get(key)!
        let p = n.parentId, waiting = false
        while (p) { if (pending.has(p)) waiting = true; p = byId.get(p)?.parentId }
        if (waiting) continue
        const old = positions.get(key)
        if (old) {
          const origin = n.parentId ? absolute(byId.get(n.parentId)!, byId) : { x: 0, y: 0 }
          n.position = { x: old.x - origin.x, y: old.y - origin.y }
        } else if (n.parentId) n.position = { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER }
        pending.delete(key); progress = true
      }
      if (!progress) fail('cyclic placement')
    }
    for (const r of desired.release) {
      const g = requireGroup(r.group), slot = g.dynamicGroup?.reservations.find((s) => s.id === r.id)
      if (!slot) fail(`unknown reservation: ${r.id}`)
      if (slot.state === 'reserved') slot.state = 'released'
    }
    for (const r of desired.reserve) {
      const g = requireGroup(r.group)
      g.dynamicGroup ??= { version: 1, reservations: [] }
      const existing = g.dynamicGroup.reservations.find((s) => s.id === r.id)
      if (existing) {
        if (existing.width !== r.width || existing.height !== r.height) fail('reservation identity has different dimensions')
        continue // Never resurrect consumed/released identities, including across restart.
      }
      if (g.dynamicGroup.reservations.length >= MAX_SLOTS) fail('group exceeds reservation budget')
      const obstacles = [...nodes.filter((n) => n.parentId === g.id).map(rect),
        ...g.dynamicGroup.reservations.filter((s) => s.state === 'reserved').map((s) => ({ ...s.position, width: s.width, height: s.height }))]
      const position = freePosition({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER, width: r.width, height: r.height },
        obstacles, { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER }, options.grid ?? 0, absolute(g, byId))
      g.dynamicGroup.reservations.push({ id: r.id, width: r.width, height: r.height, position, state: 'reserved' })
      touched.add(g.id)
    }
    // Include old containers for authorization without compacting or rearranging them.
    return finish(input, nodes, explicit, touched, options)
  })
}

export function placeDynamicGroupMember(input: readonly CanvasNodeState[], groupId: string, member: CanvasNodeState, reservationId?: string, options: { grid?: number } = {}): DynamicGroupsResult {
  return guarded(() => {
    const nodes = cloneScene(input)
    const g = nodes.find((n) => n.id === groupId)
    if (!id(groupId) || !g || g.kind !== 'group') fail('open needs an existing group')
    if (nodes.some((n) => n.id === member.id)) fail('new member id already exists')
    const n = cloneScene([{ ...member, parentId: undefined }])[0]
    if (n.kind === 'group') fail('open member must not be a group frame')
    n.parentId = groupId
    const obstacles = nodes.filter((s) => s.parentId === groupId).map(rect)
    if (reservationId !== undefined) {
      if (!id(reservationId)) fail('invalid reservation id')
      const slot = g.dynamicGroup?.reservations.find((r) => r.id === reservationId)
      if (!slot || slot.state !== 'reserved') fail('reservation is unavailable or already consumed/released')
      if (n.size.width > slot.width || n.size.height > slot.height) fail('member exceeds reserved size')
      const reservedRect = { ...slot.position, width: slot.width, height: slot.height }
      if (slot.position.x < GROUP_PAD || slot.position.y < GROUP_PAD + GROUP_HEADER ||
        obstacles.some((r) => overlaps(reservedRect, r)) ||
        g.dynamicGroup!.reservations.some((r) => r.id !== slot.id && r.state === 'reserved' &&
          overlaps(reservedRect, { ...r.position, width: r.width, height: r.height }))) fail('reservation footprint conflicts with current members')
      n.position = { ...slot.position }
      slot.state = 'consumed'; slot.nodeId = n.id
    } else {
      obstacles.push(...(g.dynamicGroup?.reservations.filter((r) => r.state === 'reserved').map((r) => ({ ...r.position, width: r.width, height: r.height })) ?? []))
      n.position = freePosition({ ...rect(n), x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER }, obstacles,
        { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER }, options.grid ?? 0,
        absolute(g, new Map(nodes.map((s) => [s.id, s]))))
    }
    nodes.push(n)
    return finish(input, nodes, new Set([groupId]), new Set([n.id, groupId]), options)
  })
}

export function reconcileDynamicGroups(input: readonly CanvasNodeState[], changedIds: readonly string[], options: { grid?: number } = {}): DynamicGroupsResult {
  return guarded(() => {
    const nodes = cloneScene(input)
    if (!Array.isArray(changedIds) || changedIds.length > MAX_NODES || changedIds.some((key) => !id(key) || !nodes.some((n) => n.id === key))) fail('invalid changed node ids')
    return finish(input, nodes, new Set(changedIds), new Set(changedIds), options)
  })
}
