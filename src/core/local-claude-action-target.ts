import { canControlCanvas, type AgentId } from '../shared/agents/config'
import type { AgentState } from '../shared/agents/normalize'
import { stableStringify } from '../shared/canvas-mutations'
import type { ControlScope } from '../shared/control-scope'
import type { CanvasNodeState, Project, Settings, Workspace } from '../shared/types'
import { isRemoteSessionNode } from '../shared/worktree'
import type { WorkspaceStore } from './workspace-store'

export interface LocalClaudeActionRuntime { agentId?: string; sessionId?: string; state?: AgentState; verified: boolean }
type Runtime = LocalClaudeActionRuntime
export interface LocalClaudeActionTargetDeps {
  workspace: Pick<WorkspaceStore, 'load' | 'persistedCanvases' | 'projectTargetInfo' | 'getNodeForHostAction'>
  settings(): Settings
  runtime(nodeId: string): LocalClaudeActionRuntime
  scope(): ControlScope
  ownsSpawn(sourceId: string, targetId: string): boolean
  handedOver(nodeId: string): boolean
  stopped(): boolean
}
export interface LocalClaudeActionSnapshot { projectId: string; projectCwd?: string; source: CanvasNodeState; target: CanvasNodeState; binding: string }
export interface ClaudeActionSessionTransition { nodeId: string; runtimeSessionId: string; savedSessionId?: string }

/** Shared saved-target/account policy for owner-approved actions on a live local Claude pane. */
export class LocalClaudeActionTarget {
  constructor(private readonly deps: LocalClaudeActionTargetDeps) {}
  cachedWorkspace(sourceId: string, targetId: string): Workspace {
    const endpoints = new Set([sourceId, targetId])
    const projects = this.deps.workspace.persistedCanvases().flatMap((canvas) => {
      const info = this.deps.workspace.projectTargetInfo(canvas.id)
      const nodes = canvas.nodes.filter((node) => endpoints.has(node.id)).flatMap((node) => {
        const owned = this.deps.workspace.getNodeForHostAction(node.id)
        return owned ? [owned] : []
      })
      return info ? [{ ...canvas, ...info, nodes, color: '', viewport: { x: 0, y: 0, zoom: 1 } }] : []
    })
    return { version: 2, activeProjectId: '', projects }
  }

  snapshot(workspace: Workspace, sourceId: string, targetId: string, requireIdle: boolean,
    transition?: ClaudeActionSessionTransition): LocalClaudeActionSnapshot {
    return this.resolve(workspace, sourceId, targetId, requireIdle, transition, false)
  }

  /** Host-only owner entry; a human action has no agent caller or creator grant. */
  snapshotForOwner(workspace: Workspace, targetId: string, requireIdle: boolean,
    transition?: ClaudeActionSessionTransition): LocalClaudeActionSnapshot {
    return this.resolve(workspace, targetId, targetId, requireIdle, transition, true)
  }

  private resolve(workspace: Workspace, sourceId: string, targetId: string, requireIdle: boolean,
    transition: ClaudeActionSessionTransition | undefined, owner: boolean): LocalClaudeActionSnapshot {
    if (transition && (transition.nodeId !== targetId || (!owner && sourceId === targetId))) throw new Error('invalid target session transition')
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
    if (!owner && (!caller.verified || !caller.sessionId || !canControlCanvas((source.node.agentId || caller.agentId) as AgentId)))
      throw new Error('caller session is not verified')
    const owns = owner ? false : this.deps.ownsSpawn(sourceId, targetId); const scope = owner ? 'owner' : this.deps.scope()
    if (!owner && scope !== 'project' && !owns) throw new Error('target was not created by this caller during this host run')
    // Other backends need their own measured empty-composer reader before they can accept this verb.
    if (target.node.kind !== 'terminal' || target.node.agentId !== 'claude' || runtime.agentId !== 'claude' || !runtime.verified || !runtime.sessionId)
      throw new Error('target must be a verified local Claude terminal')
    if (target.node.pendingLaunch) throw new Error('target still has a held launch')
    if (requireIdle && runtime.state !== 'done') throw new Error('target is working, awaiting input or has unknown state')
    if (requireIdle && this.deps.handedOver(targetId)) throw new Error('previous handed-over input has not completed; inspect the terminal')
    const settings = this.deps.settings()
    const account = target.node.accountId ? settings.claudeAccounts.find((entry) => entry.id === target.node.accountId) : undefined
    if (target.node.accountId && (!account || account.pending || account.host)) throw new Error('target account is unavailable on this host')
    const execution = (node: CanvasNodeState, current: Runtime) => {
      const changing = node.id === transition?.nodeId ? transition : undefined
      if (changing && node.agentSessionId !== changing.savedSessionId && node.agentSessionId !== current.sessionId)
        throw new Error('saved session changed outside the expected transition')
      return { id: node.id, kind: node.kind, agentId: node.agentId,
      runtimeAgent: current.agentId, sessionId: changing ? changing.runtimeSessionId : current.sessionId, verified: current.verified, accountId: node.accountId,
      cwd: node.cwd, ssh: node.ssh, sshRemoteTmux: node.sshRemoteTmux, worktree: node.worktree,
      agentSessionId: changing ? changing.savedSessionId : node.agentSessionId, pendingLaunch: node.pendingLaunch, shell: node.shell, clearEnv: node.clearEnv }
    }
    return { projectId: source.project.id, projectCwd: source.project.cwd, source: source.node, target: target.node,
      binding: stableStringify({ projectId: source.project.id, cwd: source.project.cwd, scope, owns,
        source: execution(source.node, caller), target: execution(target.node, runtime),
        account: account ? { id: account.id, pending: account.pending, host: account.host, configDir: account.configDir } : null }) }
  }

}
