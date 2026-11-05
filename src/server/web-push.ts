import type http from 'node:http'
import path from 'node:path'
import type { Auth } from './auth'
import type { WorkspaceStore } from '../core/workspace-store'
import { WebPushService, webPushId, type WebPushTarget } from '../core/web-push'
import { providerOrigin, sendWebPush } from '../core/web-push-transport'
import { mirrorEntry, onInboxActionable, isInboxEventCurrent } from '../core/agent-status-mirror'

export interface ServerWebPush {
  handle(req: http.IncomingMessage, res: http.ServerResponse, ownerToken: string | undefined, origin: string | undefined): Promise<void>
  close(): Promise<void>
}
export async function createServerWebPush(opts: { auth: Auth; workspace: WorkspaceStore; dataDir: string; publicOrigin?: string; headless?: boolean; env?: NodeJS.ProcessEnv }): Promise<ServerWebPush> {
  const env = opts.env ?? process.env
  let service: WebPushService | undefined
  let reason = 'The operator must configure HTTPS, a VAPID contact and approved push providers.'
  let unsubscribe = (): void => {}
  let revoke = (): void => {}
  const target = (nodeId: string): WebPushTarget | null => {
    const ids = opts.workspace.projectIdsForNode(nodeId)
    const node = ids.length === 1 ? opts.workspace.getNodeForHostAction(nodeId) : undefined
    const sessionId = mirrorEntry(nodeId)?.sessionId
    if (!node || node.kind !== 'terminal' || node.ssh || !webPushId(sessionId)) return null
    return { projectId: ids[0], nodeId, sessionId }
  }
  if (!opts.headless && opts.publicOrigin && env.NODETERM_WEB_PUSH_SUBJECT && env.NODETERM_WEB_PUSH_PROVIDERS) {
    try {
      const providers = env.NODETERM_WEB_PUSH_PROVIDERS.split(',').map(s => providerOrigin(s.trim()))
      const subject = env.NODETERM_WEB_PUSH_SUBJECT
      const contact = new URL(subject)
      if (providers.length > 8 || !['mailto:', 'https:'].includes(contact.protocol) || subject.length > 256 || /[\r\n]/.test(subject)) throw new Error('Invalid contact')
      const candidate = new WebPushService({ file: path.join(opts.dataDir, 'web-push.json'), providers,
        ownerCurrent: id => opts.auth.validateSessionId(id), target,
        projectCurrent: id => opts.workspace.persistedCanvases().some(c => c.id === id && c.nodes.some(n => n.kind === 'terminal' && !n.ssh)),
        eventCurrent: isInboxEventCurrent,
        send: (subscription, payload, vapid, current, signal) => sendWebPush({ subscription, payload, vapid, subject, providers, current, signal })
      })
      await candidate.init()
      service = candidate
      unsubscribe = onInboxActionable(e => candidate.accept(e))
      revoke = opts.auth.onSessionsRevoked(() => { void candidate.sweep().catch(() => {}) })
      reason = ''
    } catch { reason = 'Web Push configuration or private storage is unavailable. Ask the operator to check docs/web-push.md.' }
  }
  return {
    async handle(req, res, token, origin) {
      res.setHeader('Cache-Control', 'no-store')
      const json = (status: number, value: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      const owner = opts.auth.sessionId(token)
      if (!owner) { json(403, { error: 'A password-authenticated owner session is required.' }); return }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === '/auth/web-push/capability' && req.method === 'GET') {
        json(200, service?.available ? { available: true, publicKey: service.publicKey } : { available: false, reason: reason || 'Web Push storage is unavailable. Restart after checking private storage.' }); return
      }
      // Explicit configured-origin comparison is stricter than Host matching. JSON plus this
      // header gate blocks form, opaque-origin and sibling-origin CSRF before reading any body.
      if (req.method !== 'POST' || !origin || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
        json(403, { error: 'Same-origin JSON POST required.' }); return
      }
      if (!service) { json(503, { error: reason }); return }
      let live = true
      const departure = (): void => { live = false }
      res.once('close', departure)
      const current = (): boolean => live && !res.destroyed && opts.auth.validateSessionId(owner)
      try {
        const body = await readBody(req)
        if (!current()) { json(401, { error: 'Session expired.' }); return }
        if (pathname === '/auth/web-push/subscribe') {
          if (!webPushId(body.projectId)) throw new Error('Invalid project')
          await service.subscribe(owner, body.projectId, body.subscription, current)
          if (current()) json(200, { enabled: true })
        } else if (pathname === '/auth/web-push/unsubscribe') {
          if (typeof body.endpoint !== 'string' || body.endpoint.length > 2048) throw new Error('Invalid endpoint')
          await service.unsubscribe(owner, body.endpoint)
          if (current()) json(200, { enabled: false })
        } else if (pathname === '/auth/web-push/status') {
          json(200, service.status(owner, body.endpoint))
        } else if (pathname === '/auth/web-push/resolve' && webPushId(body.noticeId)) {
          const result = service.resolve(owner, body.noticeId)
          json(result ? 200 : 404, result ?? { error: 'Notification target is no longer available.' })
        } else json(404, { error: 'Unknown Web Push operation.' })
      } catch { if (!res.destroyed) json(400, { error: 'Web Push request refused. Check the session, project, provider and device limits.' }) }
      finally { res.removeListener('close', departure) }
    },
    async close() { unsubscribe(); revoke(); await service?.close() }
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const finish = (err?: Error): void => {
      clearTimeout(timer)
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', abort); req.removeListener('error', abort)
      if (err) { req.resume(); reject(err) }
      else { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value) } catch { reject(new Error('Invalid JSON')) } }
    }
    const data = (chunk: Buffer): void => { size += chunk.length; if (size > 4096) finish(new Error('Body too large')); else chunks.push(chunk) }
    const end = (): void => finish()
    const abort = (): void => finish(new Error('Body interrupted'))
    const timer = setTimeout(() => finish(new Error('Body timeout')), 5000)
    req.on('data', data); req.once('end', end); req.once('aborted', abort); req.once('error', abort)
  })
}
