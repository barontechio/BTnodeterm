import { isRemoteSessionNode } from '../shared/worktree'
import type { WorkspaceStore } from './workspace-store'
import type { PtyManager } from './pty-manager'

/** Remoteness is independent of reader support, live connection and unique action placement. */
export function isRemoteWorkspaceNode(
  workspace: Pick<WorkspaceStore, 'sshProjectIdForNode' | 'relayNodePlacements'>,
  pty: Pick<PtyManager, 'sshRemoteForNode'>, nodeId: string
): boolean {
  return !!workspace.sshProjectIdForNode(nodeId) || !!pty.sshRemoteForNode(nodeId) ||
    workspace.relayNodePlacements(nodeId).some((entry) => !!entry.projectServer || isRemoteSessionNode(entry.node))
}
