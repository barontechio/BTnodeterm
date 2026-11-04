import type { RemoteTransfersApi, RemoteUploadOutcome } from '@shared/remote-transfers'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'

/** UI conversion only. The host independently chooses/verifies its saved root and identity. */
export function remoteTransferRelativePath(projectId: string, file: string): string | null {
  const project = useProjects.getState().projects.find(project => project.id === projectId)
  const configured = project?.ssh?.remoteCwd
  if (!configured) return null
  const home = useSshConn.getState().byProject[projectId]?.remoteHome
  const expand = (value: string) => value === '~' ? home : value.startsWith('~/') && home ? home + value.slice(1) : value
  const root = expand(configured)?.replace(/\/+$/, '') || (configured === '/' ? '' : undefined)
  const absolute = expand(file)
  if (root === undefined || !absolute || !absolute.startsWith(root + '/')) return null
  const relative = absolute.slice(root.length + 1)
  return relative && !relative.split('/').some(part => !part || part === '.' || part === '..') ? relative : null
}
export function remoteTransferReference(url: string): string | null {
  return /^\/ssh-transfer\?ref=([a-f0-9]{32})$/.exec(url)?.[1] ?? null
}
function checkedUrl(reference: string, url: string): string {
  if (remoteTransferReference(url) !== reference) throw new Error('Remote transfer unavailable.')
  return url
}
export async function browserRemoteDownload(api: RemoteTransfersApi, projectId: string, file: string) {
  const relativePath = remoteTransferRelativePath(projectId, file)
  if (!relativePath) return null
  const prepared = await api.prepare({kind: 'download', projectId, relativePath})
  if (prepared.status !== 'ready') return null
  return {url: checkedUrl(prepared.reference, prepared.url), name: file.split('/').pop() || 'download'}
}
export async function browserRemoteMedia(api: RemoteTransfersApi, projectId: string, nodeId: string, file: string): Promise<string> {
  const relativePath = remoteTransferRelativePath(projectId, file)
  if (!relativePath) throw new Error('This media file is outside the remote project.')
  const prepared = await api.prepare({kind: 'media', projectId, nodeId, relativePath})
  if (prepared.status !== 'ready') throw new Error('Remote media is unavailable.')
  return checkedUrl(prepared.reference, prepared.url)
}
export class RemoteUploadUncertainError extends Error {
  constructor() { super('Upload could not be confirmed. The file may exist in the original folder, even if that folder was moved. Inspect it before retrying.') }
}
export async function browserRemoteUpload(api: RemoteTransfersApi, projectId: string, nodeId: string, file: File): Promise<string | null> {
  // Unique create-only attachment in the saved project root; never a server-local staging file.
  const name = file.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 120) || 'attachment'
  const relativePath = `.nodeterm-attachment-${crypto.randomUUID()}-${name}`
  const prepared = await api.prepare({kind: 'upload', projectId, nodeId, relativePath, bytes: file.size})
  if (prepared.status !== 'ready') return null
  let outcome: RemoteUploadOutcome = {outcome: 'unknown'}
  try {
    const response = await fetch(checkedUrl(prepared.reference, prepared.url), {method: 'PUT', body: file,
      credentials: 'same-origin', headers: {'Content-Type': 'application/octet-stream'}, signal: AbortSignal.timeout(120_000)})
    const value = await response.json()
    if (value && ['committed', 'unknown', 'not-written', 'conflict', 'unavailable'].includes(value.outcome)) outcome = value
  } catch { /* Never replay the body when the acknowledgement may have been lost. */ }
  if (outcome.outcome === 'unknown') {
    try { outcome = await api.status(prepared.reference) } catch { /* remains unknown */ }
  }
  if (outcome.outcome === 'unknown') throw new RemoteUploadUncertainError()
  await api.release(prepared.reference).catch(() => {})
  return outcome.outcome === 'committed' && typeof outcome.path === 'string' && outcome.path.startsWith('/') ? outcome.path : null
}
