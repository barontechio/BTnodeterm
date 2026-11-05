import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import type { AgentMessageReply } from '../../shared/agents/agent-messaging'

/** Only a live owner composing a comment can request pane delivery. Log replay has no entry here. */
export function registerBoardCommentDeliveryIpc(platform: CorePlatform, deps: {
  eligibleOwner(senderId: number): boolean
  deliver(raw: unknown): Promise<AgentMessageReply>
}): void {
  platform.handleWithSender(IPC.agentBoardCommentDeliver, (senderId, raw: unknown) => {
    if (platform.isOwnerClient?.(senderId) !== true || !deps.eligibleOwner(senderId)) return {
      ok: false, error: 'Board comments are delivered only by the live host owner.',
      result: { kind: 'notPermitted', reason: 'owner-required' }
    }
    return deps.deliver(raw)
  })
}
