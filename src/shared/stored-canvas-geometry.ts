import type { CanvasNodeState } from './types'
import { wrapGeometryNodes, type GeometryNode } from './canvas-geometry'
import { COLLAPSED_HEIGHT } from './node-sizing'

/**
 * The frame a saved `parentId` names, if it names one. A frame can go missing (a hand edit, a merge, a
 * lost write, a frame removed while a peer moves a node in) and its children then read as top level
 * wherever they are drawn, so geometry reads them that way too. Refusing here would stop geometry for
 * every agent in the project over one damaged node, whoever owns it.
 */
function liveParentId(node: CanvasNodeState, byId: ReadonlyMap<string, CanvasNodeState>): string | undefined {
  const parent = node.parentId ? byId.get(node.parentId) : undefined
  return parent?.kind === 'group' ? parent.id : undefined
}

/** Persisted sizes are expanded sizes, exactly as Desktop's load/save boundary defines them. */
export function storedGeometryNodes(nodes: readonly CanvasNodeState[]): GeometryNode[] {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`geometry-invalid-scene: duplicate node ${node.id}`)
    ids.add(node.id)
    if (![node.position?.x, node.position?.y, node.size?.width, node.size?.height].every(Number.isFinite) ||
      node.size.width <= 0 || node.size.height <= 0) {
      throw new Error(`geometry-invalid-scene: invalid dimensions for ${node.id}`)
    }
    if (node.premaxRect && (![node.premaxRect.x, node.premaxRect.y, node.premaxRect.width, node.premaxRect.height].every(Number.isFinite) ||
      node.premaxRect.width <= 0 || node.premaxRect.height <= 0)) {
      throw new Error(`geometry-invalid-scene: invalid restored dimensions for ${node.id}`)
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    const seen = new Set([node.id])
    let parentId = liveParentId(node, byId)
    while (parentId) {
      // A cycle has no honest top-level reading, so it still refuses.
      if (seen.has(parentId)) throw new Error(`geometry-invalid-scene: invalid parent for ${node.id}`)
      seen.add(parentId)
      parentId = liveParentId(byId.get(parentId)!, byId)
    }
  }
  return nodes.map((node) => ({
    id: node.id, type: node.kind, position: { ...node.position }, parentId: liveParentId(node, byId),
    width: node.size.width, height: node.collapsed ? COLLAPSED_HEIGHT : node.size.height,
    data: { collapsed: node.collapsed, expandedHeight: node.size.height,
      premaxRect: node.premaxRect && { ...node.premaxRect }, openedBy: node.openedBy }
  }))
}

/** Only geometry crosses back; credentials, launch claims and future metadata stay intact. */
export function applyStoredGeometry(original: readonly CanvasNodeState[], planned: readonly GeometryNode[]): CanvasNodeState[] {
  const byId = new Map(original.map((node) => [node.id, node]))
  return planned.map((geometry) => {
    const node = byId.get(geometry.id)
    if (!node) throw new Error(`geometry-invalid-plan: unexpected node ${geometry.id}`)
    const next = { ...node, position: { ...geometry.position }, size: {
      width: geometry.measured?.width ?? geometry.width ?? node.size.width,
      height: geometry.data.collapsed ? geometry.data.expandedHeight ?? node.size.height :
        geometry.measured?.height ?? geometry.height ?? node.size.height
    } }
    if (geometry.parentId) next.parentId = geometry.parentId
    // Only a real frame can be left. A missing one stays as found, or every geometry write would
    // rewrite a node nobody named, possibly another owner's.
    else if (liveParentId(node, byId)) delete next.parentId
    if (geometry.data.premaxRect) next.premaxRect = { ...geometry.data.premaxRect }
    else delete next.premaxRect
    return next
  })
}

/** The same wrapping transform as Desktop, retaining every persisted field of the members. */
export function wrapStoredNodes(nodes: readonly CanvasNodeState[], ids: string[], frame: CanvasNodeState, grid = 0): CanvasNodeState[] | null {
  if (frame.kind !== 'group' || nodes.some((node) => node.id === frame.id)) throw new Error('geometry-invalid-frame')
  const live = storedGeometryNodes(nodes)
  const next = wrapGeometryNodes(live, ids, (box) => ({
    id: frame.id, type: 'group', position: { x: box.x, y: box.y }, width: box.width, height: box.height, data: {}
  }), grid)
  return next === live ? null : applyStoredGeometry([...nodes, frame], next)
}
