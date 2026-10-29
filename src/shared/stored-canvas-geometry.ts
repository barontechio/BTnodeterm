import type { CanvasNodeState } from './types'
import type { GeometryNode } from './canvas-geometry'
import { COLLAPSED_HEIGHT } from './node-sizing'

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
    let parentId = node.parentId
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent || parent.kind !== 'group' || seen.has(parentId)) {
        throw new Error(`geometry-invalid-scene: invalid parent for ${node.id}`)
      }
      seen.add(parentId)
      parentId = parent.parentId
    }
  }
  return nodes.map((node) => ({
    id: node.id, type: node.kind, position: { ...node.position }, parentId: node.parentId,
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
    else delete next.parentId
    if (geometry.data.premaxRect) next.premaxRect = { ...geometry.data.premaxRect }
    else delete next.premaxRect
    return next
  })
}
