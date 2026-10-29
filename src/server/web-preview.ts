import type http from 'node:http'
import type { WebPreviews } from '../core/web-previews'

export function previewHost(req: http.IncomingMessage, origin: string): boolean {
  try { return new URL(`https://${req.headers.host ?? ''}`).host === new URL(origin).host } catch { return false }
}

/** Isolated virtual host: serve only scoped snapshots; never application pages or auth routes. */
export async function handleWebPreview(req: http.IncomingMessage, res: http.ServerResponse, previews: WebPreviews): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Strict-Transport-Security', 'max-age=31536000')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  const url = new URL(req.url ?? '/', previews.origin)
  if (url.pathname !== '/web-preview') { res.writeHead(404); res.end(); return }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return }
  const snapshot = await previews.open(url.searchParams.get('ref') ?? '')
  if (!snapshot) { res.writeHead(404); res.end(); return }
  res.once('close', snapshot.release); res.once('finish', snapshot.release)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(snapshot.bytes.length),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors ${previews.appOrigin}; sandbox`
  })
  res.end(req.method === 'HEAD' ? undefined : snapshot.bytes)
}
