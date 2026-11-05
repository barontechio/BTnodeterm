import { normalizeDynamicGroupState } from '@shared/dynamic-groups'

type Frame = { id: string; type?: string; kind?: string; dynamicGroup?: unknown; data?: { dynamicGroup?: unknown } }

/** Shared early gate for live and stored frame removal. Run before bindings, history or PTYs. */
export function retireFramesIfAvailable(nodes: readonly Frame[], ids: readonly string[],
  retire: () => void, blocked?: () => void): boolean {
  const selected = new Set(ids)
  if (nodes.some((node) => selected.has(node.id) && (node.type === 'group' || node.kind === 'group') &&
    normalizeDynamicGroupState(node.data?.dynamicGroup ?? node.dynamicGroup)?.reservations.some((slot) => slot.state === 'reserved'))) {
    blocked?.()
    return false
  }
  retire()
  return true
}
