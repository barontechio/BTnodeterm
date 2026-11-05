import type { NodeTerminalApi } from '@shared/types'
import type { ConversationBranchPosition, ConversationBranchReply } from '@shared/conversation-branch'

/** The host owns the pane reservation, fresh branch proof and durable original-resume node. */
export async function branchClaudeSession(api: NodeTerminalApi, nodeId: string, at?: ConversationBranchPosition): Promise<ConversationBranchReply> {
  if (!api.control?.branchClaude) return { ok: false, error: 'Conversation branching requires a host with coordinated branch support.' }
  try { return await api.control.branchClaude(nodeId, at) }
  catch { return { ok: false, error: 'The branch result could not be confirmed. Inspect the terminal and canvas before repeating branch.' } }
}
