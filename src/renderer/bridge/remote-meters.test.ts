import { afterEach, expect, it, vi } from 'vitest'
import { withRemoteMeters } from './remote-meters'
import { IPC } from '../../shared/ipc'
import type { RemoteMeterUpdate } from '../../shared/remote-meters'
import type { ContextWindowUsage } from '../../shared/types'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function fixture() {
  vi.useFakeTimers()
  const close = new Set<() => void>(), events = new Set<(u: RemoteMeterUpdate) => void>()
  const request = vi.fn(async (method: string, ..._args: unknown[]): Promise<unknown> =>
    method === IPC.contextRemoteStart ? { status: 'started', leaseId: 'lease', ttlMs: 15000 } : true)
  const client = { request, subscribe: (_channel: string, cb: (u: RemoteMeterUpdate) => void) => {
    events.add(cb); return () => { events.delete(cb) }
  }, onClose: (cb: () => void) => { close.add(cb); return () => { close.delete(cb) } } }
  const legacy = { ensure: vi.fn(), onUpdate: vi.fn(() => () => {}) }
  const api = withRemoteMeters(client, legacy), updates: ContextWindowUsage[] = []
  api.onUpdate(u => updates.push(u))
  const event = (status: RemoteMeterUpdate['status'] = 'ready', leaseId = 'lease') => {
    for (const cb of events) cb({ leaseId, nodeId: 'node', sessionId: 's', status, quota: 'unavailable',
      usage: status === 'ready' ? { nodeId: 'node', sessionId: 's', usedTokens: 5, windowTokens: 100,
        usedPercent: 5, model: null, updatedAt: Date.now() } : null })
  }
  return { api, request, close, events, legacy, updates, event }
}
afterEach(() => vi.useRealTimers())
it('coalesces mounts, uses normal onUpdate, releases last mount and removes close listeners', async () => {
  const f = fixture(), first = f.api.watchRemote!('node'), second = f.api.watchRemote!('node')
  await flush(); expect(f.request.mock.calls.filter(c => c[0] === IPC.contextRemoteStart)).toHaveLength(1)
  f.event('ready', 'other'); expect(f.updates).toEqual([])
  f.event(); expect(f.updates.at(-1)?.usedTokens).toBe(5)
  first(); expect(f.events.size).toBe(1); second()
  expect(f.events.size).toBe(0); expect(f.close.size).toBe(0); expect(f.updates.at(-1)?.cleared).toBe(true)
  expect(f.request).toHaveBeenLastCalledWith(IPC.contextRemoteRelease, 'lease')
  expect(vi.getTimerCount()).toBe(0)
})
it('releases a start response that arrives after disposal', async () => {
  const f = fixture(); let finish!: (r: unknown) => void
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.api.watchRemote!('node')(); finish({ status: 'started', leaseId: 'late' }); await flush()
  expect(f.request).toHaveBeenLastCalledWith(IPC.contextRemoteRelease, 'late'); expect(vi.getTimerCount()).toBe(0)
})
it('has at most one pending renewal even when responses are slow', async () => {
  const f = fixture(); let finish!: (r: unknown) => void
  f.request.mockImplementation(async method => method === IPC.contextRemoteStart ? { status: 'started', leaseId: 'lease' } :
    new Promise(resolve => { finish = resolve }))
  const stop = f.api.watchRemote!('node'); await flush(); await vi.advanceTimersByTimeAsync(60_000)
  expect(f.request.mock.calls.filter(c => c[0] === IPC.contextRemoteRenew)).toHaveLength(1)
  finish(false); await flush(); stop(); expect(vi.getTimerCount()).toBe(0)
})
it('clears on departure and cannot revive a lease on the closed connection', async () => {
  const f = fixture(), stop = f.api.watchRemote!('node'); await flush(); f.event()
  for (const cb of f.close) cb()
  const count = f.request.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000)
  expect(f.request).toHaveBeenCalledTimes(count); expect(f.updates.at(-1)?.cleared).toBe(true); stop()
})
it.each(['local', 'legacy'])('degrades %s without changing legacy local behavior', async status => {
  const f = fixture()
  if (status === 'legacy') f.request.mockRejectedValue(Object.assign(Error('no handler'), { code: 'E_NO_HANDLER' }))
  else f.request.mockResolvedValue({ status })
  const stop = f.api.watchRemote!('node'); await flush()
  expect(f.updates).toEqual([]); expect(f.close.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  f.api.ensure('local'); expect(f.legacy.ensure).toHaveBeenCalledWith('local'); stop()
})
it('invalidated observations clear and obtain fresh authorization on the next cycle', async () => {
  const f = fixture(), stop = f.api.watchRemote!('node'); await flush(); f.event(); f.event('invalidated')
  expect(f.updates.at(-1)?.cleared).toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(f.request.mock.calls.filter(c => c[0] === IPC.contextRemoteStart)).toHaveLength(2)
  stop(); expect(vi.getTimerCount()).toBe(0)
})

it.each(['unavailable', 'capacity'])('retries %s with fresh authorization while still mounted', async status => {
  const f = fixture(); f.request.mockResolvedValueOnce({ status })
  const stop = f.api.watchRemote!('node'); await flush()
  expect(f.request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.request.mock.calls.filter(c => c[0] === IPC.contextRemoteStart)).toHaveLength(2)
  f.event(); expect(f.updates.at(-1)?.usedTokens).toBe(5)
  stop(); expect(vi.getTimerCount()).toBe(0)
})
