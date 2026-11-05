import type { NodeExecutionBatchPermit, NodeExecutionDispatch } from './node-execution'
import type { WorktreeRemovalJournal } from './worktree-removal-journal'

/** Persistent quarantine of known pending members. Neither a claimed node nor the 'worktree'
 * action label grants a bypass. Only the actual permit explicitly registered by the host recovery
 * transaction may dispatch, and only to its claimed nodes. It is never accepted from a client.
 * Actor authorization, fresh owner approval and directory/identity proof remain domain duties.
 */
export class WorktreeRecoveryDispatch {
  private recovering = new WeakSet<NodeExecutionBatchPermit>()
  private creating = new WeakMap<NodeExecutionBatchPermit, { nodeId: string; binding: string; live: boolean; spent: boolean; target?: object; existing?: object; current(): void }>()
  private resumed = new Map<string, { target: object; current(): boolean }>()
  constructor(private readonly journal: Pick<WorktreeRemovalJournal, 'isNodePending'>) {}

  assertAllowed(nodeId: string, permit?: NodeExecutionBatchPermit, dispatch?: NodeExecutionDispatch): void {
    if (!this.journal.isNodePending(nodeId)) return
    if (permit && this.recovering.has(permit) && permit.nodeIds.includes(nodeId) && permit.current()) return
    const create = permit && this.creating.get(permit)
    if (create?.live && create.nodeId === nodeId && dispatch?.binding === create.binding &&
      (dispatch.kind === 'create' || dispatch.kind === 'spawn' || dispatch.kind === 'register')) {
      permit!.assertCurrent(); create.current()
      if (dispatch.kind === 'register') {
        if (!dispatch.target || (!create.spent && dispatch.target !== create.existing))
          throw new Error('worktree-manual-session-unproven')
        create.target = dispatch.target
      }
      if (dispatch.kind === 'spawn') {
        if (create.spent) throw new Error('worktree-manual-create-already-dispatched')
        create.spent = true
      }
      return
    }
    const live = this.resumed.get(nodeId)
    if (live && dispatch?.target === live.target &&
      (dispatch.kind === 'input' || dispatch.kind === 'create')) {
      if (live.current()) return
      this.resumed.delete(nodeId)
    }
    throw new Error('worktree-recovery-required: this terminal has pending worktree recovery; input and execution were refused')
  }

  /** One physical create under the actual restart claim. It never grants input/control. */
  async withManualCreate<T>(permit: NodeExecutionBatchPermit, nodeId: string, binding: string,
    current: () => void, work: () => Promise<T>, existing?: object): Promise<T> {
    permit.assertCurrent(); current()
    if (permit.kind !== 'restart' || !permit.nodeIds.includes(nodeId) || this.creating.has(permit))
      throw new Error('worktree-manual-create-invalid-permit')
    const scope = { nodeId, binding, live: true, spent: false, current, existing }
    this.creating.set(permit, scope)
    try { return await work() }
    finally { scope.live = false; this.creating.delete(permit) }
  }

  /** Only after the guarded durable observation. The journal restriction itself remains.
   * The caller must identify the target carried by the actual input/attach operation too. */
  admitManualSession(permit: NodeExecutionBatchPermit, nodeId: string, target: object, current: () => boolean): void {
    permit.assertCurrent()
    const scope = this.creating.get(permit)
    if (permit.kind !== 'restart' || !permit.nodeIds.includes(nodeId) || !scope?.live || scope.target !== target || !current())
      throw new Error('worktree-manual-session-changed')
    scope.current()
    this.resumed.set(nodeId, { target, current })
  }

  revokeManualSession(nodeId: string, target: object): void {
    if (this.resumed.get(nodeId)?.target === target) this.resumed.delete(nodeId)
  }

  manualSessionActive(nodeId: string): boolean {
    const session = this.resumed.get(nodeId)
    if (!session) return false
    if (session.current()) return true
    this.resumed.delete(nodeId); return false
  }

  async withRecovery<T>(permit: NodeExecutionBatchPermit, work: () => Promise<T> | T): Promise<T> {
    permit.assertCurrent()
    if (permit.kind !== 'worktree' || this.recovering.has(permit)) throw new Error('worktree-recovery-invalid-permit')
    this.recovering.add(permit)
    try { permit.assertCurrent(); return await work() }
    finally { this.recovering.delete(permit) }
  }
}
