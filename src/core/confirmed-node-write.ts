import { LocalClaudeActionTarget, type LocalClaudeActionTargetDeps } from './local-claude-action-target'
import { isAgentPane, type PaneOwner } from '../shared/agents/pane-owner-predicate'
import { stableStringify } from '../shared/canvas-mutations'
import { TEXT_NOT_SUBMITTED } from '../shared/text-delivery'
import type { OwnerConfirmationBroker, OwnerPermit } from './owner-confirmation'
import type { PtyManager } from './pty-manager'

interface Dependencies extends LocalClaudeActionTargetDeps {
  pty: Pick<PtyManager, 'nodeExecutionIdentity' | 'runNodeAction' | 'paneOwner' | 'sendToEmptyPrompt'>
  confirmations: Pick<OwnerConfirmationBroker, 'request'>
  onInputDispatched(nodeId: string, typedAt: number): void
}

type Reply = { ok: boolean; message?: string; error?: string; result?: unknown }
const refuse = (reason: string): Reply => ({ ok: false, error: `write-refused: ${reason}; nothing was sent`, result: { outcome: 'refused' } })

/** Owner-approved input into an existing live pane. Never launches, switches accounts or retries. */
export class ConfirmedNodeWrite {
  private readonly target: LocalClaudeActionTarget
  constructor(private readonly deps: Dependencies) { this.target = new LocalClaudeActionTarget(deps) }

  async run(sourceId: string, args: Record<string, string>, verified: boolean): Promise<Reply> {
    if (!verified) return refuse('verified caller identity is required')
    if (Object.keys(args).some((key) => key !== 'node' && key !== 'text') || !args.node ||
      typeof args.text !== 'string' || !args.text.trim() || args.text.includes('\0') || Buffer.byteLength(args.text) > 64 * 1024)
      return refuse('requires --node and non-empty --text (at most 64 KiB), with no other flags')
    const targetId = args.node; const text = args.text
    let dispatched = false
    let permit: Extract<OwnerPermit, { ok: true }> | undefined
    try {
      const before = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
      const physical = this.deps.pty.nodeExecutionIdentity(targetId)
      if (!physical) return refuse('target has no live pane on this host')
      const owner = await this.deps.pty.paneOwner(targetId)
      if (!owner || isAgentPane(owner, 'claude') !== 'agent' || !owner.pids?.length) return refuse('foreground Claude process could not be proven')
      const ownerBinding = stableStringify(owner)
      const unchanged = (requireIdle: boolean) => {
        try { return this.deps.pty.nodeExecutionIdentity(targetId) === physical &&
          this.target.snapshot(this.target.cachedWorkspace(sourceId, targetId), sourceId, targetId, requireIdle).binding === before.binding }
        catch { return false }
      }
      if (!unchanged(true)) return refuse('target changed during inspection')
      const answer = await this.deps.confirmations.request({ action: 'write',
        requester: { nodeId: sourceId, projectId: before.projectId, title: before.source.title || sourceId },
        binding: { execution: before.binding, foreground: ownerBinding, text },
        message: `Write to "${before.target.title || targetId}" (${targetId}) and submit it?`,
        details: text, confirmLabel: 'Write and submit',
        checkCurrent: async () => {
          const fresh = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
          return fresh.binding === before.binding && unchanged(true)
        }
      })
      if (!answer.ok) return refuse(`owner confirmation ${answer.reason}; do not retry without the owner`)
      permit = answer
      if (!(await permit.consume())) return refuse('owner approval or target is no longer current')
      const result = await this.deps.pty.runNodeAction(targetId, 'write', { timeoutMs: 30_000,
        current: () => answer.current() && unchanged(false) }, async (execution) => {
        const fresh = this.target.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
        if (fresh.binding !== before.binding) throw new Error('saved target changed')
        const foreground: PaneOwner | null = await this.deps.pty.paneOwner(targetId)
        execution.assertCurrent()
        if (stableStringify(foreground) !== ownerBinding) throw new Error('foreground process changed')
        this.target.snapshot(this.target.cachedWorkspace(sourceId, targetId), sourceId, targetId, true)
        const typedAt = Date.now()
        dispatched = true
        try {
          const delivered = await this.deps.pty.sendToEmptyPrompt(targetId, text, 'claude')
          if (delivered.sent) return { ok: true, message: 'sent', result: { outcome: 'submitted', typedAt } }
          if (delivered.reason === 'failed' || delivered.reason === 'not-submitted')
            return { ok: false, error: TEXT_NOT_SUBMITTED, result: { outcome: 'uncertain', typedAt } }
          // Draft/dialog refusals are produced before the delivery writes any bytes.
          dispatched = false
          return refuse(`composer ${delivered.reason}`)
        } finally {
          // A hook may arrive later than this answer. Preserve the hold for uncertain sends too.
          if (dispatched) this.deps.onInputDispatched(targetId, typedAt)
        }
      })
      return result
    } catch (error) {
      return dispatched ? { ok: false, error: TEXT_NOT_SUBMITTED, result: { outcome: 'uncertain' } }
        : refuse(error instanceof Error ? error.message : String(error))
    } finally { permit?.cancel() }
  }
}
