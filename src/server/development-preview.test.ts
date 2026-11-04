import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { DevelopmentPreviews, type DevelopmentTarget } from '../core/development-previews'
import { DevelopmentPreviewTransport } from './development-preview'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as AddressInfo).port
}
async function fixture() {
  const seen: http.IncomingHttpHeaders[] = []
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers)
    if (req.url === '/redirect') res.setHeader('Location', '/next')
    if (req.url === '/escape') res.setHeader('Location', 'http://127.0.0.1:1/admin')
    res.setHeader('Set-Cookie', 'secret=bad; Domain=preview.example')
    res.writeHead(req.url === '/redirect' || req.url === '/escape' ? 302 : 200)
    res.end('development app')
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (ws, req) => { seen.push(req.headers); ws.on('message', data => ws.send(data)) })
  const port = await listen(upstream)
  let target: DevelopmentTarget | null = { projectId: 'project', nodeId: 'node', generation: 'g1', processIdentity: 'pid:birth:socket', hostIdentity: 'local', address: '127.0.0.1', port }
  const previews = new DevelopmentPreviews('https://preview.example', 'https://app.example', { resolve: async (owner, record) => owner === 'owner' && record === 'record' ? target : null })
  const transport = new DevelopmentPreviewTransport(previews)
  const gateway = http.createServer((req, res) => { void transport.handle(req, res) })
  gateway.on('upgrade', (req, socket, head) => { void transport.upgrade(req, socket, head) })
  const gatewayPort = await listen(gateway)
  cleanup.push(() => { transport.stop(); for (const c of wss.clients) c.terminate(); wss.close() })
  const origin = await previews.issue('owner', 'record')
  const host = new URL(origin).host
  const request = (path = '/', headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: gatewayPort, path, headers: { host, ...headers } }, res => {
      let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    }).on('error', reject)
  })
  return { seen, previews, origin, host, gatewayPort, request, replace: () => { target = { ...target!, processIdentity: 'replacement' } } }
}
describe('development preview transport with real HTTP/WS listeners', () => {
  it('serves only approved records, strips credentials and isolates service storage', async () => {
    const f = await fixture()
    const response = await f.request('/', { cookie: 'nodeterm=secret', authorization: 'Bearer secret', 'x-debug-token': 'secret', 'x-forwarded-host': 'app.example' })
    expect(response.status).toBe(200)
    expect(response.body).toBe('development app')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(f.seen[0].cookie).toBeUndefined(); expect(f.seen[0].authorization).toBeUndefined()
    expect(f.seen[0]['x-debug-token']).toBeUndefined(); expect(f.seen[0]['x-forwarded-host']).toBeUndefined()
    expect(f.seen[0].host).not.toBe(f.host)
    expect(await f.previews.issue('owner', 'record')).not.toBe(f.origin)
    await expect(f.previews.issue('peer', 'record')).rejects.toThrow()
    expect((await f.request('/', { host: 'app.example' })).status).toBe(403)
    expect((await f.request('/', { origin: 'https://evil.example' })).status).toBe(400)
  })
  it('rewrites same-target redirects and refuses other targets and changed processes', async () => {
    const f = await fixture()
    expect((await f.request('/redirect')).headers.location).toBe(`${f.origin}/next`)
    expect((await f.request('/escape')).status).toBe(502)
    f.replace()
    expect((await f.request()).status).toBe(403)
  })
  it('relays HMR messages and revocation closes existing WebSockets', async () => {
    const f = await fixture()
    const client = new WebSocket(`ws://127.0.0.1:${f.gatewayPort}/hmr`, 'vite-hmr', { headers: { host: f.host, origin: f.origin, cookie: 'app=secret', authorization: 'Bearer secret' } })
    cleanup.push(() => client.terminate())
    await once(client, 'open')
    const message = once(client, 'message'); client.send('reload')
    expect((await message)[0].toString()).toBe('reload')
    expect(client.protocol).toBe('vite-hmr')
    expect(f.seen[0].cookie).toBeUndefined(); expect(f.seen[0].authorization).toBeUndefined()
    const closed = once(client, 'close')
    f.previews.revoke('owner', f.origin)
    await closed
    expect((await f.request()).status).toBe(403)
  })
  it('bounds grants and refuses stale acquisition after revocation during a proof', async () => {
    const target: DevelopmentTarget = { projectId: 'p', nodeId: 'n', generation: 'g', processIdentity: 'birth', hostIdentity: 'local', address: '127.0.0.1', port: 3000 }
    let resume: ((value: DevelopmentTarget) => void) | undefined
    let delay = false
    const previews = new DevelopmentPreviews('https://preview.example', 'https://app.example', {
      resolve: async () => delay ? new Promise(resolve => { resume = resolve }) : target
    })
    cleanup.push(() => previews.stop())
    const origins = await Promise.all(Array.from({ length: 8 }, () => previews.issue('owner', 'record')))
    for (let i = 8; i < 32; i++) origins.push(await previews.issue('owner', 'record'))
    await expect(previews.issue('owner', 'record')).rejects.toThrow('busy')
    delay = true
    const pending = previews.acquire(new URL(origins[0]).host, () => {})
    previews.revoke('owner', origins[0]); resume!(target)
    expect(await pending).toBeNull()
    expect(previews.ownsHost(new URL(origins[0]).host)).toBe(true)
    expect(previews.ownsHost('preview.example.attacker.example')).toBe(false)
    expect(previews.ownsHost('evil@x.preview.example')).toBe(false)
  })
  it('rejects WebSocket requests from a foreign origin before contacting upstream', async () => {
    const f = await fixture()
    const client = new WebSocket(`ws://127.0.0.1:${f.gatewayPort}/hmr`, { headers: { host: f.host, origin: 'https://evil.example' } })
    cleanup.push(() => client.terminate())
    await once(client, 'error')
    expect(f.seen).toHaveLength(0)
  })
  it('does not issue a grant after owner departure during proof and expires held connections', async () => {
    let release!: (target: DevelopmentTarget) => void
    let now = 0
    const target: DevelopmentTarget = { projectId: 'p', nodeId: 'n', generation: 'g', processIdentity: 'birth', hostIdentity: 'local', address: '127.0.0.1', port: 3000 }
    const previews = new DevelopmentPreviews('https://preview.example', 'https://app.example', { resolve: () => new Promise(resolve => { release = resolve }) }, () => now)
    cleanup.push(() => previews.stop())
    const pending = previews.issue('owner', 'record')
    previews.forgetOwner('owner'); release(target)
    await expect(pending).rejects.toThrow()
    const issue = previews.issue('owner', 'record'); release(target)
    const origin = await issue
    let closed = false
    const acquire = previews.acquire(new URL(origin).host, () => { closed = true }); release(target); await acquire
    now = 300_001
    expect(await previews.acquire(new URL(origin).host, () => {})).toBeNull()
    expect(closed).toBe(true)
  })
})
