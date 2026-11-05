// Pure wire guard shared by host publication and atomic UI reception. No I/O or authority.
import { isCanvasMutation, MUTATION_MAX_BYTES } from './canvas-mutations'
import type { CanvasMutationBatch, CanvasNodeState } from './types'

export const CANVAS_BATCH_MAX_MUTATIONS = 1024
export const CANVAS_BATCH_MAX_BYTES = MUTATION_MAX_BYTES

/** A node's structural coordinate frame. Content and runtime/session identity are not layout. */
export type CanvasLayoutTuple = Pick<CanvasNodeState,
  'kind' | 'parentId' | 'position' | 'size' | 'collapsed' | 'premaxRect' | 'dynamicGroup'>

export function canvasLayoutOf(node: CanvasLayoutTuple): CanvasLayoutTuple {
  return structuredClone({ kind: node.kind, position: node.position, size: node.size,
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    ...(node.collapsed !== undefined ? { collapsed: node.collapsed } : {}),
    ...(node.premaxRect !== undefined ? { premaxRect: node.premaxRect } : {}),
    ...(node.dynamicGroup !== undefined ? { dynamicGroup: node.dynamicGroup } : {}) })
}

/** Keep local title/text/credentials while installing precisely the canonical layout. */
export function applyCanvasLayout(node: CanvasNodeState, tuple: CanvasLayoutTuple): CanvasNodeState {
  const { parentId: _p, collapsed: _c, premaxRect: _r, dynamicGroup: _d, ...rest } = node
  return { ...rest, ...canvasLayoutOf(tuple) }
}

/** Validate the complete flat envelope before sanitizing, stamping or observing any child. */
export function isCanvasMutationBatch(value: unknown): value is CanvasMutationBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const batch = value as CanvasMutationBatch
  if (Object.keys(batch).some((key) => key !== 'mutations') || !Array.isArray(batch.mutations) ||
    batch.mutations.length === 0 || batch.mutations.length > CANVAS_BATCH_MAX_MUTATIONS) return false
  try {
    return batch.mutations.every(isCanvasMutation) && JSON.stringify(batch).length <= CANVAS_BATCH_MAX_BYTES
  } catch { return false }
}
