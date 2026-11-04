import type { CorePlatform } from '../core/platform'
import { decodeJoinCode } from '../core/relay/join-code'
import { mintDeviceToken, mintJoinToken } from '../core/relay/join-token'
import { BROWSER_JOIN_DEVICE, BROWSER_JOIN_TOKEN } from '../shared/browser-join'

/** The host's fixed relay API only; this is not a URL proxy or a route available to peers. */
export function registerBrowserJoin(platform: CorePlatform, options: { apiBase?: string; fetch?: typeof fetch } = {}): void {
  const apiBase = options.apiBase ?? process.env.NODETERM_API_BASE ?? 'https://api.nodeterm.dev'
  const safeFetch: typeof fetch = (url, init) => (options.fetch ?? fetch)(url, { ...init, redirect: 'error', credentials: 'omit' })
  let pending = 0
  const run = async <T>(id: number, work: () => Promise<T>): Promise<T> => {
    if (!platform.isOwnerClient?.(id)) throw new Error('browser-join-owner-required')
    if (pending >= 4) throw new Error('[E_JOIN_BUSY] Browser join is busy')
    pending++
    try {
      const result = await work()
      if (!platform.isOwnerClient?.(id)) throw new Error('browser-join-owner-departed')
      return result
    } finally { pending-- }
  }
  platform.handleWithSender(BROWSER_JOIN_DEVICE, (id, raw: unknown) => run(id, async () => {
    if (!raw || typeof raw !== 'object') throw new Error('invalid browser join')
    const { code: text, deviceId, label } = raw as Record<string, unknown>
    const code = typeof text === 'string' ? decodeJoinCode(text) : null
    if (!code || typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(deviceId) || typeof label !== 'string' || label.length > 60) throw new Error('invalid browser join')
    return mintDeviceToken({ apiBase, deviceId: `${deviceId}:${code.hostId}`, code, label, fetch: safeFetch })
  }))
  platform.handleWithSender(BROWSER_JOIN_TOKEN, (id, token: unknown) => run(id, async () => {
    if (typeof token !== 'string' || !token || token.length > 8192) throw new Error('invalid browser join token')
    return mintJoinToken({ apiBase, deviceToken: token, fetch: safeFetch })
  }))
}
