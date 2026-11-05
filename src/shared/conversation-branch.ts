import { PLACE_COORD_MAX } from './geometry-verbs'

export interface ConversationBranchPosition { x: number; y: number }
export function isConversationBranchPosition(value: unknown): value is ConversationBranchPosition {
  if (!value || typeof value !== 'object') return false
  return ['x', 'y'].every((key) => { const coordinate = (value as Record<string, unknown>)[key]
    return typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= PLACE_COORD_MAX })
}

/** A branch effect and recovery-node result. Never retry after an uncertain transport reply. */
export interface ConversationBranchReply {
  ok: boolean
  message?: string
  error?: string
  newNodeId?: string
  result?: unknown
}
