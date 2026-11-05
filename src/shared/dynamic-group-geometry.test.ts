import { describe, expect, it } from 'vitest'
import { planDynamicGroups } from './dynamic-groups'
import { planGeometryCommand, type GeometryControlVerb } from './geometry-command'
import { storedGeometryNodes, applyStoredGeometry } from './stored-canvas-geometry'
import type { CanvasNodeState } from './types'

const node = (id: string, x: number): CanvasNodeState => ({ id, kind: 'terminal', title: id, group: null, color: '#fff',
  position: { x, y: 0 }, size: { width: 640, height: 440 }, agentId: 'codex', agentSessionId: `session-${id}` })
function fixture() {
  const plan = planDynamicGroups([node('a', 0), node('b', 900)], { version: 1,
    groups: [{ id: 'g' }], members: [{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }],
    reserve: [{ id: 'slot', group: 'g', width: 800, height: 600 }], release: [], remove: [] })
  if (!plan.ok) throw new Error(plan.error)
  return plan.nodes
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

describe('existing shared geometry controls in managed groups', () => {
  it.each<GeometryControlVerb>(['resize', 'place', 'arrange', 'align', 'move'])('%s retains usable reserved space and session data', (verb) => {
    const original = fixture(), before = structuredClone(original)
    const frame = original.find((n) => n.id === 'g')!, slot = frame.dynamicGroup!.reservations[0]
    const args: Record<string, string> = verb === 'resize' ? { nodes: 'a', width: '1600', height: '1200' } :
      verb === 'place' ? { nodes: 'a', x: String(frame.position.x + slot.position.x), y: String(frame.position.y + slot.position.y) } :
      verb === 'arrange' ? { group: 'g', layout: 'column' } :
      verb === 'align' ? { nodes: 'a,b', edge: 'left' } : { nodes: 'b', group: 'top' }
    const result = planGeometryCommand(verb, args, storedGeometryNodes(original))
    expect(result.reply.ok, result.reply.error).toBe(true)
    const after = applyStoredGeometry(original, result.nodes)
    const group = after.find((n) => n.id === 'g')!
    const held = group.dynamicGroup!.reservations[0]
    expect(held).toMatchObject({ id: 'slot', state: 'reserved' })
    const rectangles = [...after.filter((n) => n.parentId === 'g').map((n) => ({ ...n.position, ...n.size })),
      { ...held.position, width: held.width, height: held.height }]
    for (let i = 0; i < rectangles.length; i++) {
      expect(rectangles[i].x + rectangles[i].width).toBeLessThanOrEqual(group.size.width - 28)
      expect(rectangles[i].y + rectangles[i].height).toBeLessThanOrEqual(group.size.height - 28)
      for (let j = i + 1; j < rectangles.length; j++) expect(overlaps(rectangles[i], rectangles[j])).toBe(false)
    }
    expect(group.size.width).toBeGreaterThanOrEqual(frame.size.width)
    expect(group.size.height).toBeGreaterThanOrEqual(frame.size.height)
    expect(after.find((n) => n.id === 'a')!.agentSessionId).toBe('session-a')
    expect(original).toEqual(before)
  })

  it('refuses ungroup without losing the group or reservation and refuses inheritance-changing moves', () => {
    const original = fixture(), before = structuredClone(original)
    expect(planGeometryCommand('ungroup', { group: 'g' }, storedGeometryNodes(original)))
      .toMatchObject({ changed: false, reply: { ok: false, error: expect.stringContaining('active reservations') } })
    original.find((n) => n.id === 'g')!.cwd = '/checkout'
    expect(planGeometryCommand('move', { nodes: 'a', group: 'top' }, storedGeometryNodes(original)))
      .toMatchObject({ changed: false, reply: { ok: false, error: expect.stringContaining('inheritance') } })
    expect(before.find((n) => n.id === 'g')!.dynamicGroup).toEqual(original.find((n) => n.id === 'g')!.dynamicGroup)
  })
})
