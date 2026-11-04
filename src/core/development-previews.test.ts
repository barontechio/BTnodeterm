import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { DevelopmentPreviews, type DevelopmentTarget } from './development-previews'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})
const target: DevelopmentTarget = { projectId: 'p', nodeId: 'n', generation: 'g', processIdentity: 'pid:birth:socket', hostIdentity: 'local', address: '127.0.0.1', port: 3000 }
const services: DevelopmentPreviews[] = []
afterEach(() => { for (const service of services.splice(0)) service.stop(); vi.mocked(crypto.randomBytes).mockClear() })
function service(base: string): DevelopmentPreviews {
  const previews = new DevelopmentPreviews(base, 'https://app.example', { resolve: async () => target })
  services.push(previews); return previews
}

describe('development preview DNS grant identity', () => {
  it.each(['https://127.0.0.1', 'https://[::1]', 'https://[2001:db8::1]', 'https://2130706433', 'https://localhost', 'https://bad_name.example', 'https://preview.example.', `https://${'a'.repeat(64)}.example`])('refuses non-DNS or non-normalized base %s', base => {
    expect(() => service(base)).toThrow()
  })
  it('refuses a grant collision without losing the earlier connection lifecycle', async () => {
    vi.mocked(crypto.randomBytes).mockReturnValueOnce(Buffer.alloc(24, 1) as never).mockReturnValueOnce(Buffer.alloc(24, 1) as never)
    const previews = service('https://preview.example')
    const origin = await previews.issue('owner', 'first')
    const closed = vi.fn()
    expect(await previews.acquire(new URL(origin).host, closed)).toEqual(target)
    await expect(previews.issue('owner', 'second')).rejects.toThrow('hostname unavailable')
    expect(closed).not.toHaveBeenCalled()
    previews.stop()
    expect(closed).toHaveBeenCalledOnce()
  })
})
