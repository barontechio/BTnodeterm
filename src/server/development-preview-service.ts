import type { CorePlatform } from '../core/platform'
import type { WorkspaceStore } from '../core/workspace-store'
import type { PtyManager } from '../core/pty-manager'
import { LocalDevelopmentAuthority, type ApprovedDevelopmentService } from '../core/development-preview-authority'
import { DevelopmentPreviews } from '../core/development-previews'
import { DevelopmentPreviewTransport } from './development-preview'
import { IPC } from '../shared/ipc'

export interface DevelopmentPreviewConfig { origin: string; approved: ApprovedDevelopmentService[] }
export function registerDevelopmentPreviewService(options: {
  platform: CorePlatform; workspace: WorkspaceStore; pty: PtyManager
  config?: DevelopmentPreviewConfig; appOrigin?: string; managementPorts(): number[]
}): { transport?: DevelopmentPreviewTransport; forgetClient(id: number): void; stop(): void } {
  const { platform, workspace, pty, config, appOrigin } = options
  const enabled = !!config && !!appOrigin && process.platform === 'linux'
  const authority = enabled ? new LocalDevelopmentAuthority({
    approved: config.approved, tmuxBin: () => pty.getTmuxBin(), managementPorts: options.managementPorts,
    ownerCurrent: owner => /^\d+$/.test(owner) && !!platform.isOwnerClient?.(Number(owner)),
    current: (scope, execution) => {
      const ids = workspace.projectIdsForNode(scope.nodeId)
      const matches = workspace.getProjectNodesForHostAction(scope.projectId)?.filter(node => node.id === scope.nodeId)
      const node = matches?.length === 1 ? matches[0] : undefined
      return ids.length === 1 && ids[0] === scope.projectId && !!node && node.kind === 'terminal' &&
        !node.ssh && !node.sshFs && !node.sshRemoteTmux && pty.nodeExecutionIdentity(scope.nodeId) === execution
    },
    execution: async scope => {
      const saved = await workspace.load({ sideline: false })
      const matches = saved.projects.flatMap(project => project.nodes.filter(node => node.id === scope.nodeId).map(node => ({ project, node })))
      if (matches.length !== 1) return undefined
      const { project, node } = matches[0]
      if (project.id !== scope.projectId || project.ssh || project.unavailable || node.ssh || node.sshFs || node.sshRemoteTmux || node.kind !== 'terminal') return undefined
      return pty.nodeExecutionIdentity(scope.nodeId)
    }
  }) : undefined
  const previews = authority ? new DevelopmentPreviews(config!.origin, appOrigin!, authority) : undefined
  const transport = previews ? new DevelopmentPreviewTransport(previews) : undefined
  const requireOwner = (id: number) => {
    if (!platform.isOwnerClient?.(id)) throw new Error('development-preview-owner-required')
    return String(id)
  }
  platform.handleWithSender(IPC.developmentPreviewStatus, id => {
    requireOwner(id)
    const supported = !!authority && !!pty.getTmuxBin()
    return { supported, storage: 'disabled', ...(supported ? {} : { reason: 'Development previews require configured isolated DNS/TLS, approved targets and Linux tmux.' }) }
  })
  platform.handleWithSender(IPC.developmentPreviewList, (id, raw: unknown) => {
    const owner = requireOwner(id)
    if (!authority || !raw || typeof raw !== 'object') throw new Error('development-preview-unsupported')
    const { projectId, nodeId } = raw as Record<string, unknown>
    if (typeof projectId !== 'string' || !projectId || projectId.length > 256 || typeof nodeId !== 'string' || !nodeId || nodeId.length > 256) throw new Error('development-preview-invalid-scope')
    return authority.list(owner, { projectId, nodeId })
  })
  platform.handleWithSender(IPC.developmentPreviewOpen, (id, record: unknown) => {
    const owner = requireOwner(id)
    if (!previews || typeof record !== 'string' || !/^[a-f0-9]{48}$/.test(record)) throw new Error('development-preview-unsupported-or-invalid-record')
    return previews.issue(owner, record)
  })
  platform.handleWithSender(IPC.developmentPreviewStop, (id, origin: unknown) => {
    const owner = requireOwner(id)
    if (typeof origin === 'string' && origin.length < 1024) previews?.revoke(owner, origin)
  })
  return {
    transport,
    forgetClient(id) { previews?.forgetOwner(String(id)); authority?.forgetOwner(String(id)) },
    stop() { transport?.stop(); authority?.stop() }
  }
}
