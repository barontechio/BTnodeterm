import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerServerLicense } from './license'
import { ServerPlatform } from './platform-server'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { __licenseRefreshesForTests } from '../core/license'
import { testTmpDir } from '../core/test-tmp'
import { IPC } from '../shared/ipc'

let platform: ServerPlatform; let service: ReturnType<typeof registerServerLicense> | undefined
let owner: number; let guest: number; let requestId = 0
const fetchMock = vi.fn(); const changed = vi.fn()
const call = (id: number, method: string, ...args: unknown[]) => platform.dispatch(id, { t: 'req', id: ++requestId, method, args })
beforeEach(() => {
  vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1'); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset(); changed.mockReset()
  platform = new ServerPlatform({ userDataDir: testTmpDir('server-license-'), appVersion: 'test' })
  initPlatform(platform); const sink = { sendText: () => {}, sendBinary: () => {} }
  owner = platform.attach(sink, { owner: true }); guest = platform.attach(sink)
})
afterEach(async () => { await service?.dispose(); await __licenseRefreshesForTests(); resetPlatformForTests(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('keeps licensing disabled without polling and refuses guest reads or mutations', async () => {
  service = registerServerLicense({ platform, enabled: false, onChanged: changed })
  expect(await call(owner, IPC.licenseCapabilities)).toMatchObject({ ok: true, result: { enabled: false, hostContext: 'server' } })
  expect(await call(owner, IPC.licenseStatus)).toMatchObject({ ok: true, result: { active: false, error: 'disabled' } })
  expect(await call(owner, IPC.licenseActivate, 'key')).toMatchObject({ ok: false, error: { message: expect.stringContaining('license-disabled') } })
  expect(await call(guest, IPC.licenseStatus)).toMatchObject({ ok: false, error: { message: 'owner-required' } })
  expect(fetchMock).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(platform.userDataDir, 'license.json'))).toBe(false)
})
it('returns checkout only to its requesting owner and preserves host device identity', async () => {
  service = registerServerLicense({ platform, enabled: true, onChanged: changed }); await __licenseRefreshesForTests()
  const device = fs.readFileSync(path.join(platform.userDataDir, 'device-id'), 'utf8')
  const reply = await call(owner, IPC.licenseUpgrade)
  expect(reply).toMatchObject({ ok: true, result: { checkoutUrl: expect.stringContaining(encodeURIComponent(device)), status: { active: false } } })
  expect(await call(guest, IPC.licenseUpgrade)).toMatchObject({ ok: false })
  expect(fetchMock).not.toHaveBeenCalled()
})
it('cannot persist a license reply after its owner connection leaves', async () => {
  service = registerServerLicense({ platform, enabled: true, onChanged: changed }); await __licenseRefreshesForTests()
  vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '')
  let answer!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve }))
  const activating = call(owner, IPC.licenseActivate, 'fixture-key')
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  service.forgetClient(owner); platform.detach(owner)
  answer(Response.json({ token: 'fixture-only' }))
  expect(await activating).toMatchObject({ ok: false, error: { message: 'license-owner-expired' } })
  expect(JSON.parse(fs.readFileSync(path.join(platform.userDataDir, 'license.json'), 'utf8')).token).toBeUndefined()
  expect(changed).not.toHaveBeenCalled()
})
