// Pure decisions behind the canvas edge model (spec: docs/superpowers/specs/2026-09-02-canvas-edge-
// model-design.md). A ROPE is the one visible relation between two nodes — "opened by" and
// "sequenced after (--after)" — and its LOOK is derived from the target's pendingLaunch, never
// stored: dashed while the target still waits on the rope's source, solid otherwise. Kept free of
// React/store imports so Canvas.tsx only wraps these in a memo.
import { normalizeSuccessWaitHold } from '@shared/station-outcome'
import type { PendingLaunch } from '@shared/types'
import { waitRopeId, isWaitRope } from '@shared/canvas-lineage'
export { waitRopeId, isWaitRope, markLegacyWaitRopes } from '@shared/canvas-lineage'

/** Rope colour for a source with no agent (a browser popup, a plain terminal that opened nothing). */
export const ROPE_NEUTRAL = '#8e8e93'
/** The waiting rope's label. Canvas appends the removal hint when the rope is selected. */
export const WAIT_LABEL = '⏳ waits for'

export interface RopeNodeInfo {
  /** The node's agent colour (AGENT_CONFIG), if it runs an agent. */
  agentColor?: string
  /** The node's `pendingLaunch.after`, if it is armed. */
  pendingAfter?: readonly string[]
}

export interface RopeVisual {
  /** The target is armed and still lists this rope's source among its deps. */
  waiting: boolean
  color: string
}

export function ropeVisual(
  rope: { source: string; target: string },
  info: (id: string) => RopeNodeInfo | undefined
): RopeVisual {
  const waiting = !!info(rope.target)?.pendingAfter?.includes(rope.source)
  const color = info(rope.source)?.agentColor ?? ROPE_NEUTRAL
  return { waiting, color }
}

/**
 * Deleting a WAITING rope is the user saying "do not wait on that one": drop the dep from the
 * target's list and keep everything else. Returns the same object when nothing changes so a caller
 * can skip the state write. An emptied list is left in place — `launchesToFire` treats `[]` as
 * satisfied and fires the held command, which is exactly what removing the last wait should do.
 */
export function dropAfterDep(p: PendingLaunch, depId: string): PendingLaunch {
  const success = normalizeSuccessWaitHold(p.afterSuccess)
  const inSuccess = !!success && !success.invalid && success.deps.includes(depId)
  if (!p.after.includes(depId) && !inSuccess) return p
  const next: PendingLaunch = { ...p, after: p.after.filter((d) => d !== depId) }
  // A `--after-success` station rides the same rope, so deleting that rope stops BOTH waits on it —
  // "stop waiting for it" cannot leave the success half behind with no edge left to say so. A hold
  // that names nobody any more is dropped whole: an empty success wait could never be met.
  if (inSuccess && success) {
    const deps = success.deps.filter((d) => d !== depId)
    if (deps.length) next.afterSuccess = { ...success, deps }
    else delete next.afterSuccess
  }
  return next
}

/** Nodes whose eye is closed (`hideFanout`): every edge touching them is hidden from the canvas. */
export function hiddenEdgeNodeIds(
  nodes: readonly { id: string; data: { hideFanout?: boolean } }[]
): Set<string> {
  const out = new Set<string>()
  for (const n of nodes) if (n.data.hideFanout) out.add(n.id)
  return out
}

export function edgeHidden(e: { source: string; target: string }, hidden: ReadonlySet<string>): boolean {
  return hidden.size > 0 && (hidden.has(e.source) || hidden.has(e.target))
}

/**
 * The endpoint lookup `ropeVisual` needs, built once from the canvas nodes. Extracted because the
 * DELETE paths ask the same question the render does ("is this rope a wait?"), and two copies of
 * the builder would be two answers: displayEdges would draw the waiting label while the delete
 * path still took the covered context bridge with it. `colorOf` is injected so this file stays
 * free of the agent registry.
 */
export function ropeInfoOf(
  nodes: readonly { id: string; data: { agentId?: string; pendingLaunch?: PendingLaunch } }[],
  colorOf: (agentId: string) => string | undefined
): (id: string) => RopeNodeInfo | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return (id) => {
    const n = byId.get(id)
    if (!n) return undefined
    const agentId = n.data.agentId
    return {
      agentColor: agentId ? colorOf(agentId) : undefined,
      pendingAfter: n.data.pendingLaunch?.after
    }
  }
}





/** The canvas's rope prune, as a pure step: a rope whose endpoint is not on the canvas goes. Same
 *  array back when nothing did. */
export function pruneRopes<R extends { source: string; target: string }>(
  ropes: readonly R[],
  nodeIds: ReadonlySet<string>
): R[] {
  const valid = ropes.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  return valid.length === ropes.length ? (ropes as R[]) : valid
}

/**
 * The dep ropes an armed node is owed but does not have. A rope is what makes a wait VISIBLE, and
 * only the `open-*`/`verify` verbs write one — so a node armed by any other path, or armed by a
 * build that predates the rope (its `pendingLaunch` is persisted, the rope is not), would show a
 * launch it is holding with no arrow saying what for. Applied at project load, this heals both
 * cases on the next open and costs nothing on a canvas with no armed node.
 *
 * A dep that is not on the canvas is skipped — it can never report, `launchesToFire` already treats
 * it as satisfied, and an edge to a node that is not there would be dropped by React Flow anyway.
 */
export function missingDepRopes(
  nodes: readonly { id: string; data: { pendingLaunch?: PendingLaunch } }[],
  ropes: readonly { source: string; target: string }[]
): { id: string; source: string; target: string }[] {
  const live = new Set(nodes.map((n) => n.id))
  const have = new Set(ropes.map((r) => `${r.source} ${r.target}`))
  const out: { id: string; source: string; target: string }[] = []
  for (const n of nodes) {
    for (const dep of n.data.pendingLaunch?.after ?? []) {
      if (!live.has(dep) || have.has(`${dep} ${n.id}`)) continue
      have.add(`${dep} ${n.id}`)
      out.push({ id: waitRopeId(dep, n.id), source: dep, target: n.id })
    }
  }
  return out
}
