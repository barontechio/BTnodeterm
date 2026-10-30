import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import type { WorktreeRecoveryInspection, WorktreeRecoveryKeepReply, WorktreeRecoveryList } from '../shared/worktree-recovery'
import type { CorePlatform } from './platform'
import { OwnerLifetimes } from './owner-lifetimes'
import type { WorktreeRecoveryService } from './worktree-recovery-service'

/** Recovery administration belongs to the physical core owner, never to an agent or relay tab.
 * A request carries only an immutable host record id, not paths, commands or approval flags. */
export function registerWorktreeRecoveryIpc(platform: CorePlatform, service: () => Pick<WorktreeRecoveryService, 'list' | 'inspect' | 'keep'> | null): Pick<OwnerLifetimes, 'forget' | 'dispose'> {
  const owners = new OwnerLifetimes()
  const eligible = (sender: number) => platform.clientIds().includes(sender) && platform.isOwnerClient?.(sender) === true
  const owner = (sender: number) => owners.get(sender, () => eligible(sender))
  platform.handleWithSender(IPC.worktreeRecoveryList, (sender): WorktreeRecoveryList | null => {
    if (!eligible(sender)) return null
    try { const actor = owner(sender); return service()?.list(actor) ?? null }
    catch { return null }
  })
  platform.handleWithSender(IPC.worktreeRecoveryInspect, async (sender, id: unknown): Promise<WorktreeRecoveryInspection> => {
    if (!eligible(sender)) return { ok: false, error: 'worktree-recovery-owner-required' }
    try {
      const actor = owner(sender)
      if (typeof id !== 'string' || !isSafeNodeId(id)) return { ok: false, error: 'worktree-recovery-invalid-reference' }
      return await service()?.inspect(id, actor) ?? { ok: false, error: 'Recovery administration is unavailable on this host.' }
    } catch { return { ok: false, error: 'Recovery could not be inspected. Reload its status.' } }
  })
  platform.handleWithSender(IPC.worktreeRecoveryKeep, async (sender, id: unknown): Promise<WorktreeRecoveryKeepReply> => {
    if (!eligible(sender)) return { ok: false, outcome: 'refused', error: 'worktree-recovery-owner-required' }
    try {
      const actor = owner(sender)
      if (typeof id !== 'string' || !isSafeNodeId(id)) return { ok: false, outcome: 'refused', error: 'worktree-recovery-invalid-reference' }
      return await service()?.keep(id, actor) ?? { ok: false, outcome: 'refused', error: 'Recovery administration is unavailable on this host.' }
    } catch { return { ok: false, outcome: 'uncertain', error: 'Recovery may have completed. Reload its status before another action.' } }
  })
  return owners
}
