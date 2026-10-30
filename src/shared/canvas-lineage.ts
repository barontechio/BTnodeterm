import { isSafeNodeId } from './safe-id'

/** The opener a node records, when it is an id we would address and not the node itself. */
export function recordedOpener(node: { id: unknown; openedBy?: unknown } | undefined): string | undefined {
  const o = node?.openedBy
  return typeof o === 'string' && isSafeNodeId(o) && o !== node?.id ? o : undefined
}

/** An OPENER rope, or null — for anything unreadable and for a wait rope (rule 1). */
function readOpenerRope(r: unknown): { source: string; target: string } | null {
  if (!r || typeof r !== 'object') return null
  const { id, source, target } = r as { id?: unknown; source?: unknown; target?: unknown }
  if (typeof source !== 'string' || typeof target !== 'string') return null
  if (!source || !target || source === target) return null
  if (isWaitRope({ id, source, target })) return null
  return { source, target }
}

/**
 * Rule 1 as a map: every node a rope says was OPENED, to the node that opened it, in rope order.
 * Wait ropes never name an opener; the first opener rope into a node claims it; a node that records
 * its opener (`recordedOf`) is claimed only by that opener's rope. A claim stands whether or not
 * its source is still on the canvas — a stored (unpruned) file can still hold the rope of an opener
 * that was deleted, and the caller decides what a dead source means.
 *
 * ONE definition, read by team progress (`stationsByOpener`) and by the canvas layout
 * (`tidyCanvas` / `lineageLayers` in state/workspace), so "who opened this node" cannot answer one
 * way on the ring and another way when the canvas is tidied.
 */
export function openerByTarget(
  ropes: unknown,
  recordedOf: (target: string) => string | undefined
): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(ropes)) return out
  for (const raw of ropes) {
    const rope = readOpenerRope(raw)
    if (!rope || out.has(rope.target)) continue
    const recorded = recordedOf(rope.target)
    if (recorded && recorded !== rope.source) continue
    out.set(rope.target, rope.source)
  }
  return out
}

/** The opener a node records, read off live node data (`data.openedBy`), checked like the
 *  serialized field: an id we would address, and not the node itself. */
export function recordedOpenerOf(node: { id: string; data?: { openedBy?: unknown } } | undefined): string | undefined {
  return node ? recordedOpener({ id: node.id, openedBy: node.data?.openedBy }) : undefined
}

/**
 * The id of a WAIT rope (`--after`, the verify panel's sequencing): `ctrl-after-<dep>-<node>`.
 *
 * A rope carries two relations — "opened by" and "waits for" — and for a long time both were minted
 * as `ctrl-<source>-<target>`, so nothing could tell them apart except ORDER (every writer appends
 * the opener's rope before the same command's waits). Order does not survive the canvas's own
 * pruning: deleting the opener deletes its rope, and the first wait into the node then looked like
 * its opener (team progress showed a pipeline's upstream station as the next one's team leader).
 * A wait now says what it is in its id. Still `ctrl-`, so every path that routes on that prefix
 * (edge changes, deletion, the store's pair-keyed dedupe) treats it exactly as before.
 */
export function waitRopeId(dep: string, node: string): string {
  return `ctrl-after-${dep}-${node}`
}

/** Is this rope a wait? Exact match on the rope's own endpoints, so an opener rope whose SOURCE id
 *  happens to begin with `after-` is never mistaken for one. */
export function isWaitRope(rope: { id?: unknown; source: string; target: string }): boolean {
  return rope.id === waitRopeId(rope.source, rope.target)
}

/**
 * Canvases saved before waits were marked: every rope into a node AFTER the first one is a wait
 * (the append-order rule above), so it is re-minted with `waitRopeId` — once, at load, BEFORE the
 * prune can delete the opener's rope and erase the only evidence of which one it was. A marked
 * rope and the first unmarked rope into each node are left alone. A re-minted id that already
 * exists (the same pair twice) is dropped rather than duplicated — React Flow renders two edges
 * with one id as one, and the next removal breaks. Returns the same array when nothing changed.
 *
 * Residual: a canvas that was pruned AND saved before this ran has already lost its opener rope;
 * its first surviving wait still reads as the opener, and nothing left in the file can say
 * otherwise.
 */
export function markLegacyWaitRopes<R extends { id: string; source: string; target: string }>(
  ropes: readonly R[]
): R[] {
  const opened = new Set<string>()
  const ids = new Set(ropes.map((r) => r.id))
  let changed = false
  const out: R[] = []
  for (const r of ropes) {
    if (isWaitRope(r)) {
      out.push(r)
      continue
    }
    if (!opened.has(r.target)) {
      opened.add(r.target)
      out.push(r)
      continue
    }
    const id = waitRopeId(r.source, r.target)
    changed = true
    if (ids.has(id)) continue
    ids.add(id)
    out.push({ ...r, id })
  }
  return changed ? out : (ropes as R[])
}
