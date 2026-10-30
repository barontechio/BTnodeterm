import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import { stableStringify } from '../shared/canvas-mutations'
import { LocalClaudeActionTarget, type LocalClaudeActionTargetDeps } from './local-claude-action-target'
import { isClaudeBranchSessionId, performClaudeBranch } from './claude-branch'
import type { OwnerConfirmationBroker, OwnerPermit } from './owner-confirmation'
import type { PtyManager } from './pty-manager'

type Reply = { ok: boolean; error?: string; message?: string; result?: unknown }
interface Dependencies extends LocalClaudeActionTargetDeps {
  pty: Pick<PtyManager, 'nodeExecutionIdentity' | 'runNodeAction' | 'paneOwner' | 'canBranchClaude' | 'branchClaudeInEmptyPrompt' | 'captureSession'>
  confirmations: Pick<OwnerConfirmationBroker, 'request'>
  originalAvailable(sessionId: string, accountId?: string): Promise<boolean>
  resumeOriginal(sourceId: string, targetId: string, originalId: string, current: () => boolean): Promise<Reply>
  onInputDispatched(nodeId: string, typedAt: number): void
}
const refused = (reason: string): Reply => ({ ok: false, error: `branch-refused: ${reason}; nothing was sent`, result: { outcome: 'refused' } })

/** Owner-confirmed branch of an existing pane, followed by an independently reserved resume node. */
export class ConfirmedNodeBranch {
  private readonly target: LocalClaudeActionTarget
  private readonly pending = new Set<string>()
  constructor(private readonly deps: Dependencies) { this.target = new LocalClaudeActionTarget(deps) }

  async run(sourceId: string, args: Record<string, string>, verified: boolean): Promise<Reply> {
    if (!verified || !args.node || sourceId === args.node || Object.keys(args).some((key) => key !== 'node'))
      return refused('requires a verified caller and a different --node, with no other flags')
    const targetId = args.node
    if (this.pending.has(targetId) || this.pending.size >= 32) return refused('another branch is pending or the host action budget is full; inspect pending owner requests')
    this.pending.add(targetId)
    let permit: Extract<OwnerPermit, { ok: true }> | undefined
    let possible = false; let tracked = false; let originalId: string | undefined; let provenSession: string | undefined
    const uncertain = (): Reply => provenSession ? { ok: false,
      error: 'branch-original-resume-uncertain: the branch is confirmed, but its original-resume node could not be confirmed. Inspect the canvas; do not repeat branch.',
      result: { outcome: 'branched', originalId, sessionId: provenSession } } : ({ ok: false,
      error: 'branch-uncertain: the command may have run. Do not repeat branch. Inspect the terminal and resume the original conversation manually if needed.',
      result: { outcome: 'uncertain', originalId } })
    try {
      const before = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
      const initial = this.deps.runtime(targetId).sessionId
      if (!isClaudeBranchSessionId(initial)) return refused('target has no verified Claude session id')
      originalId = initial
      const physical = this.deps.pty.nodeExecutionIdentity(targetId)
      if (!physical || !this.deps.pty.canBranchClaude(targetId)) return refused('target needs a live local POSIX tmux Claude pane')
      if (!(await this.deps.originalAvailable(originalId, before.target.accountId))) return refused('the original transcript is unavailable in the selected account')
      const foreground = await this.deps.pty.paneOwner(targetId)
      if (!foreground?.pids?.length || isAgentPane(foreground, 'claude') !== 'agent') return refused('foreground Claude process could not be proven')
      const foregroundBinding = stableStringify(foreground)
      let submitted = false
      const unchanged = (idle: boolean) => {
        try {
          if (this.deps.pty.nodeExecutionIdentity(targetId) !== physical || !this.deps.pty.canBranchClaude(targetId)) return false
          if (provenSession && this.deps.runtime(targetId).sessionId !== provenSession) return false
          const snapshot = this.target.snapshot(this.target.cachedWorkspace(), sourceId, targetId, idle,
            submitted ? { nodeId: targetId, runtimeSessionId: initial, savedSessionId: before.target.agentSessionId } : undefined)
          return snapshot.binding === before.binding
        } catch { return false }
      }
      if (!unchanged(true)) return refused('target changed during inspection')
      const answer = await this.deps.confirmations.request({ action: 'branch',
        requester: { nodeId: sourceId, projectId: before.projectId, title: before.source.title || sourceId },
        binding: { execution: before.binding, foreground: foregroundBinding, originalId },
        message: `Branch "${before.target.title || targetId}" (${targetId}) and open its original conversation in a new node?`,
        details: `The selected pane stays on the new branch. A new node resumes the original with the same account, folder and model.\nAccount: ${before.target.accountId || 'System account'}\nFolder: ${before.target.cwd || before.projectCwd || '(default)'}\nOriginal conversation: ${originalId}`,
        confirmLabel: 'Branch conversation', checkCurrent: async () => {
          const fresh = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
          return fresh.binding === before.binding && unchanged(true) &&
            await this.deps.originalAvailable(initial, before.target.accountId)
        } })
      if (!answer.ok) return refused(`owner confirmation ${answer.reason}; do not retry without the owner`)
      permit = answer
      if (!(await answer.consume())) return refused('owner approval or target is no longer current')
      const typedAt = Date.now()
      const mark = () => {
        possible = true
        if (!tracked) { tracked = true; this.deps.onInputDispatched(targetId, typedAt) }
      }
      const effect = await this.deps.pty.runNodeAction(targetId, 'branch', { timeoutMs: 30_000,
        current: () => answer.current() && unchanged(!submitted) }, async (execution) => {
        const fresh = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
        if (fresh.binding !== before.binding) throw new Error('saved branch target changed')
        if (!(await this.deps.originalAvailable(initial, before.target.accountId))) throw new Error('original transcript is no longer available')
        const owner = await this.deps.pty.paneOwner(targetId)
        execution.assertCurrent()
        if (stableStringify(owner) !== foregroundBinding) throw new Error('foreground process changed')
        const result = await performClaudeBranch(initial, { assertCurrent: execution.assertCurrent, signal: execution.signal,
          session: () => this.deps.runtime(targetId), capture: () => this.deps.pty.captureSession(targetId),
          submit: () => this.deps.pty.branchClaudeInEmptyPrompt(targetId, () => { submitted = true; mark() }),
          onDispatched: mark })
        if (result.outcome === 'branched') provenSession = result.sessionId
        return result
      })
      if (effect.outcome === 'refused') return refused(effect.reason)
      if (effect.outcome !== 'branched') return uncertain()
      // The old pane claim has finished. The continuation reserves its new id before publishing.
      const copy = await this.deps.resumeOriginal(sourceId, targetId, effect.originalId, () => answer.current() && unchanged(false))
      if (!copy.ok) return { ok: false, error: `branch-original-resume-incomplete: ${copy.error ?? 'inspect the saved canvas'}; do not repeat branch`,
        result: { outcome: 'branched', originalId, sessionId: effect.sessionId, resume: copy.result } }
      return { ok: true, message: 'Branched the selected pane and opened its original conversation; resumed startup is not confirmed.',
        result: { outcome: 'branched', originalId, sessionId: effect.sessionId, resume: copy.result } }
    } catch (error) {
      return possible ? uncertain() : refused(error instanceof Error ? error.message : String(error))
    } finally { permit?.cancel(); this.pending.delete(targetId) }
  }
}
