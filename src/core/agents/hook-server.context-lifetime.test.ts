import { randomBytes } from 'node:crypto'
import { nodeAuthToken } from './node-auth-token'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import type { ContextLinkRequestScope } from '../context-link'

beforeAll(async () => {
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: testTmpDir('context-http-lifetime-') }))
  await hookServer.start()
})
afterAll(() => { hookServer.stop(); hookServer.clearNodeAuthSecretForTests(); resetPlatformForTests() })
const post = (signal?: AbortSignal, token?: string) => fetch(`http://127.0.0.1:${hookServer.getPort()}/context-link/transcript`, {
  method: 'POST', signal,
  headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(), 'content-type': 'application/x-www-form-urlencoded',
    ...(token ? { 'X-Nodeterm-Node-Token': token } : {}) },
  body: 'nodeId=caller&arg.node=target'
})

describe('context-link HTTP request lifetime', () => {
  it('keeps a completed POST body active and revokes the scope after answering', async () => {
    let scope!: ContextLinkRequestScope
    hookServer.setContextLinkHandler(async (request) => {
      scope = request.scope!
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(scope.signal?.aborted).toBe(false)
      expect(scope.verified?.()).toBe(false) // bearer alone is not per-node agent proof
      return 'linked result'
    })
    const response = await post()
    expect(response.status).toBe(200)
    expect((await response.text()).trim()).toBe('linked result')
    expect(scope.signal?.aborted).toBe(true)
    expect(scope.verified?.()).toBe(false)
    expect(scope.retainAuthorization?.(() => true)).toBe(false)
  })

  it('revokes a still-running read when the caller closes its response socket', async () => {
    let started!: () => void; let cancelled!: () => void
    const begun = new Promise<void>((resolve) => { started = resolve })
    const ended = new Promise<void>((resolve) => { cancelled = resolve })
    hookServer.setContextLinkHandler(async ({ scope }) => {
      expect(scope?.signal?.aborted).toBe(false)
      started()
      await new Promise<void>((resolve) => scope!.signal!.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
      return 'must not be delivered'
    })
    const abort = new AbortController()
    const request = post(abort.signal).catch(() => null)
    await begun; abort.abort()
    await ended
    expect(await request).toBeNull()
  }, 5000)

  it('exposes live per-node identity proof, not just the hook bearer', async () => {
    const secret = randomBytes(32); hookServer.setNodeAuthSecret(secret)
    hookServer.setContextLinkHandler(async ({ scope }) => {
      expect(scope?.verified?.()).toBe(true)
      hookServer.setNodeAuthSecret(randomBytes(32))
      expect(scope?.verified?.()).toBe(false)
      return 'proof revoked'
    })
    const response = await post(undefined, nodeAuthToken(secret, 'caller'))
    expect((await response.text()).trim()).toBe('proof revoked')
  })


  it.each([0, 1])('checks every retained result at publication (revoked member %s)', async (revoked) => {
    hookServer.clearNodeAuthSecretForTests()
    const valid = [true, true]
    hookServer.setContextLinkHandler(async ({ scope }) => {
      expect(scope?.retainAuthorization?.(() => valid[0])).toBe(true)
      expect(scope?.retainAuthorization?.(() => valid[1])).toBe(true)
      queueMicrotask(() => { valid[revoked] = false })
      return 'combined private results'
    })
    const response = await post()
    expect(await response.text()).not.toContain('combined private results')
  })

})
