import path from 'node:path'
import { IPC } from '../shared/ipc'
import { MediaReferences } from '../core/media-references'
import type { CorePlatform } from '../core/platform'
import type { WorkspaceStore } from '../core/workspace-store'
import { isAudioFile } from '../shared/media'

/** Server owner API. Paths must match a local media node in this host's saved workspace. */
export function registerServerMedia(platform: CorePlatform, workspace: WorkspaceStore): MediaReferences {
  const refs = new MediaReferences({ authorize: async (scope, file) => {
    const current = await workspace.load({ sideline: false })
    const projects = current.projects.filter((p) => p.nodes.some((n) => n.id === scope.nodeId))
    if (projects.length !== 1) return false
    const project = projects[0]
    const node = project.nodes.find((n) => n.id === scope.nodeId)!
    return project.id === scope.projectId && !project.ssh && !project.unavailable &&
      !node.sshFs && !node.ssh && !node.sshRemoteTmux &&
      (node.kind === 'video' || (node.kind === 'editor' && isAudioFile(file))) && node.filePath === file && path.isAbsolute(file)
  } })
  platform.handleWithSender(IPC.mediaAllowScoped, async (clientId, file: unknown, scope: unknown) => {
    if (!platform.isOwnerClient?.(clientId)) throw new Error('media-owner-required')
    if (typeof file !== 'string' || file.length > 8192 || file.includes('\0') || !scope || typeof scope !== 'object') throw new Error('media-invalid-request')
    const { projectId, nodeId } = scope as Record<string, unknown>
    if (typeof projectId !== 'string' || !projectId || typeof nodeId !== 'string' || !nodeId) throw new Error('media-scope-required')
    const token = await refs.issue(clientId, { projectId, nodeId }, file)
    if (!platform.isOwnerClient?.(clientId)) { refs.release(clientId, token); throw new Error('media-owner-disconnected') }
    return `/media?ref=${token}`
  })
  platform.handleWithSender(IPC.mediaRenew, (clientId, token: unknown) =>
    platform.isOwnerClient?.(clientId) && typeof token === 'string' ? refs.renew(clientId, token) : false)
  platform.handleWithSender(IPC.mediaRelease, (clientId, token: unknown) => {
    if (platform.isOwnerClient?.(clientId) && typeof token === 'string') refs.release(clientId, token)
  })
  return refs
}
