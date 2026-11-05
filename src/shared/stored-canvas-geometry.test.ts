import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from './types'
import { applyStoredGeometry, storedGeometryNodes, wrapStoredNodes } from './stored-canvas-geometry'
import { COLLAPSED_HEIGHT } from './node-sizing'
import { GROUP_PAD, GROUP_HEADER } from './canvas-geometry'

const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, color: '#0a84ff', group: null,
  position: { x: 100, y: 200 }, size: { width: 640, height: 440 } })

describe('group wrapping over persisted geometry', () => {
  it('wraps the collapsed footprint and preserves expanded size and execution metadata', () => {
    const member = { ...node('a'), collapsed: true, accountId: 'managed', pendingLaunch: { after: [], command: 'task' } }
    const frame = { ...node('g'), kind: 'group' as const, title: 'A team' }
    const next = wrapStoredNodes([member], ['a'], frame)!
    expect(next[0]).toMatchObject({ id: 'g', title: 'A team', size: {
      width: 640 + GROUP_PAD * 2, height: COLLAPSED_HEIGHT + GROUP_PAD * 2 + GROUP_HEADER
    } })
    expect(next[1]).toEqual({ ...member, parentId: 'g', position: { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER } })
    expect(member.position).toEqual({ x: 100, y: 200 })
  })

  it('refuses mixed containers and duplicate frame identities before changing nodes', () => {
    const frame = { ...node('g'), kind: 'group' as const }
    const live = [frame, node('a'), { ...node('b'), parentId: 'g' }]
    expect(wrapStoredNodes(live, ['a', 'b'], { ...frame, id: 'new' })).toBeNull()
    expect(() => wrapStoredNodes(live, ['a'], frame)).toThrow('geometry-invalid-frame')
    expect(live[1].parentId).toBeUndefined()
  })

  describe('a parentId naming no frame on this canvas', () => {
    const frame = { ...node('new-frame'), kind: 'group' as const }

    it('reads as top level instead of refusing the whole project', () => {
      const live = storedGeometryNodes([{ ...node('a'), parentId: 'gone' }, { ...node('f'), kind: 'group' as const, parentId: 'gone' }])
      expect(live.map((n) => n.parentId)).toEqual([undefined, undefined])
    })

    it('stays as found on a write that does not give the node a parent', () => {
      const damaged = { ...node('a'), parentId: 'gone' }
      const nested = [{ ...node('p'), kind: 'group' as const }, { ...node('c'), parentId: 'p' }]
      const original = [damaged, ...nested]

      const unchanged = applyStoredGeometry(original, storedGeometryNodes(original))
      expect(unchanged).toEqual(original)

      // Leaving a real frame still clears the id.
      const moved = storedGeometryNodes(original).map((n) => (n.id === 'c' ? { ...n, parentId: undefined } : n))
      expect(applyStoredGeometry(original, moved).find((n) => n.id === 'c')?.parentId).toBeUndefined()
    })

    it('gives a new frame no parent, and its member the new frame', () => {
      const next = wrapStoredNodes([{ ...node('a'), parentId: 'gone' }], ['a'], frame)!

      expect(next[0].id).toBe('new-frame')
      expect(next[0].parentId).toBeUndefined()
      expect(next[1]).toMatchObject({ id: 'a', parentId: 'new-frame' })
    })

    it('counts as the same container as a top-level node, and still refuses a real mix', () => {
      const parent = { ...node('p'), kind: 'group' as const }
      expect(wrapStoredNodes([{ ...node('a'), parentId: 'gone' }, node('b')], ['a', 'b'], frame)).not.toBeNull()
      expect(wrapStoredNodes([parent, { ...node('a'), parentId: 'p' }, { ...node('b'), parentId: 'gone' }], ['a', 'b'], frame)).toBeNull()
    })

    // The raw parent walks that authorize affected nodes rely on this: they have no cycle guard of
    // their own, and a cycle reaching them would hang the whole server.
    it.each([
      ['two frames', [{ ...node('x'), kind: 'group' as const, parentId: 'y' }, { ...node('y'), kind: 'group' as const, parentId: 'x' }]],
      ['a frame and itself', [{ ...node('x'), kind: 'group' as const, parentId: 'x' }]],
      ['a terminal and itself', [{ ...node('x'), parentId: 'x' }]],
      ['two terminals', [{ ...node('x'), parentId: 'y' }, { ...node('y'), parentId: 'x' }]],
      ['a frame and a terminal', [{ ...node('x'), kind: 'group' as const, parentId: 'y' }, { ...node('y'), parentId: 'x' }]]
    ])('still refuses a parent cycle through %s', (_name, cycle) => {
      expect(() => storedGeometryNodes(cycle)).toThrow('geometry-invalid-scene')
    })

    it('still refuses a parent that exists and is not a frame: the canvas offsets its child by it', () => {
      expect(() => storedGeometryNodes([node('t'), { ...node('c'), parentId: 't' }])).toThrow('geometry-invalid-scene')
    })
  })
})
