import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import type { MediaReferences } from '../core/media-references'
import { registerServerMedia } from './media-ipc'
import { createHttpHandler, SESSION_COOKIE } from './http'
import { Auth } from './auth'
import { IPC } from '../shared/ipc'

describe('authenticated Server media streaming', () => {
  let platform: FakePlatform
  let refs: MediaReferences
  let workspace: WorkspaceStore
  let server: http.Server
  let auth: Auth
  let base: string
  let cookie: string
  let file: string
  let bytes: Buffer
  const scope = { projectId: 'p', nodeId: 'video' }
  const allow = (clientId = 1, filePath = file, context: unknown = scope): Promise<string> =>
    Promise.resolve(platform.handlers[IPC.mediaAllowScoped](clientId, filePath, context)) as Promise<string>
  beforeEach(async () => {
    const dir = testTmpDir('server-media-')
    fs.mkdirSync(path.join(dir, 'data')); fs.mkdirSync(path.join(dir, 'renderer'))
    fs.writeFileSync(path.join(dir, 'renderer', 'index.html'), 'app')
    bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('abcdefghijklmnopqrstuvwxyz')])
    file = path.join(dir, 'clip.mp4'); fs.writeFileSync(file, bytes)
    platform = fakePlatform({ userDataDir: path.join(dir, 'data'), isOwnerClient: (id) => id === 1 })
    resetPlatformForTests(); initPlatform(platform)
    workspace = new WorkspaceStore()
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Media', cwd: dir, color: '#0a84ff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'video', kind: 'video', filePath: file, title: 'clip', color: '#bf5af2',
        group: null, size: { width: 640, height: 420 }, position: { x: 0, y: 0 } }] }] })
    refs = registerServerMedia(platform, workspace); auth = new Auth(dir)
    cookie = `${SESSION_COOKIE}=${auth.createSession()}`
    server = http.createServer(createHttpHandler({ auth, rendererDir: path.join(dir, 'renderer'), mediaReferences: refs }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => { refs.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); resetPlatformForTests() })

  it('streams and seeks repeatedly using the same opaque reference, with correct MIME and no path exposure', async () => {
    const url = await allow()
    expect(url).toMatch(/^\/media\?ref=[\w-]+$/)
    for (const [range, start, end] of [['bytes=12-17', 12, 17], ['bytes=-4', bytes.length - 4, bytes.length - 1]] as const) {
      const response = await fetch(base + url, { headers: { cookie, range } })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
      expect(response.headers.get('content-type')).toBe('video/mp4')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1))
    }
    const full = await fetch(base + url, { headers: { cookie } })
    expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes)
  })

  it('requires HTTP authentication even with a reference and invalidates future reads after logout', async () => {
    const url = await allow()
    expect((await fetch(base + url, { redirect: 'manual' })).status).toBe(401)
    auth.revokeAll()
    expect((await fetch(base + url, { headers: { cookie }, redirect: 'manual' })).status).toBe(401)
  })

  it('supports HEAD, rejects unsatisfiable ranges and refuses unsupported methods', async () => {
    const url = await allow()
    const head = await fetch(base + url, { method: 'HEAD', headers: { cookie } })
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(bytes.length)); expect(await head.text()).toBe('')
    const empty = await fetch(base + url, { headers: { cookie, range: 'bytes=99999-' } })
    expect(empty.status).toBe(416); expect(empty.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
    expect((await fetch(base + url, { method: 'POST', headers: { cookie, origin: base } })).status).toBe(405)
    expect((await fetch(`${base}/media?path=${encodeURIComponent(file)}`, { headers: { cookie } })).status).toBe(404)
  })

  it('refuses guest issuance, another project, forged paths and remote or removed nodes', async () => {
    const issue = vi.spyOn(refs, 'issue')
    await expect(allow(2)).rejects.toThrow('owner')
    expect(issue).not.toHaveBeenCalled()
    await expect(allow(1, file, { ...scope, projectId: 'another' })).rejects.toThrow('refused')
    await expect(allow(1, '/etc/passwd')).rejects.toThrow('refused')
    const url = await allow()
    await workspace.updateWorkspace((fresh) => { fresh.projects[0].nodes[0].sshFs = true; return fresh })
    expect((await fetch(base + url, { headers: { cookie } })).status).toBe(404)
    await expect(allow()).rejects.toThrow('refused')
  })

  it('renews and releases only owner references and revokes them when their client disconnects', async () => {
    const url = await allow(); const token = new URL(base + url).searchParams.get('ref')!
    expect(await platform.handlers[IPC.mediaRenew](2, token)).toBe(false)
    expect(await platform.handlers[IPC.mediaRenew](1, token)).toBe(true)
    await platform.handlers[IPC.mediaRelease](2, token)
    const live = await fetch(base + url, { headers: { cookie } }); expect(live.status).toBe(200); await live.arrayBuffer()
    refs.forgetClient(1)
    expect((await fetch(base + url, { headers: { cookie } })).status).toBe(404)
  })
})
