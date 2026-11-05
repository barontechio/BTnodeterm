import { it, expect, vi, afterEach } from 'vitest'
import https from 'node:https'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { createECDH } from 'node:crypto'
import webpush from 'web-push'
import { publicPushAddress, providerOrigin, parseSubscription, sendWebPush } from './web-push-transport'
const providers = ['https://push.example.com']
const key = createECDH('prime256v1'); key.generateKeys()
const sub = { endpoint: providers[0] + '/push/opaque', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }
afterEach(() => vi.restoreAllMocks())
it.each(['127.0.0.1', '0.0.0.0', '10.2.3.4', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '64:ff9b::7f00:1', '2001:db8::1'])('rejects private/reserved address %s', address => expect(publicPushAddress(address)).toBe(false))
it('accepts global addresses only', () => { expect(publicPushAddress('8.8.8.8')).toBe(true); expect(publicPushAddress('2606:4700:4700::1111')).toBe(true) })
it.each(['https://localhost', 'https://127.0.0.1', 'http://push.example.com', 'https://push.example.com:444', 'https://push.example.com/', 'https://push.example.com@evil.test'])('refuses invalid provider %s', origin => expect(() => providerOrigin(origin)).toThrow())
it('validates subscription keys and exact origins before any network use', () => {
  expect(parseSubscription(sub, providers)).toEqual(sub)
  for (const endpoint of ['https://push.example.com.evil.test/p', 'https://push.example.com@evil.test/p', 'https://push.example.com/p#x', 'https://push.example.com:444/p', 'https://push.example.com/']) expect(() => parseSubscription({ ...sub, endpoint }, providers)).toThrow()
  expect(() => parseSubscription({ ...sub, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: sub.keys.auth } }, providers)).toThrow()
})
it('blocks a mixed public/private DNS answer and rechecks owner after lookup', async () => {
  const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as never)
  const request = vi.spyOn(https, 'request')
  const input = { subscription: sub, providers, payload: '{}', vapid: webpush.generateVAPIDKeys(), subject: 'mailto:operator@example.com', current: () => true, signal: new AbortController().signal }
  await expect(sendWebPush(input)).rejects.toThrow(/destination/); expect(request).not.toHaveBeenCalled()
  let current = true
  lookup.mockImplementation(async () => { current = false; return [{ address: '8.8.8.8', family: 4 }] as never })
  await expect(sendWebPush({ ...input, current: () => current })).rejects.toThrow(/destination/); expect(request).not.toHaveBeenCalled()
})
it('pins the actual request lookup, sends VAPID and encrypted bytes, and returns redirects without following', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
  const request = vi.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
    const options = args[1] as https.RequestOptions
    expect(options.agent).toBe(false)
    expect(options.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm' })
    expect(String((options.headers as Record<string, unknown>).Authorization)).toMatch(/^vapid /)
    const lookup = options.lookup as Function
    lookup('push.example.com', {}, (err: unknown, address: string, family: number) => { expect(err).toBeNull(); expect(address).toBe('8.8.8.8'); expect(family).toBe(4) })
    const req = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void }
    req.destroy = () => { req.emit('close') }
    req.end = (body: Buffer) => {
      expect(body.length).toBeGreaterThan(32); expect(body.toString()).not.toContain('PRIVATE')
      const res = new EventEmitter() as EventEmitter & { statusCode: number }; res.statusCode = 302
      ;(args[2] as Function)(res); res.emit('end'); req.emit('close')
    }
    return req as never
  })
  expect(await sendWebPush({ subscription: sub, providers, payload: '{"PRIVATE":"content"}', vapid: webpush.generateVAPIDKeys(), subject: 'mailto:operator@example.com', current: () => true, signal: new AbortController().signal })).toBe(302)
  expect(request).toHaveBeenCalledTimes(1)
})
it('uses the real Node lookup callback contract and transmits encrypted bytes to a private provider fixture', async () => {
  const http = await import('node:http')
  const { createRequire } = await import('node:module')
  const ece = createRequire(import.meta.url)('http_ece') as { decrypt(data: Buffer, params: unknown): Buffer }
  let received = ''
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      received = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: key, authSecret: Buffer.from(sub.keys.auth, 'base64url') }).toString()
      res.writeHead(201); res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
  // Keep Node's actual socket/lookup machinery. Only this fixture routes the checked public
  // address to its loopback HTTP receiver; production continues using verified HTTPS/SNI.
  vi.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
    const options = args[1] as https.RequestOptions
    const pinned = options.lookup as Function
    return http.request(`http://fixture.invalid:${port}/push`, { ...options, lookup: (host, opts, cb) => {
      pinned(host, opts, (err: Error | null, address: string | {address: string; family: number}[], family: number) => {
        expect(typeof address === 'string' ? address : address[0].address).toBe('8.8.8.8')
        // Preserve scalar vs array callback contract: the original bug fails in real Node here.
        if (typeof address === 'string') (cb as Function)(err, '127.0.0.1', family)
        else (cb as Function)(err, address.map(a => ({ ...a, address: '127.0.0.1' })))
      })
    } }, args[2] as (res: import('node:http').IncomingMessage) => void) as never
  })
  try {
    const payload = JSON.stringify({ v: 1, noticeId: 'opaque-receipt', kind: 'done' })
    const status = await sendWebPush({ subscription: sub, providers, payload, vapid: webpush.generateVAPIDKeys(), subject: 'mailto:operator@example.com', current: () => true, signal: new AbortController().signal })
    expect(status).toBe(201); expect(received).toBe(payload)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
