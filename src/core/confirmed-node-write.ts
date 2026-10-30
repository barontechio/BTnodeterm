import { canControlCanvas, type AgentId } from '../shared/agents/config'
import type { AgentState } from '../shared/agents/normalize'
import { isAgentPane, type PaneOwner } from '../shared/agents/pane-owner-predicate'
import { stableStringify } from '../shared/canvas-mutations'
import type { ControlScope } from '../shared/control-scope'
import { TEXT_NOT_SUBMITTED } from '../shared/text-delivery'
import type { CanvasNodeState, Project, Settings, Workspace } from '../shared/types'
import { isRemoteSessionNode } from '../shared/worktree'
import type { OwnerConfirmationBroker, OwnerPermit } from './owner-confirmation'
import type { PtyManager } from './pty-manager'
import type { WorkspaceStore } from './workspace-store'

interface Runtime { agentId?: string; sessionId?: string; state?: AgentState; verified: boolean }
interface Dependencies {
  workspace: Pick<WorkspaceStore, 'load' | 'persistedCanvases' | 'projectTargetInfo'>
  pty: Pick<PtyManager, 'nodeExecutionIdentity' | 'runNodeAction' | 'paneOwner' | 'sendToEmptyPrompt'>
  confirmations: Pick<OwnerConfirmationBroker, 'request'>
  settings(): Settings
  runtime(nodeId: string): Runtime
  scope(): ControlScope
  /** The existing process-local creator ledger, never a second trust registry. */
  ownsSpawn(sourceId: string, targetId: string): boolean
  handedOver(nodeId: string): boolean
  /** Update the existing handover tracker before releasing this node's exclusion. */
  onInputDispatched(nodeId: string, typedAt: number): void
  stopped(): boolean
}
type Reply = { ok: boolean; message?: string; error?: string; result?: unknown }
interface Snapshot { projectId: string; source: CanvasNodeState; target: CanvasNodeState; binding: string }
const refuse = (reason: string): Reply => ({ ok: false, error: `write-refused: ${reason}; nothing was sent`, result: { outcome: 'refused' } })

/** Owner-approved input into an existing live pane. Never launches, switches accounts or retries. */
export class ConfirmedNodeWrite {
  constructor(private readonly deps: Dependencies) {}

  private cachedWorkspace(): Workspace {
    const projects = this.deps.workspace.persistedCanvases().flatMap((canvas) => {
      const info = this.deps.workspace.projectTargetInfo(canvas.id)
      return info ? [{ ...canvas, ...info, color: '', viewport: { x: 0, y: 0, zoom: 1 } }] : []
    })
    return { version: 2, activeProjectId: '', projects }
  }

  private snapshot(workspace: Workspace, sourceId: string, targetId: string, requireIdle: boolean): Snapshot {
    if (this.deps.stopped()) throw new Error('host control is stopped')
    const find = (id: string): { project: Project; node: CanvasNodeState } => {
      const hits = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === id).map((node) => ({ project, node })))
      if (hits.length !== 1 || hits[0].project.unavailable) throw new Error('node must belong to exactly one available project')
      return hits[0]
    }
    const source = find(sourceId); const target = find(targetId)
    if (source.project.id !== target.project.id) throw new Error('target is outside the caller project')
    if (source.project.ssh || target.project.ssh || isRemoteSessionNode(source.node) || isRemoteSessionNode(target.node))
      throw new Error('SSH input is unavailable on this adapter')
    const caller = this.deps.runtime(sourceId); const runtime = this.deps.runtime(targetId)
    if (!caller.verified || !caller.sessionId || !canControlCanvas((source.node.agentId || caller.agentId) as AgentId))
      throw new Error('caller session is not verified')
    const owns = this.deps.ownsSpawn(sourceId, targetId); const scope = this.deps.scope()
    if (scope !== 'project' && !owns) throw new Error('target was not created by this caller during this host run')
    // Other backends need their own measured empty-composer reader before they can accept this verb.
    if (target.node.kind !== 'terminal' || target.node.agentId !== 'claude' || runtime.agentId !== 'claude' || !runtime.verified || !runtime.sessionId)
      throw new Error('target must be a verified local Claude terminal')
    if (target.node.pendingLaunch) throw new Error('target still has a held launch')
    if (requireIdle && runtime.state !== 'done') throw new Error('target is working, awaiting input or has unknown state')
    if (requireIdle && this.deps.handedOver(targetId)) throw new Error('previous handed-over input has not completed; inspect the terminal')
    const settings = this.deps.settings()
    const account = target.node.accountId ? settings.claudeAccounts.find((entry) => entry.id === target.node.accountId) : undefined
    if (target.node.accountId && (!account || account.pending || account.host)) throw new Error('target account is unavailable on this host')
    const execution = (node: CanvasNodeState, current: Runtime) => ({ id: node.id, kind: node.kind, agentId: node.agentId,
      runtimeAgent: current.agentId, sessionId: current.sessionId, verified: current.verified, accountId: node.accountId,
      cwd: node.cwd, ssh: node.ssh, sshRemoteTmux: node.sshRemoteTmux, worktree: node.worktree,
      agentSessionId: node.agentSessionId, pendingLaunch: node.pendingLaunch, shell: node.shell, clearEnv: node.clearEnv })
    return { projectId: source.project.id, source: source.node, target: target.node,
      binding: stableStringify({ projectId: source.project.id, cwd: source.project.cwd, scope, owns,
        source: execution(source.node, caller), target: execution(target.node, runtime),
        account: account ? { id: account.id, pending: account.pending, host: account.host } : null }) }
  }

  async run(sourceId: string, args: Record<string, string>, verified: boolean): Promise<Reply> {
    if (!verified) return refuse('verified caller identity is required')
    if (Object.keys(args).some((key) => key !== 'node' && key !== 'text') || !args.node ||
      typeof args.text !== 'string' || !args.text.trim() || args.text.includes('\0') || Buffer.byteLength(args.text) > 64 * 1024)
      return refuse('requires --node and non-empty --text (at most 64 KiB), with no other flags')
    const targetId = args.node; const text = args.text
    let dispatched = false
    let permit: Extract<OwnerPermit, { ok: true }> | undefined
    try {
      const before = this.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
      const physical = this.deps.pty.nodeExecutionIdentity(targetId)
      if (!physical) return refuse('target has no live pane on this host')
      const owner = await this.deps.pty.paneOwner(targetId)
      if (!owner || isAgentPane(owner, 'claude') !== 'agent' || !owner.pids?.length) return refuse('foreground Claude process could not be proven')
      const ownerBinding = stableStringify(owner)
      const unchanged = (requireIdle: boolean) => {
        try { return this.deps.pty.nodeExecutionIdentity(targetId) === physical &&
          this.snapshot(this.cachedWorkspace(), sourceId, targetId, requireIdle).binding === before.binding }
        catch { return false }
      }
      if (!unchanged(true)) return refuse('target changed during inspection')
      const answer = await this.deps.confirmations.request({ action: 'write',
        requester: { nodeId: sourceId, projectId: before.projectId, title: before.source.title || sourceId },
        binding: { execution: before.binding, foreground: ownerBinding, text },
        message: `Write to "${before.target.title || targetId}" (${targetId}) and submit it?`,
        details: text, confirmLabel: 'Write and submit',
        checkCurrent: async () => {
          const fresh = this.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
          return fresh.binding === before.binding && unchanged(true)
        }
      })
      if (!answer.ok) return refuse(`owner confirmation ${answer.reason}; do not retry without the owner`)
      permit = answer
      if (!(await permit.consume())) return refuse('owner approval or target is no longer current')
      const result = await this.deps.pty.runNodeAction(targetId, 'write', { timeoutMs: 30_000,
        current: () => answer.current() && unchanged(false) }, async (execution) => {
        const fresh = this.snapshot(await this.deps.workspace.load({ sideline: false }), sourceId, targetId, true)
        if (fresh.binding !== before.binding) throw new Error('saved target changed')
        const foreground: PaneOwner | null = await this.deps.pty.paneOwner(targetId)
        execution.assertCurrent()
        if (stableStringify(foreground) !== ownerBinding) throw new Error('foreground process changed')
        this.snapshot(this.cachedWorkspace(), sourceId, targetId, true)
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
