import https from 'node:https'
import dns from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import webpush from 'web-push'

export interface WebSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface VapidKeys { publicKey: string; privateKey: string }

// Only globally routed unicast. IPv6 transition/translation mechanisms can embed private IPv4.
const blocked = new BlockList()
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(ip, prefix)
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(ip, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
export function publicPushAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function providerOrigin(raw: string): string {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || u.search || u.pathname !== '/' ||
      isIP(u.hostname.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname) ||
      raw !== u.origin) throw new Error('Invalid Web Push provider origin')
  return u.origin
}
export function pushEndpoint(raw: unknown, providers: readonly string[]): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid subscription endpoint')
  const u = new URL(raw)
  if (!providers.includes(u.origin) || u.protocol !== 'https:' || u.username || u.password || u.hash ||
      raw !== u.href || u.pathname === '/') throw new Error('Unapproved subscription endpoint')
  return raw
}
export function parseSubscription(raw: unknown, providers: readonly string[]): WebSubscription {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid subscription')
  const s = raw as Record<string, unknown>
  const k = s.keys as Record<string, unknown> | undefined
  const key = (v: unknown, size: number): string => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v) || Buffer.from(v, 'base64url').length !== size || Buffer.from(v, 'base64url').toString('base64url') !== v) throw new Error('Invalid subscription key')
    return v
  }
  const p256dh = key(k?.p256dh, 65)
  if (Buffer.from(p256dh, 'base64url')[0] !== 4) throw new Error('Invalid subscription public key')
  // Validate the actual curve point, not just its encoded length.
  webpush.encrypt(p256dh, key(k?.auth, 16), '', 'aes128gcm')
  return { endpoint: pushEndpoint(s.endpoint, providers), keys: { p256dh, auth: key(k?.auth, 16) } }
}

/** Build encryption + VAPID with web-push 3.6.7, then own the HTTP request. Its stock sender
 * accumulates an unbounded response; custom transport pins checked DNS, bounds time/body, and
 * never follows redirects or consults proxy environment variables. No request retry. */
export async function sendWebPush(input: {
  subscription: WebSubscription; payload: string; vapid: VapidKeys; subject: string;
  providers: readonly string[]; current(): boolean; signal: AbortSignal
}): Promise<number> {
  const endpoint = new URL(pushEndpoint(input.subscription.endpoint, input.providers))
  if (Buffer.byteLength(input.payload) > 1024 || !input.current() || input.signal.aborted) throw new Error('Push refused')
  const answers = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Push DNS deadline')), 3000)
    dns.lookup(endpoint.hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => clearTimeout(timer))
  })
  if (!answers.length || answers.some(a => !publicPushAddress(a.address)) || !input.current() || input.signal.aborted) throw new Error('Push destination refused')
  const details = webpush.generateRequestDetails(input.subscription, input.payload, {
    vapidDetails: { subject: input.subject, ...input.vapid }, TTL: 60, urgency: 'normal', contentEncoding: 'aes128gcm'
  })
  if (!input.current()) throw new Error('Push revoked')
  return new Promise((resolve, reject) => {
    const address = answers[0]
    // Node's socket option is accepted by HTTP but not listed in @types/node RequestOptions.
    const connection = { family: address.family, autoSelectFamily: false }
    const req = https.request(endpoint, {
      ...connection,
      method: 'POST', headers: details.headers, agent: false, signal: input.signal,
      // A fresh socket uses exactly this vetted address, retaining hostname for TLS/SNI checks.
      lookup: (_host, _opts, cb) => cb(null, address.address, address.family)
    }, res => {
      let size = 0
      res.on('data', (data: Buffer) => { size += data.length; if (size > 4096) req.destroy(new Error('Push response too large')) })
      res.on('end', () => resolve(res.statusCode ?? 0))
      res.on('error', reject)
    })
    req.on('socket', socket => socket.once('secureConnect', () => { if (!input.current() || input.signal.aborted) req.destroy(new Error('Push revoked')) }))
    const deadline = setTimeout(() => req.destroy(new Error('Push deadline')), 10_000)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    // Last synchronous authority check before bytes can leave the host.
    if (!input.current() || input.signal.aborted) req.destroy(new Error('Push revoked'))
    else req.end(details.body)
  })
}
