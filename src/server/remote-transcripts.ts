import { capabilityAgentId } from '../shared/agents/config'
import { isRemoteSessionNode } from '../shared/worktree'
import { sshEndpointKey, sshHostKey, type SshConnection } from '../shared/ssh'
import type { Settings } from '../shared/types'
import type { WorkspaceStore } from '../core/workspace-store'
import type { PtyManager } from '../core/pty-manager'
import type { ScopedSshProjectRunners } from '../core/remote-ssh/ssh-process-runners'
import { childArgs } from '../core/remote-ssh/control-master'
import { RemoteClaudeTranscripts, type RemoteClaudeTranscriptTarget } from '../core/remote-claude-transcripts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { OwnerLifetimes, type AccountOwner } from '../core/owner-lifetimes'
import type { CorePlatform } from '../core/platform'

interface Dependencies {
  platform: Pick<CorePlatform, 'clientIds' | 'isOwnerClient'>
  enabled: boolean
  workspace: Pick<WorkspaceStore, 'projectIdsForNode' | 'getNodeForHostAction' | 'projectTargetInfo' | 'sshProjectIdForNode' | 'relayNodePlacements'>
  pty: Pick<PtyManager, 'sshRemoteForNode'>
  settings(): Settings
  sessionOf(nodeId: string): string | undefined
  ssh: {
    /** Must be the shell's verified reference, including the current saved endpoint/folder. */
    refForProject(projectId: string): { conn: SshConnection; controlPath: string; remoteCwd?: string } | undefined
    withQueuedExecutionCheck: ScopedSshProjectRunners['withQueuedExecutionCheck']
    manager: {
      connectionKeyFor(projectId: string): string | undefined
      remoteHomeForControlPath(controlPath: string): string | undefined
      sshRun(args: string[]): Promise<{ code: number; stdout: string }>
    }
  }
}

/** Machine-local routing/registry adapter. The core reader owns bounds, IO and stale-result rules. */
export function createServerRemoteTranscripts(deps: Dependencies) {
  const owners = new OwnerLifetimes()
  const requests = new AsyncLocalStorage<{ owner: AccountOwner; signal: AbortSignal } | null>()
  const rpcScope = async <T>(clientId: number, operation: () => Promise<T>): Promise<T> => {
    const eligible = () => deps.platform.clientIds().includes(clientId) && deps.platform.isOwnerClient?.(clientId) === true
    if (!eligible()) return requests.run(null, operation)
    const owner = owners.get(clientId, eligible); const abort = new AbortController()
    const unsubscribe = owner.onDeparture(() => abort.abort())
    try { return await requests.run({ owner, signal: abort.signal }, operation) }
    finally { abort.abort(); unsubscribe() }
  }
  const isRemoteNode = (id: string) => !!deps.workspace.sshProjectIdForNode(id) ||
    !!deps.pty.sshRemoteForNode(id) || deps.workspace.relayNodePlacements(id).some((p) =>
      !!p.projectServer || isRemoteSessionNode(p.node))
  const supported = (agentId: string | undefined, nodeId: string | undefined) => {
    if (!deps.enabled || !nodeId) return false
    const node = deps.workspace.getNodeForHostAction(nodeId)
    const ids = deps.workspace.projectIdsForNode(nodeId)
    if (ids.length !== 1 || !deps.workspace.projectTargetInfo(ids[0])?.ssh) return false
    return !!node?.agentId && capabilityAgentId(node.agentId) === 'claude' &&
      (agentId === undefined || capabilityAgentId(agentId) === 'claude')
  }
  const targetFor = (nodeId: string): RemoteClaudeTranscriptTarget | null | undefined => {
    if (!isRemoteNode(nodeId)) return undefined
    if (!supported(undefined, nodeId)) return null
    const ids = deps.workspace.projectIdsForNode(nodeId)
    const node = deps.workspace.getNodeForHostAction(nodeId)
    const project = ids.length === 1 ? deps.workspace.projectTargetInfo(ids[0]) : null
    if (!project?.ssh || !node || node.kind !== 'terminal' || node.pendingLaunch) return null
    const ref = deps.ssh.refForProject(ids[0])
    const connectionKey = deps.ssh.manager.connectionKeyFor(ids[0])
    const home = ref ? deps.ssh.manager.remoteHomeForControlPath(ref.controlPath) : undefined
    if (!ref || !connectionKey || !home) return null
    const live = deps.pty.sshRemoteForNode(nodeId)
    if (live && (live.controlPath !== ref.controlPath || sshEndpointKey(live.conn) !== sshEndpointKey(ref.conn))) return null
    if (node.accountId) {
      const account = deps.settings().claudeAccounts.find((candidate) => candidate.id === node.accountId)
      if (!account || account.pending || account.configDir || account.host !== sshHostKey(ref.conn)) return null
    }
    return { nodeId, projectId: ids[0], accountId: node.accountId, sessionId: deps.sessionOf(nodeId) || node.agentSessionId,
      cwd: node.cwd ?? project.ssh.remoteCwd, home, conn: ref.conn, controlPath: ref.controlPath, connectionKey }
  }
  const reader = new RemoteClaudeTranscripts({ targetFor, allowed: () => {
    const request = requests.getStore()
    return request?.owner.active() === true && !request.signal.aborted
  },
    run: (target, command) => deps.ssh.manager.sshRun(childArgs(target.conn, target.controlPath, command)),
    withQueuedExecutionCheck: (current, work, options) => {
      const request = requests.getStore()
      return deps.ssh.withQueuedExecutionCheck(current, work, { signal: request
        ? AbortSignal.any([options.signal, request.signal]) : options.signal })
    }
  })
  return { reader, isRemoteNode, supported, rpcScope, forgetClient: (id: number) => owners.forget(id),
    dispose: () => { reader.dispose(); owners.dispose() } }
}
