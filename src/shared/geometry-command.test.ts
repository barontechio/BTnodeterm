import { describe, expect, it } from 'vitest'
import { planGeometryCommand } from './geometry-command'
import type { GeometryNode } from './canvas-geometry'
import { rootPositionWith } from './root-position'

const node = (id: string, x = 0, y = 0, parentId?: string): GeometryNode => ({
  id, type: 'terminal', position: { x, y }, width: 640, height: 440, parentId, data: {}
})
const group = (id: string, parentId?: string): GeometryNode => ({ ...node(id, 100, 100, parentId), type: 'group', width: 3000, height: 3000 })
const root = (nodes: GeometryNode[], id: string) => rootPositionWith(nodes.find((n) => n.id === id)!, (key) => nodes.find((n) => n.id === key))

describe('the shared Desktop and Server geometry command planner', () => {
  it.each(['row', 'grid', 'column'])('honors --gap 17 in the %s nodes layout', (layout) => {
    const live = [node('a', 10, 20), node('b', 999, 888)]
    const before = structuredClone(live)
    const out = planGeometryCommand('arrange', { nodes: 'a,b', layout, cols: '1', gap: '17' }, live)
    expect(out.reply.ok).toBe(true)
    expect(out.changed).toBe(true)
    const [a, b] = out.nodes
    expect(layout === 'row' ? b.position.x - a.position.x : b.position.y - a.position.y).toBe(layout === 'row' ? 657 : 457)
    expect(live).toEqual(before)
  })

  it('arranges a nested group and refits its ancestors on the root grid', () => {
    const live = [group('outer'), group('inner', 'outer'), node('a', 123, 92, 'inner'), node('b', 1200, 1800, 'inner')]
    const out = planGeometryCommand('arrange', { group: 'inner', layout: 'row', gap: '13' }, live, { grid: 20 })
    expect(out.reply).toMatchObject({ ok: true, result: { group: 'inner', changed: true } })
    const a = out.nodes.find((n) => n.id === 'a')!
    const b = out.nodes.find((n) => n.id === 'b')!
    expect(b.position.x - a.position.x).toBe(653)
    for (const id of ['outer', 'inner']) {
      const at = root(out.nodes, id)
      expect(at.x % 20).toBe(0)
      expect(at.y % 20).toBe(0)
    }
  })

  it.each(['tidy', 'lineage'])('carries gap to the top-level %s layout', (layout) => {
    const live = [node('a', 15, 17), node('b', 1400, 1700)]
    live[1].data.openedBy = 'a'
    const options = { edges: [{ id: 'ctrl-a-b', source: 'a', target: 'b' }] }
    const tight = planGeometryCommand('arrange', { group: 'top', layout, gap: '0' }, live, options)
    const wide = planGeometryCommand('arrange', { group: 'top', layout, gap: '300' }, live, options)
    expect(tight.reply.ok).toBe(true)
    expect(wide.reply.ok).toBe(true)
    expect(wide.nodes.map((n) => n.position)).not.toEqual(tight.nodes.map((n) => n.position))
  })

  it('uses opener and wait distinctions for a group lineage layout', () => {
    const live = [group('g'), node('a', 2000, 2000, 'g'), node('b', 10, 10, 'g')]
    const out = planGeometryCommand('arrange', { group: 'g', layout: 'lineage' }, live, {
      edges: [{ id: 'ctrl-a-b', source: 'a', target: 'b' }]
    })
    expect(out.reply.ok).toBe(true)
    expect(out.nodes.find((n) => n.id === 'b')!.position.y).toBeGreaterThan(out.nodes.find((n) => n.id === 'a')!.position.y)
  })

  it('preserves root positions when moving into and dissolving a group', () => {
    const live = [group('g'), node('a', 1000, 1200)]
    const moved = planGeometryCommand('move', { nodes: 'a', group: 'g' }, live)
    expect(moved.reply.ok).toBe(true)
    expect(root(moved.nodes, 'a')).toEqual(root(live, 'a'))
    const freed = planGeometryCommand('ungroup', { group: 'g' }, moved.nodes)
    expect(freed.reply.ok).toBe(true)
    expect(root(freed.nodes, 'a')).toEqual(root(live, 'a'))
    expect(freed.nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('refuses mixed containers and malformed flags atomically', () => {
    const live = [group('g'), node('a'), node('b', 0, 0, 'g')]
    const mixed = planGeometryCommand('arrange', { nodes: 'a,b' }, live)
    expect(mixed).toMatchObject({ changed: false, reply: { ok: false, error: expect.stringContaining('different containers') } })
    const malformed = planGeometryCommand('arrange', { group: 'g', nodes: 'a,b' }, live)
    expect(malformed.reply.ok).toBe(false)
    expect(malformed.nodes).toBe(live)
    expect(planGeometryCommand('arrange', { nodes: 'a', gap: 'NaN' }, live).reply.ok).toBe(false)
  })

  it('returns applied clamping and unknown ids, and identifies no-op geometry', () => {
    const live = [node('a')]
    const out = planGeometryCommand('resize', { nodes: 'a,missing', width: '1' }, live)
    expect(out.reply).toMatchObject({ ok: true, result: { unknown: ['missing'], resized: [expect.objectContaining({ id: 'a', clamped: true })] } })
    expect(out.nodes[0].width).toBeGreaterThan(1)
    expect(planGeometryCommand('resize', { nodes: 'a', width: '640' }, live).changed).toBe(false)
    expect(planGeometryCommand('place', { nodes: 'a', dx: '0', dy: '0' }, live).changed).toBe(false)
  })
})
