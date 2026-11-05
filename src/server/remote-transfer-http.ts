import type http from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RemoteTransfers } from '../core/remote-transfers'
import { mediaRange } from '../core/media-range'
import { contentDisposition } from './download'
import { sameOriginRequest } from './origin'
import type { TransferPrincipals } from './transfer-principals'

export interface RemoteTransferHttp {
  transfers: RemoteTransfers
  principals: TransferPrincipals
}
/** Authenticated bulk IO only. URLs contain an opaque reference, never a host/path/credential. */
export async function handleRemoteTransfer(req: http.IncomingMessage, res: http.ServerResponse, url: URL,
  service: RemoteTransferHttp, cookie: string | undefined, publicOrigin?: string): Promise<boolean> {
  if (url.pathname !== '/ssh-transfer') return false
  const principal = service.principals.forCookie(cookie)
  const reference = url.searchParams.get('ref') ?? ''
  const info = principal && /^[a-f0-9]{32}$/.test(reference) ? service.transfers.info(reference, principal) : null
  const end = (status: number) => { if (!res.headersSent) res.writeHead(status, {'Cache-Control': 'no-store'}); res.end() }
  if (!principal || !info) { end(404); return true }
  const method = req.method ?? 'GET'
  if (info.kind === 'upload' ? method !== 'PUT' : method !== 'GET' && !(info.kind === 'media' && method === 'HEAD')) { end(405); return true }
  if (info.kind === 'upload' && (!sameOriginRequest(req.headers, publicOrigin) ||
    req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) { end(403); return true }
  const abort = new AbortController()
  const aborted = () => abort.abort()
  const responseClosed = () => { if (!res.writableFinished) abort.abort() }
  req.once('aborted', aborted); res.once('close', responseClosed)
  try {
    if (info.kind === 'upload') {
      if (!/^\d+$/.test(req.headers['content-length'] ?? '') || Number(req.headers['content-length']) !== info.bytes) { end(411); return true }
      const outcome = await service.transfers.upload(reference, principal, req, abort.signal)
      if (res.destroyed || !service.transfers.info(reference, principal)) { if (!res.destroyed) end(404); return true }
      res.writeHead(outcome.outcome === 'committed' ? 201 : outcome.outcome === 'conflict' ? 409 : 503,
        {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
      res.end(JSON.stringify(outcome)); return true
    }
    const range = info.kind === 'media' ? mediaRange(req.headers.range ?? null, info.bytes) : {kind: 'full' as const}
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, {'Content-Range': `bytes */${info.bytes}`, 'Cache-Control': 'no-store'}); res.end(); return true
    }
    const offset = range.kind === 'partial' ? range.start : 0
    const length = range.kind === 'partial' ? range.end - range.start + 1 : info.bytes
    const headers: Record<string, string> = {
      'Content-Type': info.mime ?? 'application/octet-stream', 'Content-Length': String(length),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox"
    }
    if (info.kind === 'media') headers['Accept-Ranges'] = 'bytes'
    else headers['Content-Disposition'] = contentDisposition(info.name)
    if (range.kind === 'partial') headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.bytes}`
    const ok = await service.transfers.download(reference, principal, offset, method === 'HEAD' ? 0 : length, async (body, current) => {
      if (!current() || res.destroyed) { body.destroy(); throw new Error('remote-transfer-expired') }
      res.writeHead(range.kind === 'partial' ? 206 : 200, headers)
      if (method === 'HEAD') { for await (const _ of body) { /* protocol requires zero bytes */ } }
      else await pipeline(body, new Transform({transform(chunk, _encoding, done) {
        if (!current()) done(new Error('remote-transfer-expired'))
        else done(null, chunk)
      }}), res, {end: false})
    }, abort.signal)
    if (ok && !res.destroyed) res.end()
    else if (res.headersSent) res.destroy()
    else end(503)
    return true
  } catch {
    if (res.headersSent) res.destroy()
    else if (!res.destroyed) end(503)
    return true
  } finally {
    req.removeListener('aborted', aborted); res.removeListener('close', responseClosed)
  }
}
