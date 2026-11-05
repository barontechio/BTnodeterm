import { describe, expect, it } from 'vitest'
import { createCanvasOrder, mutationKey } from './canvas-order'
import { applyCanvasLayout, canvasLayoutOf } from './canvas-batch'
import { applyCanvasOp, type CanvasContent } from './canvas-content'
import type { CanvasMutation, CanvasNodeState } from './types'

const n = (id: string, parentId?: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, text: 'local text',
  group: null, color: '#fff', position: { x: 28, y: 62 }, size: { width: 300, height: 200 }, ...(parentId ? { parentId } : {}) })
const up = (node: CanvasNodeState, seq: number, src = 'host', seen?: number): CanvasMutation => ({ op: 'upsert', node, seq, src, ...(seen !== undefined ? { seen } : {}) })

describe('host batch ordering decisions', () => {
  it('promotes a pending member before frame removal, keeping local content and applying one complete scene', () => {
    const order = createCanvasOrder('local')
    const local = { ...n('a', 'g'), title: 'pending title', agentSessionId: 'session', collapsed: true,
      premaxRect: { x: 1, y: 2, width: 400, height: 300 } }
    order.onLocal({ op: 'upsert', node: local }, 'P')
    let content: CanvasContent = { nodes: [{ ...n('g'), kind: 'group' }, local], bridges: [], ropes: [] }
    const host = { ...n('a'), title: 'saved title', text: 'saved text', position: { x: 500, y: 200 } }
    const mutations: CanvasMutation[] = [up(host, 1), { op: 'remove', id: 'g', seq: 2 }]
    const modes = mutations.map((m) => order.acceptBatch(m, 'P'))
    expect(modes).toEqual(['layout', 'full'])
    mutations.forEach((m, i) => {
      const actual = modes[i] === 'layout' && m.op === 'upsert' ? { ...m, node: applyCanvasLayout(local, canvasLayoutOf(m.node)) } : m
      if (modes[i] !== 'drop') content = applyCanvasOp(content, actual, 'P')
    })
    expect(content.nodes).toHaveLength(1)
    expect(content.nodes[0]).toMatchObject({ title: 'pending title', text: 'local text', agentSessionId: 'session', position: { x: 500, y: 200 } })
    expect(content.nodes[0].parentId).toBeUndefined()
    expect(content.nodes[0].collapsed).toBeUndefined()
    expect(content.nodes[0].premaxRect).toBeUndefined()
  })

  it('keeps ordinary peer suppression but accepts current host batch layout and rejects replay/stragglers', () => {
    const order = createCanvasOrder('local')
    order.onLocal({ op: 'upsert', node: n('a') }, 'P')
    expect(order.accept(up(n('a'), 1), 'P')).toBe(false)
    expect(order.acceptBatch(up(n('a', 'g'), 2), 'P')).toBe('layout')
    expect(order.acceptBatch(up(n('a'), 2), 'P')).toBe('drop')
    expect(order.acceptBatch(up(n('a'), 1), 'P')).toBe('drop')
    expect(order.acceptBatch(up(n('other'), 3), 'P')).toBe('full')
  })

  it('never revives an upsert that predates its node tombstone, but accepts deliberate recreation', () => {
    const order = createCanvasOrder('local')
    expect(order.acceptBatch({ op: 'remove', id: 'a', seq: 3 }, 'P')).toBe('full')
    expect(order.acceptBatch(up(n('a'), 4, 'host', 0), 'P')).toBe('drop')
    expect(order.acceptBatch(up(n('a'), 5, 'host', 3), 'P')).toBe('full')
  })

  it('returns full for a canonical final ACK after layout-only overwrite, without clearing unrelated pending keys', () => {
    const order = createCanvasOrder('local')
    order.onLocal({ op: 'upsert', node: n('a', 'old') }, 'P')
    order.onLocal({ op: 'upsert', node: n('unrelated') }, 'P')
    expect(order.acceptBatch(up(n('a', 'new'), 1), 'P')).toBe('layout')
    expect(order.accept(up({ ...n('a', 'new'), title: 'local title' }, 2, 'local', 0), 'P')).toBe(true)
    expect(order.accept(up(n('unrelated'), 3), 'P')).toBe(false)
  })

  it('does not replay the first ACK over newer still-pending local title/text after a layout rebase', () => {
    const order = createCanvasOrder('local')
    order.onLocal({ op: 'upsert', node: { ...n('a'), title: 'first' } }, 'P')
    order.onLocal({ op: 'upsert', node: { ...n('a'), title: 'latest' } }, 'P')
    expect(order.acceptBatch(up(n('a', 'new'), 1), 'P')).toBe('layout')
    expect(order.accept(up({ ...n('a', 'new'), title: 'first' }, 2, 'local', 0), 'P')).toBe(false)
    expect(order.accept(up({ ...n('a', 'new'), title: 'latest' }, 3, 'local', 0), 'P')).toBe(true)
  })

  it('keeps pending remove ACK bookkeeping and prevents stale resurrection after the echoed remove', () => {
    const order = createCanvasOrder('local')
    const remove: CanvasMutation = { op: 'remove', id: 'a', src: 'local', seq: 1 }
    order.onLocal(remove, 'P')
    expect(order.pendingRemoveCount()).toBe(1)
    expect(order.acceptBatch(remove, 'P')).toBe('drop')
    expect(order.pendingRemoveCount()).toBe(0)
    expect(order.hasPendingRemove(mutationKey(remove, 'P'))).toBe(false)
    expect(order.acceptBatch(up(n('a'), 2, 'host', 0), 'P')).toBe('drop')
  })

  it('reset clears layout repairs with the rest of the connection state and keeps the causal rebase rule', () => {
    const order = createCanvasOrder('local')
    order.onLocal({ op: 'upsert', node: n('a') }, 'P')
    expect(order.acceptBatch(up(n('a'), 100), 'P')).toBe('layout')
    order.reset()
    expect(order.acceptBatch(up(n('a'), 1), 'P')).toBe('full')
    expect(order.stamp({ op: 'upsert', node: n('b') }).seen).toBe(1)
  })
})
