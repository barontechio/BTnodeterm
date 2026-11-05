import { afterAll, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { CanvasMutationBatch, NodeTerminalApi } from '../shared/types'

const h = vi.hoisted(() => {
  const signals: unknown[][] = []
  const events = new Map<string, () => void>()
  const windowStub = { addEventListener: (channel: string, fn: () => void) => events.set(channel, fn) }
  vi.stubGlobal('window', windowStub)
  return { signals, events, send: vi.fn((...args: unknown[]) => signals.push(args)), on: vi.fn(), off: vi.fn(), exposed: {} as Record<string, unknown> }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { h.exposed[key] = value } },
  ipcRenderer: { send: h.send, on: h.on, removeListener: h.off, invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))
import './index'
afterAll(() => vi.unstubAllGlobals())

describe('native atomic canvas subscription negotiation', () => {
  it('resets a reused webContents identity, forwards one batch without its Electron event, and withdraws support on unload', () => {
    expect(Object.keys(h.exposed)).toContain('nodeTerminal')
    expect(h.signals).toContainEqual([IPC.canvasBatchSubscribe, false])
    const canvas = (h.exposed.nodeTerminal as NodeTerminalApi).canvas
    const receive = vi.fn()
    const off = canvas.onMutationBatch!(receive)
    const off2 = canvas.onMutationBatch!(receive)
    expect(h.send.mock.calls.filter((call) => call[0] === IPC.canvasBatchSubscribe && call[1] === true)).toHaveLength(1)
    const handler = h.on.mock.calls.find((call) => call[0] === IPC.canvasMutationBatch)![1]
    const batch: CanvasMutationBatch = { mutations: [{ op: 'remove', id: 'a', seq: 1 }, { op: 'remove', id: 'b', seq: 2 }] }
    handler({ native: true }, 'P', batch)
    expect(receive.mock.calls).toEqual([['P', batch], ['P', batch]])
    off(); off(); receive.mockClear()
    handler({}, 'P', batch)
    expect(receive).toHaveBeenCalledExactlyOnceWith('P', batch)
    off2(); off2()
    expect(h.off).toHaveBeenCalledWith(IPC.canvasMutationBatch, handler)
    expect(h.send.mock.calls.at(-1)).toEqual([IPC.canvasBatchSubscribe, false])
    const off3 = canvas.onMutationBatch!(receive)
    h.events.get('pagehide')!()
    expect(h.send.mock.calls.at(-1)).toEqual([IPC.canvasBatchSubscribe, false])
    h.events.get('pageshow')!()
    expect(h.send.mock.calls.at(-1)).toEqual([IPC.canvasBatchSubscribe, true])
    expect(h.events.has('beforeunload')).toBe(false) // a cancelled close must not withdraw support
    off3()
  })
})
