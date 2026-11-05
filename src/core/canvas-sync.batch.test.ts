import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { createCanvasAuthority } from './canvas-authority'
import {
  initCanvasSync, canPublishCanvasBatch, publishCanvasMutationBatch, publishCanvasMutation,
  setReflectedListener, setReflectedBatchListener, setCanvasMutationObserver,
  setCanvasMutationBatchObserver, CANVAS_BATCH_MAX_BYTES, CANVAS_BATCH_MAX_MUTATIONS
} from './canvas-sync'
import { applyCanvasOp, type CanvasContent } from '../shared/canvas-content'
import { IPC } from '../shared/ipc'
import type { CanvasMutationBatch, CanvasNodeState, Workspace } from '../shared/types'

const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#fff', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, ...extra
})
const batch = (): CanvasMutationBatch => ({ mutations: [
  { op: 'upsert', node: node('frame', { kind: 'group' }) },
  { op: 'upsert', node: node('member', { parentId: 'frame' }) }
] })
let p: FakePlatform
const subscribe = (id: number, on = true) => p.senderListeners[IPC.canvasBatchSubscribe](id, on)
beforeEach(() => { p = fakePlatform({ isOwnerClient: (id) => id === 1 }); initPlatform(p); initCanvasSync() })
afterEach(() => {
  setReflectedListener(null); setReflectedBatchListener(null)
  setCanvasMutationObserver(null); setCanvasMutationBatchObserver(null); resetPlatformForTests()
})

describe('atomic host canvas batches', () => {
  it('delivers only one before/final scene per recipient, with contiguous child stamps in the existing order', () => {
    p.clients.push(1, 2); subscribe(1); subscribe(2)
    expect(publishCanvasMutationBatch('P', batch())).toBe(true)
    expect(p.sent).toHaveLength(2)
    expect(p.sent.every((event) => event.channel === IPC.canvasMutationBatch)).toBe(true)
    let content: CanvasContent = { nodes: [], bridges: [], ropes: [] }
    const scenes = [content]
    const received = p.sent[0].args[1] as CanvasMutationBatch
    for (const m of received.mutations) content = applyCanvasOp(content, m, 'P')
    scenes.push(content)
    expect(scenes.map((scene) => scene.nodes.map((n) => n.id))).toEqual([[], ['frame', 'member']])
    expect(received.mutations.map((m) => m.seq)).toEqual([1, 2])
    publishCanvasMutation('P', { op: 'remove', id: 'member' })
    expect(p.sent.at(-1)!.args[1].seq).toBe(3)
  })

  it('refuses every malformed/oversized child or envelope before authority, observers, sequence or wire effects', () => {
    const reflected = vi.fn(); const observed = vi.fn()
    setReflectedBatchListener(reflected); setCanvasMutationObserver(observed)
    const invalid: unknown[] = [
      { mutations: [...batch().mutations, { op: 'upsert', node: { id: 'bad' } }] },
      { mutations: [batch()] }, { mutations: [] },
      { mutations: Array(CANVAS_BATCH_MAX_MUTATIONS + 1).fill({ op: 'remove', id: 'n' }) },
      { mutations: [{ op: 'upsert', node: node('big', { text: 'x'.repeat(CANVAS_BATCH_MAX_BYTES) }) }] },
      { mutations: ['a', 'b'].map((id) => ({ op: 'upsert', node: node(id, { text: 'x'.repeat(CANVAS_BATCH_MAX_BYTES / 2) }) })) },
      { ...batch(), unexpected: true }
    ]
    for (const value of invalid) expect(publishCanvasMutationBatch('P', value as CanvasMutationBatch)).toBe(false)
    expect(reflected).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled(); expect(p.sent).toEqual([])
    p.clients.push(1); publishCanvasMutation('P', { op: 'remove', id: 'n' })
    expect(p.sent[0].args[1].seq).toBe(1)
  })

  it('includes stamp/provenance overhead in the bound before claiming sequence or publishing', () => {
    const value = { mutations: [{ op: 'upsert' as const, node: node('big', { text: '' }) }] }
    const spare = CANVAS_BATCH_MAX_BYTES - JSON.stringify(value).length
    value.mutations[0].node.text = 'x'.repeat(spare)
    expect(JSON.stringify(value).length).toBe(CANVAS_BATCH_MAX_BYTES)
    expect(canPublishCanvasBatch('P', value)).toEqual({ ok: false, error: 'canvas-batch-invalid' })
    expect(publishCanvasMutationBatch('P', value)).toBe(false)
  })

  it('refuses incompatible clients and tracks unsubscribe, actual departure and reconnect', () => {
    p.clients.push(1, 2); subscribe(1)
    expect(canPublishCanvasBatch('P', batch())).toEqual({ ok: false, error: 'canvas-batch-client-incompatible' })
    expect(publishCanvasMutationBatch('P', batch())).toBe(false); expect(p.sent).toEqual([])
    subscribe(2); expect(canPublishCanvasBatch('P', batch()).ok).toBe(true)
    subscribe(2, false); expect(canPublishCanvasBatch('P', batch()).ok).toBe(false)
    subscribe(2); p.clients.splice(1, 1)
    expect(canPublishCanvasBatch('P', batch()).ok).toBe(true)
    p.clients.push(3) // reconnect has a new platform identity, not the departed subscriber's grant
    expect(canPublishCanvasBatch('P', batch()).ok).toBe(false)
    subscribe(3); expect(canPublishCanvasBatch('P', batch()).ok).toBe(true)
    p.clients.length = 0; expect(publishCanvasMutationBatch('P', batch())).toBe(true)
  })

  it('does not accept client batches or subscription claims from absent peers', () => {
    subscribe(1); p.clients.push(1)
    expect(canPublishCanvasBatch('P', batch()).ok).toBe(false)
    expect(p.senderListeners[IPC.canvasMutationBatch]).toBeUndefined()
    expect(p.handlers[IPC.canvasMutationBatch]).toBeUndefined()
  })

  it('refuses observer reentrant Core publications before any sequence/authority/wire effect', () => {
    p.clients.push(1); subscribe(1)
    const attempts: unknown[] = []
    const observed: number[] = []
    setCanvasMutationObserver((_id, mutation) => {
      observed.push(mutation.seq!)
      attempts.push(publishCanvasMutation('P', { op: 'remove', id: 'nested' }))
      attempts.push(canPublishCanvasBatch('P', batch()))
      attempts.push(publishCanvasMutationBatch('P', batch()))
    })
    setCanvasMutationBatchObserver(() => { attempts.push(publishCanvasMutation('P', { op: 'remove', id: 'also-nested' })) })
    expect(publishCanvasMutationBatch('P', batch())).toBe(true)
    expect(observed).toEqual([1, 2])
    expect(attempts).toEqual([false, { ok: false, error: 'canvas-batch-reentrant-publication' }, false,
      false, { ok: false, error: 'canvas-batch-reentrant-publication' }, false, false])
    expect(p.sent).toHaveLength(1)
    setCanvasMutationObserver(null); setCanvasMutationBatchObserver(null)
    expect(publishCanvasMutation('P', { op: 'remove', id: 'after' })).toBe(true)
    expect(p.sent.at(-1)!.args[1].seq).toBe(3)
  })

  it('also refuses a batch nested inside single-op authority/observation, preserving the existing order', () => {
    p.clients.push(1); subscribe(1)
    const attempts: boolean[] = []
    setReflectedListener(() => { attempts.push(publishCanvasMutationBatch('P', batch())) })
    setReflectedBatchListener(() => {})
    expect(publishCanvasMutation('P', { op: 'remove', id: 'outer' })).toBe(true)
    expect(attempts).toEqual([false])
    expect(p.sent).toHaveLength(1); expect(p.sent[0].channel).toBe(IPC.canvasMut)
    expect(p.sent[0].args[1].seq).toBe(1)
  })

  it('refuses a single publication from the aggregate batch observer before wire delivery', () => {
    p.clients.push(1); subscribe(1)
    let nested: boolean | undefined
    setCanvasMutationBatchObserver(() => { nested = publishCanvasMutation('P', { op: 'remove', id: 'nested' }) })
    expect(publishCanvasMutationBatch('P', batch())).toBe(true)
    expect(nested).toBe(false)
    expect(p.sent.map((event) => event.channel)).toEqual([IPC.canvasMutationBatch])
  })

  it('defers reentrant client ingress until every batch child was observed and every recipient got the batch', async () => {
    p.clients.push(1, 2); subscribe(1); subscribe(2)
    const observed: number[] = []
    const incoming = { op: 'upsert' as const, node: node('concurrent') }
    setCanvasMutationObserver((_id, mutation) => {
      observed.push(mutation.seq!)
      if (mutation.seq === 1) p.senderListeners[IPC.canvasMut](1, 'P', incoming)
    })
    expect(publishCanvasMutationBatch('P', batch())).toBe(true)
    incoming.node.title = 'changed after enqueue'
    expect(observed).toEqual([1, 2])
    expect(p.sent.map((event) => event.channel)).toEqual([IPC.canvasMutationBatch, IPC.canvasMutationBatch])
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(observed).toEqual([1, 2, 3])
    for (const id of [1, 2]) {
      const messages = p.sent.filter((event) => event.to === id)
      expect(messages.map((event) => event.channel)).toEqual([IPC.canvasMutationBatch, IPC.canvasMut])
      expect(messages[1].args[1]).toMatchObject({ seq: 3, node: { title: 'concurrent' } })
    }
  })

  it('drops deferred client ingress after departure and releases the fence even when authority throws', async () => {
    p.clients.push(1); subscribe(1)
    setCanvasMutationObserver((_id, mutation) => {
      if (mutation.seq === 1) {
        p.senderListeners[IPC.canvasMut](1, 'P', { op: 'remove', id: 'late' })
        p.clients.length = 0
      }
    })
    publishCanvasMutationBatch('P', batch())
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(p.sent.filter((event) => event.channel === IPC.canvasMut)).toHaveLength(0)
    setCanvasMutationObserver(null)
    setReflectedBatchListener(() => { throw new Error('authority failed') })
    expect(() => publishCanvasMutationBatch('P', batch())).toThrow('authority failed')
    setReflectedBatchListener(null)
    expect(canPublishCanvasBatch('P', batch()).ok).toBe(true)
    expect(publishCanvasMutationBatch('P', batch())).toBe(true)
  })

  it('keeps owner held launches only owner-to-owner, never shell/extraArgs, and strips all authority children', () => {
    p.clients.push(1, 2); subscribe(1); subscribe(2)
    const value: CanvasMutationBatch = { mutations: [{ op: 'upsert', origin: 'core', seq: 999, node: node('agent', {
      shell: 'evil', ssh: { host: 'host', extraArgs: '-o ProxyCommand=evil' } as CanvasNodeState['ssh'],
      pendingLaunch: { after: [], command: 'private-command' }
    }) }] }
    const reflected = vi.fn(); setReflectedBatchListener(reflected)
    expect(publishCanvasMutationBatch('P', value)).toBe(true)
    expect(p.sent[0].args[1]).toMatchObject({ mutations: [{ seq: 1, origin: 'core', node: { pendingLaunch: { command: 'private-command' } } }] })
    for (const event of p.sent) {
      const up = (event.args[1] as CanvasMutationBatch).mutations[0]
      if (up.op !== 'upsert') throw new Error('expected upsert')
      expect(up.node.shell).toBeUndefined(); expect(up.node.ssh?.extraArgs).toBeUndefined()
    }
    expect(JSON.stringify(p.sent[1])).not.toContain('private-command')
    expect(JSON.stringify(reflected.mock.calls)).not.toContain('private-command')
    p.sent.length = 0
    expect(publishCanvasMutationBatch('P', value, { trusted: false })).toBe(true)
    expect(JSON.stringify(p.sent)).not.toContain('private-command')
  })

  it('updates authority as one fold before child observations, retains metadata and overlays local execution', async () => {
    const ws: Workspace = { version: 2, activeProjectId: 'P', projects: [{
      id: 'P', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: []
    }] }
    const writes: CanvasContent[] = []
    const authority = createCanvasAuthority({ sharedProjectIds: () => new Set(['P']),
      readContent: async () => ({ nodes: [], ropes: [], bridges: [] }),
      writeContent: async (_id, c) => { writes.push(c); return true },
      publish: () => {}, setTimer: () => null, clearTimer: () => {} })
    await authority.overlayLoad(ws)
    setReflectedListener(authority.onReflected)
    expect(canPublishCanvasBatch('P', batch())).toEqual({ ok: false, error: 'canvas-batch-authority-incompatible' })
    setReflectedBatchListener(authority.onReflectedBatch)
    const checks: Promise<void>[] = []
    setCanvasMutationObserver(() => { checks.push(authority.flushAll()) })
    const observed = vi.fn(); setCanvasMutationBatchObserver(observed)
    const value = batch()
    if (value.mutations[0].op !== 'upsert') throw new Error('expected frame')
    value.mutations[0].node.dynamicGroup = { version: 1, reservations: [] }
    if (value.mutations[1].op !== 'upsert') throw new Error('expected member')
    value.mutations[1].node.cwd = '/kept'
    expect(publishCanvasMutationBatch('P', value)).toBe(true)
    await Promise.all(checks); await authority.flushAll()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every((c) => c.nodes.map((n) => n.id).join(',') === 'frame,member')).toBe(true)
    expect(observed).toHaveBeenCalledTimes(1)
    const saved = await authority.overlaySave({ ...ws, projects: [{ ...ws.projects[0], nodes: [node('member', {
      cwd: '/kept', pendingLaunch: { after: [], command: 'private-command' }
    })] }] })
    expect(saved.projects[0].nodes.find((n) => n.id === 'member')).toMatchObject({ cwd: '/kept', pendingLaunch: { command: 'private-command' } })
    expect(saved.projects[0].nodes.find((n) => n.id === 'frame')?.dynamicGroup).toEqual({ version: 1, reservations: [] })
    await authority.stop()
  })
})
