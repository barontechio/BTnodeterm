import { expect, it, vi } from 'vitest'
import { registerBrowserJoin } from './browser-join'
import { fakePlatform } from '../core/platform-fake'
import { BROWSER_JOIN_DEVICE, BROWSER_JOIN_TOKEN } from '../shared/browser-join'
import { isHostOnlyChannel } from '../shared/host-control'
import { genKeyPair, publicKeyToB64 } from '../core/relay/e2ee'
import { hostIdFromPublicKeyB64 } from '../core/relay/relay-id'
import { encodeJoinCode } from '../core/relay/join-code'

it('broker is owner-only and uses only fixed API paths with exact validated identity', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ deviceToken: 'device' }), { status: 200 }))
  const platform = fakePlatform({ isOwnerClient: id => id === 1 })
  registerBrowserJoin(platform, { apiBase: 'https://api.example', fetch: fetch as typeof globalThis.fetch })
  const key = publicKeyToB64(genKeyPair().publicKey)
  const code = encodeJoinCode({ v: 1, relayEndpoint: 'wss://relay.example', hostId: hostIdFromPublicKeyB64(key), hostPublicKeyB64: key, hostDeviceId: 'host', label: 'Team' })
  for (const method of [BROWSER_JOIN_DEVICE, BROWSER_JOIN_TOKEN]) {
    expect(isHostOnlyChannel(method)).toBe(true)
    await expect(platform.handlers[method](2, 'forged')).rejects.toThrow('owner-required')
  }
  expect(fetch).not.toHaveBeenCalled()
  const data = { code, deviceId: '12345678-1234-1234-1234-123456789abc', label: 'Browser' }
  await expect(platform.handlers[BROWSER_JOIN_DEVICE](1, data)).resolves.toEqual({ ok: true, deviceToken: 'device' })
  expect(fetch.mock.calls[0][0]).toBe('https://api.example/v1/relay/device')
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ deviceId: `${data.deviceId}:${hostIdFromPublicKeyB64(key)}`, hostDeviceId: 'host', hostPublicKeyB64: key, label: 'Browser' })
  await expect(platform.handlers[BROWSER_JOIN_DEVICE](1, { ...data, code: 'https://evil.test' })).rejects.toThrow('invalid')
})

it('does not hand a token to a departed owner after the API await', async () => {
  let owner = true, finish!: (response: Response) => void
  const platform = fakePlatform({ isOwnerClient: () => owner })
  registerBrowserJoin(platform, { fetch: (() => new Promise(resolve => { finish = resolve })) as typeof fetch })
  const pending = platform.handlers[BROWSER_JOIN_TOKEN](1, 'device')
  owner = false
  finish(new Response(JSON.stringify({ pairingToken: 'short-lived', relayEndpoint: 'wss://relay.example' }), { status: 200 }))
  await expect(pending).rejects.toThrow('owner-departed')
})
