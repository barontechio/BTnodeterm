import { describe, expect, it } from 'vitest'
import { buildCanvasApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function client() {
  const casts: unknown[][] = []
  const listeners = new Set<(...args: unknown[]) => void>()
  return {
    casts, listeners,
    cast: (...args: unknown[]) => { casts.push(args) },
    subscribe: (channel: string, fn: (...args: unknown[]) => void) => {
      expect(channel).toBe(IPC.canvasMutationBatch)
      listeners.add(fn); return () => { listeners.delete(fn) }
    }
  }
}
describe('WS atomic canvas subscription negotiation', () => {
  it('registers the batch sink before advertising and withdraws only after the last subscription ends', () => {
    const c = client(); const api = buildCanvasApi(c as never).canvas
    const events: unknown[][] = []
    const off = api.onMutationBatch!((...args) => events.push(args))
    const off2 = api.onMutationBatch!(() => {})
    expect(c.casts).toEqual([[IPC.canvasBatchSubscribe, true]])
    const batch = { mutations: [{ op: 'remove', id: 'a', seq: 1 }, { op: 'remove', id: 'b', seq: 2 }] }
    c.listeners.forEach((fn) => fn('P', batch))
    expect(events).toEqual([['P', batch]])
    off(); off(); expect(c.casts).toHaveLength(1)
    off2(); off2(); expect(c.casts).toEqual([[IPC.canvasBatchSubscribe, true], [IPC.canvasBatchSubscribe, false]])
    expect(c.listeners.size).toBe(0)
  })

  it('a replacement connection must mount its own real batch listener before advertising support', () => {
    const first = client(); const second = client()
    buildCanvasApi(first as never).canvas.onMutationBatch!(() => {})
    const api = buildCanvasApi(second as never).canvas
    expect(second.casts).toEqual([])
    api.onMutationBatch!(() => {})
    expect(second.casts).toEqual([[IPC.canvasBatchSubscribe, true]])
  })
})
