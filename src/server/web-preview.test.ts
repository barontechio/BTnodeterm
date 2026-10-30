import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { WebPreviews } from '../core/web-previews'
import { registerWebPreviewIpc } from './web-preview-ipc'
import { createHttpHandler, SESSION_COOKIE } from './http'
import { Auth } from './auth'
import { IPC } from '../shared/ipc'
import { resolveConfig } from './config'
import { ServerPlatform } from './platform-server'
import { attachWsServer } from './ws'

describe('isolated, scoped HTML preview origin', () => {
  let platform: FakePlatform
  let workspace: WorkspaceStore
  let previews: WebPreviews
  let server: http.Server
  let base: string
  let cookie: string
  let file: string
  let auth: Auth
  const scope = { projectId: 'p', nodeId: 'web' }
  const allow = (): Promise<string> => platform.handlers[IPC.webPreviewAllow](1, scope) as Promise<string>
  const request = (url: string, host = 'preview.example.test', headers: Record<string, string> = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const parsed = new URL(url, base)
      const outgoing = http.get(base + parsed.pathname + parsed.search, { headers: { host, ...headers } }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('error', reject)
        incoming.on('end', () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), {
          status: incoming.statusCode, headers: incoming.headers as Record<string, string>
        })))
      })
      outgoing.on('error', reject)
    })
  beforeEach(async () => {
    const root = testTmpDir('web-preview-'); fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'renderer'))
    fs.writeFileSync(path.join(root, 'renderer', 'index.html'), 'APPLICATION')
    platform = fakePlatform({ userDataDir: path.join(root, 'data'), isOwnerClient: (id) => id === 1 })
    resetPlatformForTests(); initPlatform(platform)
    workspace = new WorkspaceStore()
    previews = new WebPreviews('https://preview.example.test', 'https://term.example.test', workspace, path.join(root, 'data'))
    file = await previews.writeHtml('<h1>Preview</h1><script>fetch("/api")</script>')
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Web', color: '#6ac4dc',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'web', kind: 'web', filePath: file, title: 'page', group: null,
        color: '#6ac4dc', size: { width: 720, height: 520 }, position: { x: 0, y: 0 } }] }] })
    registerWebPreviewIpc(platform, previews)
    auth = new Auth(root); cookie = `${SESSION_COOKIE}=${auth.createSession()}`
    server = http.createServer(createHttpHandler({ auth, rendererDir: path.join(root, 'renderer'),
      publicOrigin: 'https://term.example.test', webPreviews: previews }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => { previews.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); resetPlatformForTests() })

  it('serves an immutable snapshot only on the isolated host with an opaque sandbox and no network', async () => {
    const url = await allow()
    fs.writeFileSync(file, '<p>changed after grant</p>')
    const response = await request(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<h1>Preview</h1>')
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('; sandbox')
    expect(csp).toContain("script-src 'none'")
    expect(csp).not.toContain('allow-scripts')
    expect(csp).toContain('frame-ancestors https://term.example.test')
    expect(csp).not.toContain('allow-same-origin')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect((await request(url, 'term.example.test', { cookie })).status).toBe(404)
    const app = await fetch(base, { headers: { host: 'term.example.test', cookie } })
    expect(await app.text()).toBe('APPLICATION')
  })

  it('never exposes application, login or auth routes on the preview hostname', async () => {
    for (const route of ['/', '/login', '/auth/setup', '/ws', '/assets/app.js']) {
      const response = await request(route, 'preview.example.test', { cookie })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('APPLICATION')
    }
    expect((await request('https://preview.example.test/web-preview?path=/etc/passwd')).status).toBe(404)
  })

  it('requires an owner RPC and saved local node, and revokes on removal or disconnect', async () => {
    const issue = vi.spyOn(previews, 'issue')
    await expect(platform.handlers[IPC.webPreviewAllow](2, scope)).rejects.toThrow('owner')
    expect(issue).not.toHaveBeenCalled()
    await expect(platform.handlers[IPC.webPreviewAllow](1, { ...scope, projectId: 'foreign' })).rejects.toThrow('local web node')
    const url = await allow(); previews.forgetClient(1)
    expect((await request(url)).status).toBe(404)
    const next = await allow()
    await workspace.updateWorkspace((fresh) => { fresh.projects[0].nodes = []; return fresh })
    expect((await request(next)).status).toBe(404)
  })

  it('refuses an application WebSocket on the preview host even with a valid owner cookie', async () => {
    const transport = new ServerPlatform({ userDataDir: platform.userDataDir, appVersion: 'test' })
    const sockets = attachWsServer(server, { platform: transport, auth, publicOrigin: previews.appOrigin, previewOrigin: previews.origin })
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, {
      headers: { host: 'preview.example.test', origin: 'https://preview.example.test', cookie }
    })
    try {
      const outcome = await new Promise<string>((resolve) => { socket.on('open', () => resolve('opened')); socket.on('error', () => resolve('refused')) })
      expect(outcome).toBe('refused')
    } finally { socket.terminate(); for (const client of sockets.clients) client.terminate() }
  })

  it('enforces file limits and retains source files while an expired reference stops serving', async () => {
    const url = await allow()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    expect((await request(url)).status).toBe(404)
    expect(fs.existsSync(file)).toBe(true)
    await expect(previews.writeHtml('x'.repeat(1024 * 1024 + 1))).rejects.toThrow('1 MiB')
    fs.truncateSync(file, 1024 * 1024 + 1)
    await expect(allow()).rejects.toThrow('1 MiB')
  })

  it('keeps the capability unavailable without explicit origin configuration', async () => {
    registerWebPreviewIpc(platform)
    await expect(platform.handlers[IPC.webPreviewAllow](1, scope)).rejects.toThrow('NODETERM_PREVIEW_ORIGIN')
    expect(() => new WebPreviews('https://term.example.test:444', 'https://term.example.test', workspace, '/tmp/unused')).toThrow('distinct')
    expect(() => resolveConfig({ NODETERM_PREVIEW_ORIGIN: 'https://preview.example.test' }, [])).toThrow('NODETERM_PUBLIC_ORIGIN')
    expect(() => resolveConfig({ NODETERM_PUBLIC_ORIGIN: 'https://term.example.test', NODETERM_PREVIEW_ORIGIN: 'https://term.example.test:444' }, [])).toThrow('distinct hostname')
  })
})
