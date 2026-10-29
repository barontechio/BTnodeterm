import { IPC } from '../shared/ipc'
import type { CorePlatform } from '../core/platform'
import type { WebPreviews } from '../core/web-previews'

export function registerWebPreviewIpc(platform: CorePlatform, previews?: WebPreviews): void {
  const requireOwner = (id: number) => {
    if (!platform.isOwnerClient?.(id)) throw new Error('web-preview-owner-required')
    if (!previews) throw new Error('HTML previews require NODETERM_PREVIEW_ORIGIN on a distinct HTTPS hostname')
    return previews
  }
  platform.handleWithSender(IPC.webPreviewAllow, async (id, raw: unknown) => {
    const service = requireOwner(id)
    if (!raw || typeof raw !== 'object') throw new Error('web-preview-scope-required')
    const { projectId, nodeId } = raw as Record<string, unknown>
    if (typeof projectId !== 'string' || !projectId || typeof nodeId !== 'string' || !nodeId) throw new Error('web-preview-scope-required')
    const url = await service.issue(id, { projectId, nodeId })
    if (!platform.isOwnerClient?.(id)) { service.forgetClient(id); throw new Error('web-preview-owner-disconnected') }
    return url
  })
  platform.handleWithSender(IPC.webPreviewRenew, (id, token: unknown) =>
    typeof token === 'string' ? requireOwner(id).renew(id, token) : false)
  platform.handleWithSender(IPC.webPreviewRelease, (id, token: unknown) => {
    if (typeof token === 'string') requireOwner(id).release(id, token)
  })
  platform.handleWithSender(IPC.mediaWriteHtml, (id, html: unknown) => {
    const service = requireOwner(id)
    if (typeof html !== 'string') throw new Error('web-preview-invalid-html')
    return service.writeHtml(html)
  })
}
