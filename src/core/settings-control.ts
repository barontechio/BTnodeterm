import { canControlCanvas, type AgentId } from '../shared/agents/config'
import { stableStringify } from '../shared/canvas-mutations'
import { setProjectCapability } from '../shared/project-capability-consent'
import { isRemoteSessionNode } from '../shared/worktree'
import { parseSettingsRequest, planSettingsSet, readSettingsValue, renderSettingsGet,
  SETTINGS_VERB_KEY_LIST, type SettingsRequest } from '../shared/settings-verb'
import type { CanvasNodeState, Project, Settings, Workspace } from '../shared/types'
import type { OwnerConfirmationBroker } from './owner-confirmation'
import type { SettingsStore } from './settings-store'
import type { WorkspaceStore } from './workspace-store'
import type { ServerControlReply } from './headless-node-factory'

export interface SettingsControlDeps {
  workspace: Pick<WorkspaceStore, 'load' | 'updateWorkspace' | 'getNodeResolved' | 'projectIdsForNode' | 'projectTargetInfo'>
  settings: Pick<SettingsStore, 'get' | 'update'>
  confirmations: Pick<OwnerConfirmationBroker, 'request'>
  runtime(nodeId: string): { agentId?: string; sessionId?: string }
  publish(project: Project): void
  stopped?(): boolean
}
const refuse = (error: string): ServerControlReply => ({ ok: false, error, message: error })

/** No command/workspace lock is held while an owner considers a request. */
export class SettingsControl {
  constructor(private readonly deps: SettingsControlDeps) {}

  private identity(project: Pick<Project, 'id' | 'cwd' | 'ssh'>, node: CanvasNodeState): string {
    const runtime = this.deps.runtime(node.id)
    if (this.deps.stopped?.() || project.ssh || isRemoteSessionNode(node) ||
      !runtime.sessionId || !canControlCanvas((node.agentId || runtime.agentId) as AgentId)) throw new Error('settings-source-refused')
    return stableStringify({ projectId: project.id, projectCwd: project.cwd, nodeId: node.id, kind: node.kind,
      agentId: node.agentId, runtime, cwd: node.cwd, accountId: node.accountId, agentSessionId: node.agentSessionId })
  }

  private source(workspace: Workspace, nodeId: string): { project: Project; node: CanvasNodeState; identity: string } {
    const matches = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === nodeId).map((node) => ({ project, node })))
    if (matches.length !== 1 || matches[0].project.unavailable) throw new Error('settings-source-refused')
    const { project, node } = matches[0]
    return { project, node, identity: this.identity(project, node) }
  }

  private plan(request: Extract<SettingsRequest, { action: 'set' }>, project: Project, node: CanvasNodeState, settings: Settings) {
    return planSettingsSet({ request, project, settings, requestedBy: node.title || node.id })
  }

  async run(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    if (!verified) return refuse('settings-identity-refused: verified node identity is required')
    const request = parseSettingsRequest(structuredClone(args))
    if ('error' in request) return refuse(request.error)
    try {
      const source = this.source(await this.deps.workspace.load({ sideline: false }), sourceNodeId)
      if (request.project && request.project !== source.project.id) return refuse('project-target-refused: settings can only address the caller project here')
      if (request.action !== 'set') return renderSettingsGet({ keys: request.action === 'get' ? [request.key] : SETTINGS_VERB_KEY_LIST,
        project: source.project, settings: this.deps.settings.get() })
      const before = this.deps.settings.get()
      const plan = this.plan(request, source.project, source.node, before)
      if (plan.kind === 'error') return refuse(plan.error)
      if (plan.kind === 'unchanged') return { ok: true, message: plan.message }
      // The raw capability + this machine's answer are part of consent, even when effective values
      // happen to match. An unrelated field edit may proceed without invalidating this request.
      const binding = (project: Project, node: CanvasNodeState, settings: Settings) => stableStringify({
        identity: this.identity(project, node), request, plan: this.plan(request, project, node, settings),
        current: readSettingsValue(request.key, settings, project),
        ...(plan.change.scope === 'project' ? { file: project.agentMessaging, answer: project.capabilityAck?.agentMessaging,
          default: settings.agentMessagingDefault } : {})
      })
      const expected = binding(source.project, source.node, before)
      const permit = await this.deps.confirmations.request({ action: 'settings',
        requester: { nodeId: sourceNodeId, projectId: source.project.id, title: source.node.title || sourceNodeId },
        binding: { exact: expected }, message: plan.message, confirmLabel: plan.confirmLabel, danger: plan.danger,
        checkCurrent: async () => {
          const current = this.source(await this.deps.workspace.load({ sideline: false }), sourceNodeId)
          return binding(current.project, current.node, this.deps.settings.get()) === expected
        }
      })
      if (!permit.ok) return refuse(`settings-confirmation-${permit.reason}: nothing changed; do not retry without the owner`)
      if (!(await permit.consume())) return refuse('settings-confirmation-stale: source, setting or owner connection changed; nothing changed')
      if (plan.change.scope === 'machine') {
        const patch = plan.change.patch
        await this.deps.settings.update((current) => {
          if (!permit.current()) throw new Error('settings-confirmation-stale')
          const ids = this.deps.workspace.projectIdsForNode(sourceNodeId)
          const node = this.deps.workspace.getNodeResolved(sourceNodeId)
          const project = this.deps.workspace.projectTargetInfo(source.project.id)
          if (ids.length !== 1 || ids[0] !== source.project.id || !node || !project ||
            binding({ ...source.project, ...project }, node, current) !== expected) throw new Error('settings-confirmation-stale')
          return { ...current, ...patch }
        })
      } else {
        const change = plan.change
        const result = await this.deps.workspace.updateWorkspace((workspace) => {
          if (!permit.current()) throw new Error('settings-confirmation-stale')
          const current = this.source(workspace, sourceNodeId)
          if (binding(current.project, current.node, this.deps.settings.get()) !== expected) throw new Error('settings-confirmation-stale')
          workspace.projects = workspace.projects.map((project) => project.id === change.projectId
            ? setProjectCapability(project, change.capability, change.on) : project)
          return workspace
        })
        const project = result.workspace.projects.find((p) => p.id === change.projectId)
        if (project) { try { this.deps.publish(project) } catch { /* the consent is already durable */ } }
      }
      return { ok: true, message: plan.done, result: { key: request.key, value: request.value } }
    } catch (error) { return refuse(`settings-not-confirmed: ${error instanceof Error ? error.message : String(error)}; inspect the current setting before retrying`) }
  }
}
