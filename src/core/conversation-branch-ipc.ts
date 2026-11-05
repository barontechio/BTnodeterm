import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import type { ConversationBranchReply } from '../shared/conversation-branch'
import { isConversationBranchPosition, type ConversationBranchPosition } from '../shared/conversation-branch'
import type { CorePlatform } from './platform'
import { OwnerLifetimes, type AccountOwner } from './owner-lifetimes'

/** The UI's branch action is an owner operation, never an agent pretending to be its own caller. */
export function registerConversationBranchIpc(platform: CorePlatform,
  run: (nodeId: string, owner: AccountOwner, at?: ConversationBranchPosition) => Promise<ConversationBranchReply>): Pick<OwnerLifetimes, 'forget' | 'dispose'> {
  const owners = new OwnerLifetimes()
  platform.handleWithSender(IPC.controlBranchClaude, async (sender, id: unknown, at: unknown): Promise<ConversationBranchReply> => {
    if (!platform.clientIds().includes(sender) || platform.isOwnerClient?.(sender) !== true)
      return { ok: false, error: 'branch-owner-required' }
    if (typeof id !== 'string' || !isSafeNodeId(id)) return { ok: false, error: 'branch-invalid-node' }
    if (at != null && !isConversationBranchPosition(at)) return { ok: false, error: 'branch-invalid-position' }
    try {
      const owner = owners.get(sender, () => platform.clientIds().includes(sender) && platform.isOwnerClient?.(sender) === true)
      return await run(id, owner, at == null ? undefined : { x: at.x, y: at.y })
    } catch {
      return { ok: false, error: 'branch-uncertain: inspect the terminal and canvas before repeating branch.' }
    }
  })
  return owners
}
