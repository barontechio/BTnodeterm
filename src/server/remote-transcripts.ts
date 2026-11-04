import { stableStringify } from '../shared/canvas-mutations'
import type { ContextLinkInfo } from '../shared/types'
import type { RemoteContextReadScope } from '../core/context-link'
import { capabilityAgentId } from '../shared/agents/config'
import { isRemoteWorkspaceNode } from '../core/remote-node-routing'
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
  /** Current directed edge in this host's saved canvases; absent means no agent permission. */
  contextPermission?(callerId: string, targetId: string): boolean
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
  const isRemoteNode = (id: string) => isRemoteWorkspaceNode(deps.workspace, deps.pty, id)
  const supported = (agentId: string | undefined, nodeId: string | undefined) => {
    if (!deps.enabled || !nodeId) return false
    const node = deps.workspace.getNodeForHostAction(nodeId)
    const ids = deps.workspace.projectIdsForNode(nodeId)
    if (ids.length !== 1 || !deps.workspace.projectTargetInfo(ids[0])?.ssh) return false
    const harness = node?.agentId ? capabilityAgentId(node.agentId) : undefined
    return (harness === 'claude' || harness === 'codex') &&
      (agentId === undefined || capabilityAgentId(agentId) === harness)
  }
  const targetFor = (nodeId: string, expected?: 'claude' | 'codex'): RemoteClaudeTranscriptTarget | null | undefined => {
    if (!isRemoteNode(nodeId)) return undefined
    if (!supported(expected, nodeId)) return null
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
    const agentId = capabilityAgentId(node.agentId!) as 'claude' | 'codex'
    if (node.accountId) {
      const account = (agentId === 'codex' ? deps.settings().codexAccounts : deps.settings().claudeAccounts).find((candidate) => candidate.id === node.accountId)
      if (!account || account.pending || ('configDir' in account && account.configDir) || account.host !== sshHostKey(ref.conn)) return null
    }
    return { nodeId, agentId, savedSessionId: node.agentSessionId, projectId: ids[0], accountId: node.accountId, sessionId: deps.sessionOf(nodeId) || node.agentSessionId,
      cwd: node.cwd ?? project.ssh.remoteCwd, home, conn: ref.conn, controlPath: ref.controlPath, connectionKey }
  }
  const makeReader = (expected: 'claude' | 'codex') => new RemoteClaudeTranscripts({ targetFor: (id) => targetFor(id, expected), allowed: () => {
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
  const reader = makeReader('claude'); const codexReader = makeReader('codex')
  const linkedRequests = new AsyncLocalStorage<{ current(): boolean; signal: AbortSignal }>()
  const linkedReader = new RemoteClaudeTranscripts({ targetFor: (id) => targetFor(id),
    allowed: () => linkedRequests.getStore()?.current() === true,
    run: (target, command) => deps.ssh.manager.sshRun(childArgs(target.conn, target.controlPath, command)),
    withQueuedExecutionCheck: (current, work, options) => deps.ssh.withQueuedExecutionCheck(current, work,
      { signal: AbortSignal.any([options.signal, linkedRequests.getStore()!.signal]) })
  })
  const callerIdentity = (id: string): string | null => {
    const ids = deps.workspace.projectIdsForNode(id)
    const node = deps.workspace.getNodeForHostAction(id)
    const project = ids.length === 1 ? deps.workspace.projectTargetInfo(ids[0]) : null
    if (!project || !node || node.kind !== 'terminal' || node.pendingLaunch) return null
    const sessionId = deps.sessionOf(id) || node.agentSessionId
    if (!sessionId || !node.agentId) return null
    const ref = isRemoteNode(id) ? deps.ssh.refForProject(ids[0]) : undefined
    const connectionKey = ref ? deps.ssh.manager.connectionKeyFor(ids[0]) : undefined
    if (isRemoteNode(id) && (!ref || !connectionKey)) return null
    const live = deps.pty.sshRemoteForNode(id)
    if (live && (!ref || live.controlPath !== ref.controlPath || sshEndpointKey(live.conn) !== sshEndpointKey(ref.conn))) return null
    const harness = capabilityAgentId(node.agentId)
    const account = !node.accountId ? undefined : (harness === 'codex' ? deps.settings().codexAccounts :
      harness === 'claude' ? deps.settings().claudeAccounts : []).find((entry) => entry.id === node.accountId)
    if (node.accountId && (!account || account.pending || account.host !== (ref ? sshHostKey(ref.conn) : undefined))) return null
    return stableStringify({ projectId: ids[0], project, agentId: node.agentId, sessionId,
      savedSessionId: node.agentSessionId, accountId: node.accountId, account, cwd: node.cwd, ref, connectionKey })
  }
  const readLinkedTranscript = async (node: ContextLinkInfo, scope: RemoteContextReadScope): Promise<string | null> => {
    node = { ...node }; scope = { ...scope }
    const abort = new AbortController()
    const signal = scope.signal ? AbortSignal.any([scope.signal, abort.signal]) : abort.signal
    let binding: string | null
    try { binding = callerIdentity(scope.callerId) } catch { return null }
    const current = () => {
      try {
        const target = targetFor(node.id)
        return !signal.aborted && !!binding && scope.verified?.() === true && scope.current() &&
          deps.contextPermission?.(scope.callerId, node.id) === true && callerIdentity(scope.callerId) === binding &&
          (node.agentId === 'claude' || node.agentId === 'codex') && supported(node.agentId, node.id) && !!target &&
          target.accountId === node.accountId && target.sessionId === node.sessionId
      }
      catch { return false }
    }
    try {
      if (!current() || !node.sessionId) return null
      return await linkedRequests.run({ current, signal }, async () => {
        const result = await linkedReader.readPage({ nodeId: node.id, sessionId: node.sessionId,
          accountId: node.accountId, cwd: node.cwd, remoteOnly: true }, { before: null, maxBytes: 2 * 1024 * 1024 })
        return current() && result?.ok ? result.data.toString('utf8') : null
      })
    } finally { abort.abort() }
  }
  return { reader, codexReader, readLinkedTranscript, isRemoteNode, supported, rpcScope, forgetClient: (id: number) => owners.forget(id),
    dispose: () => { reader.dispose(); codexReader.dispose(); linkedReader.dispose(); owners.dispose() } }
}
