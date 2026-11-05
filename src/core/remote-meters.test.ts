import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerLifetimes } from './owner-lifetimes'
import { RemoteMeters, parseRemoteMeter, REMOTE_METER_TTL, REMOTE_METER_BYTES, type RemoteMeterSource } from './remote-meters'
import type { RemoteMeterStart, RemoteMeterUpdate } from '../shared/remote-meters'

const line = (used = 23, model = 'claude-sonnet-4') => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: used } } }) + '\n'
const page = (text = line(), start = 0) => ({ data: Buffer.from(text), start })
const token = (r: RemoteMeterStart) => { if (r.status !== 'started') throw Error(r.status); return r.leaseId }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  vi.useFakeTimers()
  const owners = new OwnerLifetimes(), owner = owners.get(1, () => true), second = owners.get(2, () => true)
  const service = new RemoteMeters()
  let valid = true
  const read = vi.fn<RemoteMeterSource['read']>(async () => page())
  const source: RemoteMeterSource = { key: 'private', nodeId: 'node', sessionId: 'session', harness: 'claude',
    current: () => valid, read }
  const updates: RemoteMeterUpdate[] = []
  const start = (who = owner, target = source) => token(service.start(who, target, u => updates.push(u)))
  return { owners, owner, second, service, source, read, updates, start, invalidate: () => { valid = false } }
}
afterEach(() => vi.useRealTimers())
describe('bounded remote owner demand', () => {
  it('does no IO without demand; coalesces owners and publishes only addressed renewals', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(60_000); expect(f.read).not.toHaveBeenCalled()
    const a = f.start(), b = f.start(f.second); await flush()
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.updates).toEqual([])
    expect(f.service.renew(f.owner, a)).toBe(true); expect(f.service.renew(f.second, b)).toBe(true)
    expect(f.updates.map(u => u.leaseId)).toEqual([a, b]); expect(f.updates[0].usage?.usedTokens).toBe(23)
    f.service.dispose()
  })
  it('rejects cross-owner renew/release and old owner replay after numeric id reuse', async () => {
    const f = fixture(); const id = f.start(); await flush()
    expect(f.service.renew(f.second, id)).toBe(false); f.service.release(f.second, id)
    expect(f.service.renew(f.owner, id)).toBe(true)
    f.owners.forget(1)
    const fresh = f.owners.get(1, () => true)
    expect(f.service.renew(fresh, id)).toBe(false)
    f.service.dispose()
  })
  it('expiry cannot be renewed or recapture original authority', async () => {
    const f = fixture(), id = f.start(); await vi.advanceTimersByTimeAsync(REMOTE_METER_TTL)
    expect(f.service.renew(f.owner, id)).toBe(false)
    expect(f.updates.at(-1)?.status).toBe('invalidated')
    const count = f.read.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000)
    expect(f.read).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0); f.service.dispose()
  })
  it('checks before dispatch and immediately before delivery; never publishes changed targets', async () => {
    const f = fixture(), id = f.start(); f.invalidate(); await flush()
    expect(f.read).not.toHaveBeenCalled(); expect(f.service.renew(f.owner, id)).toBe(false)
    expect(f.updates.every(u => u.usage === null)).toBe(true); f.service.dispose()
  })
  it('cancellation keeps actual capacity until four remote operations settle', async () => {
    const f = fixture(); const finish: Array<(p: ReturnType<typeof page>) => void> = []
    f.read.mockImplementation(() => new Promise(resolve => finish.push(resolve)))
    for (let i = 0; i < 4; i++) f.start(f.owner, { ...f.source, key: `target-${i}` })
    await flush(); expect(f.read).toHaveBeenCalledTimes(4)
    f.owners.forget(1)
    const id = f.start(f.second, { ...f.source, key: 'next' })
    await vi.advanceTimersByTimeAsync(3_000); expect(f.read).toHaveBeenCalledTimes(4)
    finish.forEach(resolve => resolve(page())); await flush(); await vi.advanceTimersByTimeAsync(500)
    expect(f.read).toHaveBeenCalledTimes(5)
    expect(f.service.renew(f.second, id)).toBe(true); expect(f.updates.at(-1)?.usage).toBeNull()
    f.service.dispose(); finish.at(-1)?.(page()); await flush()
  })
  it('does not reuse an abandoned in-flight group or its cached bytes', async () => {
    const f = fixture(); let finish!: (p: ReturnType<typeof page>) => void
    f.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const id = f.start(); await flush(); f.service.release(f.owner, id)
    expect(f.service.start(f.second, f.source, () => {})).toEqual({ status: 'capacity' })
    finish(page()); await flush()
    const fresh = f.start(f.second); expect(f.service.renew(f.second, fresh)).toBe(true)
    expect(f.updates.at(-1)?.usage).toBeNull(); f.service.dispose(); await flush()
  })
  it('bounds per-owner demand, total demand and renewal delivery frequency', async () => {
    const f = fixture(); const first = f.start()
    for (let i = 1; i < 32; i++) f.start()
    expect(f.service.start(f.owner, f.source, () => {})).toEqual({ status: 'capacity' })
    for (let i = 2; i <= 4; i++) { const owner = f.owners.get(i, () => true); for (let j = 0; j < 32; j++) f.start(owner) }
    expect(f.service.start(f.owners.get(5, () => true), f.source, () => {})).toEqual({ status: 'capacity' })
    await flush(); for (let i = 0; i < 100; i++) f.service.renew(f.owner, first)
    expect(f.updates).toHaveLength(1); f.service.dispose()
  })
  it('rotation/truncation never keeps an earlier observation; failures clear unknown', async () => {
    const f = fixture(), id = f.start(); await flush(); f.service.renew(f.owner, id)
    expect(f.updates.at(-1)?.usage?.usedTokens).toBe(23)
    f.read.mockResolvedValue(page('partial'))
    await vi.advanceTimersByTimeAsync(2_500); f.service.renew(f.owner, id)
    expect(f.updates.at(-1)?.status).toBe('unknown')
    f.read.mockResolvedValue(page(line(47))); await vi.advanceTimersByTimeAsync(2_500); f.service.renew(f.owner, id)
    expect(f.updates.at(-1)?.usage?.usedTokens).toBe(47)
    f.read.mockRejectedValue(Error('transport')); await vi.advanceTimersByTimeAsync(2_500); f.service.renew(f.owner, id)
    expect(f.updates.at(-1)?.usage).toBeNull(); f.service.dispose()
  })
  it('disposal aborts in-flight IO and discards late results without starting more work', async () => {
    const f = fixture(); let finish!: (p: ReturnType<typeof page>) => void
    f.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const id = f.start(); await flush(); const signal = f.read.mock.calls[0][2]
    f.service.dispose(); expect(signal.aborted).toBe(true); finish(page()); await flush()
    expect(f.service.renew(f.owner, id)).toBe(false)
    expect(f.updates.every(u => u.usage === null)).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
})
describe('shared parsers on complete bounded remote windows', () => {
  const source = { nodeId: 'node', sessionId: 's', harness: 'claude' as const }
  it('uses Claude shared accounting and explicitly estimated denominator', () => {
    expect(parseRemoteMeter(source, page(line(42)), 7)).toMatchObject({ usedTokens: 42, windowSource: 'estimate', updatedAt: 7 })
  })
  it('drops partial first/last lines including UTF-8 and never joins generations', () => {
    expect(parseRemoteMeter(source, page(line(100) + line(42) + line(999).trimEnd(), 5), 0)?.usedTokens).toBe(42)
    const torn = Buffer.concat([Buffer.from(line(42)), Buffer.from('{"model":"'), Buffer.from([0xe2, 0x82])])
    expect(parseRemoteMeter(source, { data: torn, start: 0 }, 0)?.usedTokens).toBe(42)
    expect(parseRemoteMeter(source, page(line(99).trimEnd()), 0)).toBeNull()
    expect(parseRemoteMeter(source, page(line(99), 5), 0)).toBeNull()
  })
  it('uses Codex last input count, ignores cumulative/cache totals and needs its own window', () => {
    const codex = { ...source, harness: 'codex' as const }
    const text = JSON.stringify({ payload: { info: { last_token_usage: { input_tokens: 45, cached_input_tokens: 40 },
      total_token_usage: { input_tokens: 9999 }, model_context_window: 1000 } } }) + '\n'
    expect(parseRemoteMeter(codex, page(text), 0)).toMatchObject({ usedTokens: 45, windowTokens: 1000, windowSource: 'transcript' })
    expect(parseRemoteMeter(codex, page(text.replace(',"model_context_window":1000', '')), 0)).toBeNull()
  })
  it('refuses oversized windows and invalid or oversized remote fields', () => {
    expect(parseRemoteMeter(source, { data: Buffer.alloc(REMOTE_METER_BYTES + 2), start: 0 }, 0)).toBeNull()
    expect(parseRemoteMeter(source, page(line(23, 'a'.repeat(300))), 0)?.model).toBeNull()
  })
})
