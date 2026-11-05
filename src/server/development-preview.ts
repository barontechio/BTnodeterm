import http from 'node:http'
import net from 'node:net'
import { Transform, type Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { DevelopmentPreviews, type DevelopmentTarget } from '../core/development-previews'

// Allowlist rather than a credential-name denylist: no Cookie, Authorization, Forwarded,
// management/debug headers, proxy credentials, Referer or caller-supplied Host reaches the app.
const requestHeaders = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-range', 'if-none-match', 'if-modified-since']
const responseHeaders = ['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges', 'etag', 'last-modified']
function filtered(headers: http.IncomingHttpHeaders, allowed: string[]): http.OutgoingHttpHeaders {
  return Object.fromEntries(allowed.filter(k => headers[k] !== undefined).map(k => [k, headers[k]]))
}
function targetOrigin(target: Readonly<DevelopmentTarget>): string {
  return `http://${target.address === '::1' ? '[::1]' : target.address}:${target.port}`
}
function pathOf(req: http.IncomingMessage): string | null {
  const path = req.url ?? '/'
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n]/.test(path) && path.length <= 8192 ? path : null
}
function responsePolicy(res: http.ServerResponse, origin: string): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Scripts intentionally work here. This is not a claim to contain their navigation.
  // No service workers may outlive the grant, and framing belongs to the owning app only.
  res.setHeader('Access-Control-Allow-Origin', 'null')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  res.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-forms; worker-src 'none'; frame-ancestors ${origin}`)
}

/** Dedicated isolated virtual host transport. The authority must revalidate an approved record;
 * this module never accepts an upstream address from a request. Not mounted on baseline Server. */
export class DevelopmentPreviewTransport {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  constructor(private previews: DevelopmentPreviews) {}
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    const path = pathOf(req)
    responsePolicy(res, this.previews.appOrigin)
    if ((req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== `https://${host}`) || !path || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) {
      res.writeHead(400); res.end(); return
    }
    let upstream: http.ClientRequest | undefined
    let connection: net.Socket | undefined
    const close = () => { connection?.destroy(); upstream?.destroy(); res.destroy() }
    const target = await this.previews.acquire(host, close)
    if (!target) { res.writeHead(403); res.end(); return }
    const release = () => { connection?.destroy(); upstream?.destroy(); this.previews.release(host, close) }
    res.once('close', release)
    if (res.destroyed) { release(); return }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try { connection = await this.connect(host, target, socket => { connection = socket }) }
    catch { release(); if (!res.destroyed) { res.writeHead(403); res.end() }; return }
    if (res.destroyed) { release(); return }
    if (!this.previews.current(host)) { close(); return }
    const origin = targetOrigin(target)
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => connection!
    res.once('close', () => agent.destroy())
    upstream = http.request(origin + path, {
      method: req.method, headers: { ...filtered(req.headers, requestHeaders), ...(req.headers.origin ? { origin } : {}) }, agent,
      timeout: 30_000, maxHeaderSize: 16 * 1024
    }, reply => {
      if (!this.previews.current(host)) { reply.destroy(); close(); return }
      const headers = filtered(reply.headers, responseHeaders)
      if (reply.headers.location) {
        try {
          const redirect = new URL(reply.headers.location, origin + path)
          if (redirect.origin !== origin || redirect.username || redirect.password) throw new Error('redirect refused')
          headers.location = `https://${host}${redirect.pathname}${redirect.search}${redirect.hash}`
        } catch { reply.destroy(); res.writeHead(502); res.end(); return }
      }
      res.writeHead(reply.statusCode ?? 502, headers)
      reply.on('error', () => res.destroy())
      reply.pipe(this.guarded(host, close)).pipe(res)
    })
    upstream.on('timeout', () => upstream?.destroy(new Error('preview timeout')))
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end() } else res.destroy() })
    req.on('aborted', release)
    req.pipe(this.guarded(host, close)).pipe(upstream)
  }
  async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const host = req.headers.host ?? ''
    const path = pathOf(req)
    if (!path || req.headers.origin !== 'null' && req.headers.origin !== `https://${host}`) { socket.destroy(); return }
    let connection: net.Socket | undefined
    let remote: WebSocket | undefined
    let viewer: WebSocket | undefined
    const close = () => { connection?.destroy(); remote?.terminate(); viewer?.terminate(); socket.destroy() }
    const target = await this.previews.acquire(host, close)
    if (!target || socket.destroyed) { this.previews.release(host, close); socket.destroy(); return }
    socket.once('close', () => { close(); this.previews.release(host, close) })
    // Protocol names carry HMR negotiation but are never arbitrary HTTP headers.
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    try {
      connection = await this.connect(host, target, s => { connection = s })
      if (socket.destroyed || !this.previews.current(host)) { close(); return }
      remote = new WebSocket(targetOrigin(target).replace('http:', 'ws:') + path, protocols, {
        createConnection: () => connection!,
        origin: targetOrigin(target), followRedirects: false, handshakeTimeout: 5000,
        maxPayload: 1024 * 1024, perMessageDeflate: false
      })
      remote.once('error', close)
      remote.once('close', close)
      remote.once('open', () => {
        if (socket.destroyed || !this.previews.current(host)) { close(); return }
        if (remote!.protocol) req.headers['sec-websocket-protocol'] = remote!.protocol
        else delete req.headers['sec-websocket-protocol']
        this.wss.handleUpgrade(req, socket, head, ws => {
          viewer = ws
          const pipe = (from: WebSocket, to: WebSocket) => {
            from.on('message', (data, binary) => {
              if (!this.previews.current(host) || to.readyState !== WebSocket.OPEN || to.bufferedAmount > 1024 * 1024) { close(); return }
              from.pause()
              to.send(data, { binary }, error => { if (error) close(); else from.resume() })
            })
          }
          pipe(ws, remote!); pipe(remote!, ws)
          ws.once('error', close); ws.once('close', close)
        })
      })
    } catch { close() }
  }
  private guarded(host: string, close: () => void): Transform {
    const check = () => this.previews.current(host)
    const guard = new Transform({
      transform(chunk, _encoding, done) { if (check()) done(null, chunk); else done(new Error('preview authorization changed')) },
      flush(done) { done(check() ? undefined : new Error('preview authorization changed')) }
    })
    guard.once('error', close)
    return guard
  }
  ownsHost(host: string): boolean { return this.previews.ownsHost(host) }
  private async connect(host: string, target: Readonly<DevelopmentTarget>, publish: (socket: net.Socket) => void): Promise<net.Socket> {
    const socket = net.createConnection({ host: target.address, port: target.port })
    publish(socket)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
        socket.once('close', () => reject(new Error('preview connection closed')))
        socket.setTimeout(5000, () => socket.destroy(new Error('preview connection timeout')))
      })
      if (!await this.previews.connected(host, socket)) throw new Error('preview connected identity refused')
      socket.setTimeout(0)
      return socket
    } catch (error) { socket.destroy(); throw error }
  }
  stop(): void { this.previews.stop(); this.wss.close() }
}
