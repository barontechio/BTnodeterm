import type { NodeExecutionBatchPermit } from './node-execution'
import type { WorktreeRemovalJournal } from './worktree-removal-journal'

/** Persistent quarantine of known pending members. Neither a claimed node nor the 'worktree'
 * action label grants a bypass. Only the actual permit explicitly registered by the host recovery
 * transaction may dispatch, and only to its claimed nodes. It is never accepted from a client.
 * Actor authorization, fresh owner approval and directory/identity proof remain domain duties.
 */
export class WorktreeRecoveryDispatch {
  private recovering = new WeakSet<NodeExecutionBatchPermit>()
  constructor(private readonly journal: Pick<WorktreeRemovalJournal, 'isNodePending'>) {}

  assertAllowed(nodeId: string, permit?: NodeExecutionBatchPermit): void {
    if (!this.journal.isNodePending(nodeId)) return
    if (permit && this.recovering.has(permit) && permit.nodeIds.includes(nodeId) && permit.current()) return
    throw new Error('worktree-recovery-required: this terminal has pending worktree recovery; input and execution were refused')
  }

  async withRecovery<T>(permit: NodeExecutionBatchPermit, work: () => Promise<T> | T): Promise<T> {
    permit.assertCurrent()
    if (permit.kind !== 'worktree' || this.recovering.has(permit)) throw new Error('worktree-recovery-invalid-permit')
    this.recovering.add(permit)
    try { permit.assertCurrent(); return await work() }
    finally { this.recovering.delete(permit) }
  }
}
