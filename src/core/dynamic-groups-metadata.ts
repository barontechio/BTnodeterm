import type { Workspace } from '../shared/types'
import { reconcileDynamicGroups } from '../shared/dynamic-groups'
import { canvasLayoutOf } from '../shared/canvas-batch'
import { stableStringify } from '../shared/canvas-mutations'
import { managedGeometryChanges } from '../shared/dynamic-group-geometry'

/** A stale gesture may have occupied a hole that the host subsequently reserved. Refuse before
 * publication/disk writes rather than keep the slot but silently make it unusable. Ordinary edits
 * and already-reconciled geometry remain untouched; there is no new owner or execution grant. */
export function assertManagedClientGeometry(submitted: Workspace, current: Workspace): void {
  const projects = new Map(current.projects.map((project) => [project.id, project]))
  for (const project of submitted.projects) {
    const old = projects.get(project.id)
    if (!old || !old.nodes.some((n) => n.dynamicGroup) && !project.nodes.some((n) => n.dynamicGroup)) continue
    const previous = new Map(old.nodes.map((n) => [n.id, n]))
    for (const node of old.nodes) if (node.dynamicGroup?.reservations.some((r) => r.state === 'reserved') &&
      !project.nodes.some((n) => n.id === node.id && n.kind === 'group')) {
      throw new Error(`workspace-save-group-layout-conflict: release active reservations before retiring ${node.id}`)
    }
    const changed = project.nodes.filter((node) => !previous.has(node.id) ||
      stableStringify(canvasLayoutOf(node)) !== stableStringify(canvasLayoutOf(previous.get(node.id)!))).map((n) => n.id)
    const relevant = managedGeometryChanges(old.nodes, project.nodes, changed)
    if (!relevant.length) continue
    const plan = reconcileDynamicGroups(project.nodes, relevant)
    if (!plan.ok || stableStringify(plan.nodes.map(canvasLayoutOf)) !== stableStringify(project.nodes.map(canvasLayoutOf))) {
      throw new Error('workspace-save-group-layout-conflict: current reservations or group geometry changed; reload the project before repeating this gesture')
    }
  }
}

/** Client snapshots never author reservation facts. Carry the host's current facts inside the
 * save FIFO, including for old clients that omit the field and stale clients that saw a slot
 * before it was consumed. Deleting an actual node remains the existing canvas operation. */
export function preserveHostGroupMetadata(submitted: Workspace, current: Workspace): Workspace {
  const projects = new Map(current.projects.map((project) => [project.id, project]))
  return { ...submitted, projects: submitted.projects.map((project) => {
    const existing = new Map(projects.get(project.id)?.nodes.map((node) => [node.id, node]) ?? [])
    return { ...project, nodes: project.nodes.map((node) => {
      const next = { ...node }
      const facts = existing.get(node.id)?.dynamicGroup
      if (facts !== undefined) next.dynamicGroup = structuredClone(facts)
      else delete next.dynamicGroup
      return next
    }) }
  }) }
}
