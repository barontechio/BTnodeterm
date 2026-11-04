import path from 'node:path'
import type { CorePlatform } from '../core/platform'
import type { WorkspaceStore } from '../core/workspace-store'
import type { PtyManager } from '../core/pty-manager'
import { OwnerLifetimes } from '../core/owner-lifetimes'
import { RemoteTransfers, type RemoteTransferSource } from '../core/remote-transfers'
import { childArgs } from '../core/remote-ssh/control-master'
import { stableStringify } from '../shared/canvas-mutations'
import { sshEndpointKey, sshHostKey } from '../shared/ssh'
import { capabilityAgentId } from '../shared/agents/config'
import type { Settings } from '../shared/types'
import type { RemoteTransferRequest } from '../shared/remote-transfers'
import { IPC } from '../shared/ipc'
import type { ServerSshProjects } from './ssh-projects'
import { TransferPrincipals } from './transfer-principals'

interface Dependencies {
  platform: CorePlatform
  enabled: boolean
  principals: TransferPrincipals
  workspace: Pick<WorkspaceStore, 'projectTargetInfo' | 'projectIdsForNode' | 'getNodeForHostAction'>
  pty: Pick<PtyManager, 'sshRemoteForNode'>
  settings(): Settings
  sessionOf(nodeId: string): string | undefined
  runtimeIdentity(nodeId: string): unknown
  ssh: ServerSshProjects
}

export function createServerRemoteTransfers(deps: Dependencies) {
  const owners = new OwnerLifetimes()
  const snapshot = (request: RemoteTransferRequest) => {
    if (!deps.enabled || !deps.ssh.manager.connectionReadyForWork(request.projectId)) return null
    const project = deps.workspace.projectTargetInfo(request.projectId)
    const ref = deps.ssh.refForProject(request.projectId)
    const generation = deps.ssh.manager.connectionKeyFor(request.projectId)
    if (!project?.ssh || !ref || !generation) return null
    const home = deps.ssh.manager.remoteHomeForControlPath(ref.controlPath)
    const configured = project.ssh.remoteCwd
    const root = configured === '~' ? home : configured.startsWith('~/') && home ? home + configured.slice(1) : configured
    if (!root?.startsWith('/') || root.includes('\0') || root.split('/').some(part => part === '..' || part === '.')) return null
    if (!request.relativePath || request.relativePath.startsWith('/') || request.relativePath.includes('\0') ||
      request.relativePath.split('/').some(part => !part || part === '.' || part === '..')) return null
    const file = path.posix.join(root, request.relativePath)
    const node = request.nodeId ? deps.workspace.getNodeForHostAction(request.nodeId) : undefined
    let account: unknown, live: unknown, session: string | undefined
    if (request.kind === 'media' && !request.nodeId) return null
    if (request.nodeId) {
      const ids = deps.workspace.projectIdsForNode(request.nodeId)
      if (!node || node.pendingLaunch || ids.length !== 1 || ids[0] !== request.projectId) return null
      if (request.kind === 'media' && (!['video', 'editor', 'image'].includes(node.kind) || node.filePath !== file)) return null
      const actual = deps.pty.sshRemoteForNode(request.nodeId)
      if (actual && (actual.controlPath !== ref.controlPath || sshEndpointKey(actual.conn) !== sshEndpointKey(ref.conn))) return null
      live = actual
      session = deps.sessionOf(request.nodeId) || node.agentSessionId
      if (node.accountId) {
        const harness = node.agentId && capabilityAgentId(node.agentId)
        const accounts = harness === 'codex' ? deps.settings().codexAccounts : harness === 'claude' ? deps.settings().claudeAccounts : []
        const found = accounts.find(candidate => candidate.id === node.accountId)
        if (!found || found.pending || found.host !== sshHostKey(ref.conn) || ('configDir' in found && found.configDir)) return null
        account = found
      }
    }
    const nodeProof = node ? {kind: node.kind, filePath: node.filePath, cwd: node.cwd, agentId: node.agentId,
      accountId: node.accountId, agentSessionId: node.agentSessionId, pendingLaunch: node.pendingLaunch,
      runtime: request.nodeId ? deps.runtimeIdentity(request.nodeId) : undefined} : undefined
    return {project, ref, generation, root, file, node: nodeProof, account, live, session}
  }
  const capture = (request: RemoteTransferRequest): RemoteTransferSource | null => {
    const initial = snapshot(request)
    if (!initial) return null
    const identity = stableStringify(initial)
    const runtime = request.nodeId ? deps.runtimeIdentity(request.nodeId) : undefined
    const current = () => { try { return (!request.nodeId || deps.runtimeIdentity(request.nodeId) === runtime) && stableStringify(snapshot(request)) === identity } catch { return false } }
    return {root: initial.root, relativePath: request.relativePath, path: initial.file, current,
      stream: (command, options) => deps.ssh.stream(childArgs(initial.ref.conn, initial.ref.controlPath, command),
        {...options, current: () => current() && options.current()})}
  }
  const transfers = new RemoteTransfers(capture)
  const caller = (id: number) => {
    const eligible = () => deps.platform.clientIds().includes(id) && deps.platform.isOwnerClient?.(id) === true
    const principal = deps.principals.forClient(id)
    if (!principal || !eligible()) return null
    return {owner: owners.get(id, eligible), principal}
  }
  deps.platform.handleWithSender(IPC.sshTransferPrepare, (id, request: RemoteTransferRequest) => {
    const owner = caller(id)
    return owner ? transfers.prepare(owner, request) : {status: 'unavailable'}
  })
  deps.platform.handleWithSender(IPC.sshTransferStatus, (id, reference: unknown) => {
    const owner = caller(id)
    return owner && typeof reference === 'string' && /^[a-f0-9]{32}$/.test(reference)
      ? transfers.status(owner, reference) : {outcome: 'unknown'}
  })
  deps.platform.handleWithSender(IPC.sshTransferRelease, (id, reference: unknown) => {
    const owner = caller(id)
    if (owner && typeof reference === 'string' && /^[a-f0-9]{32}$/.test(reference)) transfers.release(owner, reference)
  })
  deps.platform.handleWithSender(IPC.sshTransferRenew, (id, reference: unknown) => {
    const owner = caller(id)
    return !!owner && typeof reference === 'string' && /^[a-f0-9]{32}$/.test(reference) && transfers.renew(owner, reference)
  })
  return {transfers, forgetClient: (id: number) => { owners.forget(id); deps.principals.forget(id) },
    dispose: () => { transfers.dispose(); owners.dispose(); deps.principals.dispose() }}
}
