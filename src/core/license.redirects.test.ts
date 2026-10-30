import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'

it('never redirects a license key or stored entitlement to another HTTP destination', async () => {
  let harvested = 0
  const sink = http.createServer((req, res) => { harvested++; req.resume(); res.end('{}') })
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const receiver = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/unexpected`
  const paths: string[] = []
  const authority = http.createServer((req, res) => {
    paths.push(req.url!); req.resume(); res.writeHead(307, { location: receiver }); res.end()
  })
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('NODETERM_API_BASE', `http://127.0.0.1:${(authority.address() as AddressInfo).port}`)
  vi.stubEnv('NODETERM_TELEMETRY_DISABLED', ''); vi.stubEnv('DO_NOT_TRACK', '')
  vi.resetModules()
  const { initPlatform, resetPlatformForTests } = await import('./platform')
  const platform = fakePlatform(); initPlatform(platform)
  const { initLicense } = await import('./license')
  const service = initLicense(undefined, { background: false })
  try {
    expect(await platform.handlers[IPC.licenseActivate]('fixture-key')).toMatchObject({ active: false, error: 'offline' })
    fs.writeFileSync(path.join(platform.userDataDir, 'license.json'), JSON.stringify({ token: 'fixture-entitlement' }))
    expect(await platform.handlers[IPC.licenseDetail]()).toMatchObject({ error: 'offline' })
    expect(paths).toEqual(['/v1/license/activate', '/v1/license/detail'])
    expect(harvested).toBe(0)
  } finally {
    await service.dispose(); resetPlatformForTests(); vi.unstubAllEnvs()
    await Promise.all([sink, authority].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  }
}, 10_000)
