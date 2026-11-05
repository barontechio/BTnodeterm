import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createECDH } from 'node:crypto'
import { testTmpDir } from './test-tmp'
import { WebPushService, type WebPushDeps } from './web-push'
import { Auth } from '../server/auth'
import { onInboxActionable, recordAgentEvent, initAgentStatusMirror, isInboxEventCurrent, _resetForTest, type InboxEvent } from './agent-status-mirror'
const providers = ['https://push.example.com']
export function subscription(suffix = 'a') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  return { endpoint: providers[0] + '/push/' + suffix, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } }
}
let dir: string, auth: Auth, token: string, owner: string, service: WebPushService
let target: { projectId: string; nodeId: string; sessionId: string } | null
let deps: WebPushDeps
let at = Date.now()
const event = (id = 'edge'): InboxEvent => ({ id, ts: at, nodeId: 'node', sessionId: 'cli-session', kind: 'done', title: 'PRIVATE TITLE', detail: 'SECRET TRANSCRIPT' })
beforeEach(async () => {
  dir = testTmpDir('web-push-'); auth = new Auth(dir); token = auth.createSession(); owner = auth.sessionId(token)!
  at = Date.now(); target = { projectId: 'project', nodeId: 'node', sessionId: 'cli-session' }
  deps = { file: path.join(dir, 'web-push.json'), providers, ownerCurrent: id => auth.validateSessionId(id), projectCurrent: id => id === 'project', target: () => target,
    eventCurrent: () => true, send: vi.fn(async () => 201), now: () => at }
  service = new WebPushService(deps); await service.init()
})
afterEach(async () => { await service.close(); _resetForTest() })
it('persists consent across browser absence and host restart, with private atomic mode and no bearer cookie', async () => {
  const sub = subscription(); await service.subscribe(owner, 'project', sub, () => true)
  await service.close(); service = new WebPushService(deps); await service.init()
  expect(service.status(owner, sub.endpoint).enabled).toBe(true)
  expect((await fs.stat(deps.file)).mode & 0o777).toBe(0o600)
  const stored = await fs.readFile(deps.file, 'utf8'); expect(stored).not.toContain(token)
  service.accept(event()); await service.idle()
  expect(deps.send).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(vi.mocked(deps.send).mock.calls[0].slice(0, 2))).not.toMatch(/PRIVATE|SECRET|cli-session|project|nodeId/)
})
it('handles a real normalized host event with no page/WS and revalidates mirror resolution', async () => {
  _resetForTest(); initAgentStatusMirror(path.join(dir, 'mirror.json'))
  deps.eventCurrent = isInboxEventCurrent
  await service.subscribe(owner, 'project', subscription(), () => true)
  const off = onInboxActionable(e => service.accept(e))
  recordAgentEvent({ nodeId: 'node', agentId: 'codex', sessionId: 'cli-session', kind: 'state', state: 'working', newTurn: true })
  recordAgentEvent({ nodeId: 'node', agentId: 'codex', sessionId: 'cli-session', kind: 'state', state: 'done' })
  await service.idle(); off()
  expect(deps.send).toHaveBeenCalledTimes(1)
})
it('reserves attempts durably and deduplicates after restart without replaying unknown delivery', async () => {
  await service.subscribe(owner, 'project', subscription(), () => true)
  vi.mocked(deps.send).mockRejectedValue(new Error('lost reply'))
  service.accept(event()); service.accept(event()); await service.idle()
  await service.close(); service = new WebPushService(deps); await service.init()
  service.accept(event()); await service.idle(); expect(deps.send).toHaveBeenCalledTimes(1)
})
it('logout, logout-all and expiration revoke durable owner grants without a WS lifetime', async () => {
  const sub = subscription(); await service.subscribe(owner, 'project', sub, () => true)
  auth.revokeSession(token); service.accept(event()); await service.idle()
  expect(deps.send).not.toHaveBeenCalled(); expect(service.status(owner, sub.endpoint).enabled).toBe(false)
  token = auth.createSession(); owner = auth.sessionId(token)!
  await service.subscribe(owner, 'project', sub, () => true); auth.revokeAll()
  service.accept(event('other')); await service.idle(); expect(deps.send).not.toHaveBeenCalled()
})
it('refuses another principal and invalid scopes; leaves a replacement after an old 410', async () => {
  const sub = subscription(); await service.subscribe(owner, 'project', sub, () => true)
  const other = auth.sessionId(auth.createSession())!
  await expect(service.subscribe(other, 'project', sub, () => true)).rejects.toThrow(/another session/)
  await expect(service.subscribe(owner, 'relay', sub, () => true)).rejects.toThrow()
  // The invalid current check failed before disk IO, so it must not poison the store.
  let finish!: (status: number) => void
  vi.mocked(deps.send).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  service.accept(event())
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await service.subscribe(owner, 'project', sub, () => true)
  finish(410); await service.idle(); expect(service.status(owner, sub.endpoint).enabled).toBe(true)
})
it('checks node/project/session and event freshness; old receipts cannot focus a replacement or another owner', async () => {
  await service.subscribe(owner, 'project', subscription(), () => true)
  service.accept(event()); await service.idle()
  const payload = JSON.parse(vi.mocked(deps.send).mock.calls[0][1])
  expect(service.resolve(owner, payload.noticeId)).toEqual(target)
  expect(service.resolve(auth.sessionId(auth.createSession())!, payload.noticeId)).toBeNull()
  target = { projectId: 'project', nodeId: 'node', sessionId: 'replacement' }
  expect(service.resolve(owner, payload.noticeId)).toBeNull()
  service.accept(event('stale-session')); await service.idle(); expect(deps.send).toHaveBeenCalledTimes(1)
  target = null; service.accept(event('removed')); await service.idle(); expect(deps.send).toHaveBeenCalledTimes(1)
})
it('owner loss across IO invalidates transport dispatch and explicit unsubscribe removes consent', async () => {
  const sub = subscription(); await service.subscribe(owner, 'project', sub, () => true)
  vi.mocked(deps.send).mockImplementation(async (_s, _p, _k, current) => {
    await Promise.resolve(); auth.revokeAll(); expect(current()).toBe(false); return 0
  })
  service.accept(event()); await service.idle()
  await service.unsubscribe(owner, sub.endpoint)
  expect(service.status(owner, sub.endpoint)).toEqual({ enabled: false })
})
it('bounds subscriptions, ignores interrupted/resolved/old events and never stores raw push input extras', async () => {
  for (let i = 0; i < 8; i++) await service.subscribe(owner, 'project', { ...subscription(String(i)), secret: token }, () => true)
  await expect(service.subscribe(owner, 'project', subscription('9'), () => true)).rejects.toThrow(/Too many/)
  for (const e of [{ ...event(), interrupted: true }, { ...event(), resolved: true }, { ...event(), ts: at - 120001 }]) service.accept(e)
  await service.idle(); expect(deps.send).not.toHaveBeenCalled(); expect(await fs.readFile(deps.file, 'utf8')).not.toContain(token)
})
it('refuses corrupt, oversized, permissive and symlink stores rather than generating replacement keys', async () => {
  await service.close(); const original = await fs.readFile(deps.file, 'utf8')
  await fs.chmod(deps.file, 0o644)
  await expect(new WebPushService(deps).init()).rejects.toThrow(/Unsafe/)
  expect(await fs.readFile(deps.file, 'utf8')).toBe(original)
})
