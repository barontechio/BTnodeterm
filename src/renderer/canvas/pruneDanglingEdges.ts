import type { MutableRefObject } from 'react'

/**
 * Drop the edges with an endpoint no node holds. Call it from an effect.
 *
 * The verdict is made here, over the refs as this effect sees them, and the update only removes
 * those ids. Judging inside the functional update looks equivalent and is not: an update already
 * queued behind this effect (a local add of a node, its rope and its bridge) is processed before the
 * render mirrors `nodesRef`, so a new edge would be judged against the old nodes and dropped. Only an
 * edge this effect saw can be removed.
 */
export function pruneDanglingEdges<E extends { id: string; source: string; target: string }>(
  nodesRef: MutableRefObject<ReadonlyArray<{ id: string }>>,
  edgesRef: MutableRefObject<readonly E[]>,
  setEdges: (update: (edges: E[]) => E[]) => void
): void {
  if (!edgesRef.current.length) return
  const ids = new Set(nodesRef.current.map((n) => n.id))
  const dead = new Set(edgesRef.current.filter((e) => !ids.has(e.source) || !ids.has(e.target)).map((e) => e.id))
  if (dead.size) setEdges((edges) => edges.filter((e) => !dead.has(e.id)))
}
