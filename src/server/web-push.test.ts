import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createECDH } from 'node:crypto'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { createServerWebPush, type ServerWebPush } from './web-push'
import { testTmpDir } from '../core/test-tmp'
import { initAgentStatusMirror, _resetForTest, recordAgentEvent } from '../core/agent-status-mirror'
const sender = vi.hoisted(() => vi.fn(async (_input: { payload: string }) => 201))
vi.mock('../core/web-push-transport', async original => ({ ...await original<typeof import('../core/web-push-transport')>(), sendWebPush: sender }))
let dir: string, auth: Auth, cookie: string, webPush: ServerWebPush, server: http.Server, origin: string
const publicOrigin = 'https://term.example.com'
const env = { NODETERM_WEB_PUSH_PROVIDERS: 'https://push.example.com', NODETERM_WEB_PUSH_SUBJECT: 'mailto:operator@example.com' }
const key = createECDH('prime256v1'); key.generateKeys()
const subscription = { endpoint: 'https://push.example.com/p/device', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }
beforeEach(async () => {
  sender.mockClear(); _resetForTest(); dir = testTmpDir('server-web-push-'); auth = new Auth(dir); cookie = 'nt_session=' + auth.createSession()
  initAgentStatusMirror(path.join(dir, 'mirror.json'))
  const node = { id: 'node', kind: 'terminal' }
  const workspace = { projectIdsForNode: () => ['project'], getNodeForHostAction: () => node, persistedCanvases: () => [{ id: 'project', nodes: [node] }] } as never
  webPush = await createServerWebPush({ auth, workspace, dataDir: dir, publicOrigin, env })
  await fs.writeFile(path.join(dir, 'web-push-sw.js'), '/* fixture worker */')
  server = http.createServer(createHttpHandler({ auth, rendererDir: dir, webPush, publicOrigin }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
})
afterEach(async () => { await webPush.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); _resetForTest() })
async function request(operation: string, body: unknown = {}, extra: Record<string, string> = {}, method = 'POST') {
  const res = await fetch(origin + '/auth/web-push/' + operation, { method, headers: { cookie, origin: publicOrigin, 'content-type': 'application/json', ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), redirect: 'manual' })
  return { status: res.status, body: await res.json() }
}
it('advertises only configured capability to the real cookie owner and requires explicit JSON origin', async () => {
  expect((await request('capability', null, {}, 'GET')).body).toMatchObject({ available: true })
  expect((await request('capability', null, { cookie: '' }, 'GET')).status).toBe(403)
  for (const headers of ([{ origin: 'https://evil.test' }, { origin: 'null' }, { origin: '' }, { 'content-type': 'text/plain' }, { cookie: 'nt_session=relay-agent' }] as Record<string, string>[])) expect((await request('subscribe', { projectId: 'project', subscription }, headers)).status).toBe(403)
  expect(sender).not.toHaveBeenCalled()
})
it('subscribes with strict project/provider inputs, then processes a real host event without any page or WS', async () => {
  expect((await request('subscribe', { projectId: '../project', subscription })).status).toBe(400)
  expect((await request('subscribe', { projectId: 'project', subscription: { ...subscription, endpoint: 'https://127.0.0.1/admin' } })).status).toBe(400)
  expect((await request('subscribe', { projectId: 'project', subscription })).status).toBe(200)
  expect((await request('status', { endpoint: subscription.endpoint })).body).toMatchObject({ enabled: true, projectId: 'project' })
  recordAgentEvent({ nodeId: 'node', agentId: 'codex', kind: 'state', state: 'working', sessionId: 'cli-session', newTurn: true })
  recordAgentEvent({ nodeId: 'node', agentId: 'codex', kind: 'state', state: 'done', sessionId: 'cli-session' })
  await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1))
  const message = JSON.parse(sender.mock.calls[0][0].payload)
  expect((await request('resolve', { noticeId: message.noticeId })).body).toEqual({ projectId: 'project', nodeId: 'node', sessionId: 'cli-session' })
  const other = auth.createSession()
  expect((await request('resolve', { noticeId: message.noticeId }, { cookie: 'nt_session=' + other })).status).toBe(404)
  auth.revokeAll()
  expect((await request('resolve', { noticeId: message.noticeId })).status).toBe(403)
})
it('explicitly disables and logout cannot recreate a durable grant', async () => {
  await request('subscribe', { projectId: 'project', subscription })
  expect((await request('unsubscribe', { endpoint: subscription.endpoint })).status).toBe(200)
  expect((await request('status', { endpoint: subscription.endpoint })).body).toEqual({ enabled: false })
  auth.revokeAll()
  expect((await request('subscribe', { projectId: 'project', subscription })).status).toBe(403)
})
it('does not allocate VAPID keys or fake success when configuration is absent', async () => {
  const empty = testTmpDir('web-push-unconfigured-')
  const disabled = await createServerWebPush({ auth, workspace: {} as never, dataDir: empty, env: {} })
  try { expect(await fs.readdir(empty)).toEqual([]) } finally { await disabled.close() }
})
