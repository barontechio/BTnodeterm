import path from 'node:path'
import { stableStringify } from '../shared/canvas-mutations'
import { sshEndpointKey } from '../shared/ssh'
import { IPC } from '../shared/ipc'
import { withGitRemoteResolver } from '../core/remote-ssh/remote-git'
import type { GitRequestScope } from '../core/git-service'
import type { CorePlatform } from '../core/platform'
import type { WorkspaceStore } from '../core/workspace-store'
import type { SshProjectManager } from '../core/remote-ssh/ssh-project'

type Manager = Pick<SshProjectManager, 'refForProject' | 'connectionKeyFor'>
const localOnly = new Set<string>([IPC.gitClone, IPC.gitCloneAbort, IPC.gitCloneDefaultParent, IPC.gitPublish])
const under = (root: string, cwd: string) => {
  const from = path.posix.normalize(root); const relative = path.posix.relative(from, path.posix.normalize(cwd))
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
}

/** No destination is global across browser connections; each request captures a generation. */
export class ServerGitRequestScope {
  private active = new Map<number, string>()
  constructor(private readonly deps: {
    platform: Pick<CorePlatform, 'isOwnerClient'>
    workspace: Pick<WorkspaceStore, 'projectTargetInfo' | 'sshProjectIds'>
    manager(): Manager | undefined
  }) {}

  setActive(clientId: number, projectId: string | null): void {
    if (projectId === null) { this.active.delete(clientId); return }
    if (!this.deps.platform.isOwnerClient?.(clientId)) throw new Error('ssh-git-owner-required')
    if (typeof projectId !== 'string' || !this.deps.workspace.projectTargetInfo(projectId)) throw new Error('ssh-git-project-unavailable')
    this.active.set(clientId, projectId)
  }
  forgetClient(clientId: number): void { this.active.delete(clientId) }

  run: GitRequestScope = (clientId, channel, args, operation) => {
    const id = this.active.get(clientId)
    if (id) {
      const project = this.deps.workspace.projectTargetInfo(id)
      if (!project) throw new Error('ssh-git-project-unavailable')
      if (project.ssh) {
        if (!this.deps.platform.isOwnerClient?.(clientId)) throw new Error('ssh-git-owner-required')
        if (localOnly.has(channel)) throw new Error('ssh-git-local-operation-refused: choose a local project for this operation')
        return this.forProject(id, operation)
      }
    }
    // Without a project-bearing connection, equal local/remote path strings are ambiguous.
    // Refuse them instead of silently answering a remote project's query from host disk.
    const cwd = args[0]
    if (!id && typeof cwd === 'string' && !localOnly.has(channel) && this.deps.workspace.sshProjectIds().some((projectId) => {
      const root = this.deps.workspace.projectTargetInfo(projectId)?.ssh?.remoteCwd
      return root && under(root, cwd)
    })) throw new Error('ssh-git-project-required: select the SSH project on this connection')
    return withGitRemoteResolver(() => undefined, operation)
  }

  forProject<T>(projectId: string, operation: () => T): T {
    const project = this.deps.workspace.projectTargetInfo(projectId)
    if (!project) throw new Error('ssh-git-project-unavailable')
    if (!project.ssh) return withGitRemoteResolver(() => undefined, operation)
    const manager = this.deps.manager(); const reference = manager?.refForProject(projectId)
    const generation = manager?.connectionKeyFor(projectId)
    if (!manager || !reference || !generation) throw new Error('ssh-git-remote-unavailable: nothing was run locally')
    if (sshEndpointKey(reference.conn) !== sshEndpointKey(project.ssh.server) ||
      (reference.remoteCwd && reference.remoteCwd !== project.ssh.remoteCwd)) throw new Error('ssh-git-target-mismatch')
    const endpoint = stableStringify(project.ssh)
    const root = reference.remoteCwd || project.ssh.remoteCwd
    return withGitRemoteResolver((cwd) => {
      const current = this.deps.workspace.projectTargetInfo(projectId)
      if (this.deps.manager() !== manager || manager.connectionKeyFor(projectId) !== generation ||
        stableStringify(current?.ssh) !== endpoint) throw new Error('ssh-git-connection-changed: retry after checking the selected project')
      if (!root || !under(root, cwd)) throw new Error('ssh-git-path-refused: directory is outside the selected SSH project')
      return reference
    }, operation)
  }
}
