import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from './types'
import { wrapStoredNodes } from './stored-canvas-geometry'
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
})
