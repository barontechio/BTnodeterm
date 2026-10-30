import type http from 'node:http'
import type { MediaReferences } from '../core/media-references'
import { mediaRange } from '../core/media-range'

/** Called only after HTTP session authentication. URLs never accept filesystem paths. */
export async function handleMedia(req: http.IncomingMessage, res: http.ServerResponse, url: URL, refs: MediaReferences): Promise<boolean> {
  if (url.pathname !== '/media') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true
  }
  const token = url.searchParams.get('ref') ?? ''
  const opened = await refs.open(token)
  if (!opened) { res.writeHead(404); res.end(); return true }
  const headers: Record<string, string> = {
    'Content-Type': opened.mime, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox"
  }
  const range = mediaRange(req.headers.range ?? null, opened.size)
  if (range.kind === 'unsatisfiable') {
    await opened.handle.close()
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${opened.size}` }); res.end(); return true
  }
  const status = range.kind === 'partial' ? 206 : 200
  if (range.kind === 'partial') headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.size}`
  headers['Content-Length'] = String(range.kind === 'partial' ? range.end - range.start + 1 : opened.size)
  if (req.method === 'HEAD') { await opened.handle.close(); res.writeHead(status, headers); res.end(); return true }
  if (res.destroyed) { await opened.handle.close(); return true }
  const stream = opened.handle.createReadStream(range.kind === 'partial' ? { start: range.start, end: range.end } : {})
  const release = opened.attach(() => { stream.destroy(); res.destroy() })
  if (!release) { stream.destroy(); res.writeHead(503); res.end(); return true }
  stream.on('error', () => res.destroy())
  stream.on('close', release)
  res.on('close', () => stream.destroy())
  res.writeHead(status, headers)
  stream.pipe(res)
  return true
}
