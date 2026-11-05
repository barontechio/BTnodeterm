import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  appendGroupedFlowNodes, ungroupNodes, flowToNodeStates, nodeStatesToFlow, reconcileDynamicFlowNodes,
  type CanvasNode, type DynamicFlowResult
} from '../state/workspace'
import { planDynamicGroups } from '@shared/dynamic-groups'
import { GroupReservations } from './groupReservations'

const n = (id: string, x = 0, y = 0, width = 300, height = 200, parentId?: string): CanvasNode => ({
  id, type: 'terminal', position: { x, y }, width, height, style: { width, height },
  ...(parentId ? { parentId, extent: 'parent' as const } : {}), data: { title: id, color: '#fff', group: null }
})
const g = (id: string, x = 0, y = 0, width = 1000, height = 800, parentId?: string): CanvasNode => ({
  ...n(id, x, y, width, height, parentId), type: 'group', data: { title: id, color: '#fff', group: null, dynamicGroup: { version: 1, reservations: [] } }
})
const ok = (r: DynamicFlowResult): CanvasNode[] => { if (!r.ok) throw new Error(r.error); return r.nodes }
const get = (nodes: CanvasNode[], id: string) => nodes.find((n) => n.id === id)!
function noOverlap(nodes: CanvasNode[]): void {
  const states = flowToNodeStates(nodes)
  for (const node of states) {
    const height = node.collapsed ? 40 : node.size.height
    if (node.parentId) {
      const parent = states.find((p) => p.id === node.parentId)!
      expect(node.position.x).toBeGreaterThanOrEqual(28)
      expect(node.position.y).toBeGreaterThanOrEqual(62)
      expect(node.position.x + node.size.width + 28).toBeLessThanOrEqual(parent.size.width)
      expect(node.position.y + height + 28).toBeLessThanOrEqual(parent.size.height)
    }
    for (const other of states.filter((p) => p.id !== node.id && p.parentId === node.parentId)) {
      expect(node.position.x >= other.position.x + other.size.width || other.position.x >= node.position.x + node.size.width ||
        node.position.y >= other.position.y + (other.collapsed ? 40 : other.size.height) || other.position.y >= node.position.y + height).toBe(true)
    }
  }
}

describe('live dynamic group integration', () => {
  it('appends after removals around actual heterogeneous children and reserved space', () => {
    const frame = g('g', 100, 200, 1500, 1200)
    frame.data.dynamicGroup!.reservations.push({ id: 'slot', position: { x: 28, y: 62 }, width: 400, height: 300, state: 'reserved' })
    const child = n('existing', 28, 362, 500, 200, 'g')
    child.measured = { width: 900, height: 250 }
    const input = [frame, child]
    const before = structuredClone(input)
    const added = [n('new-a'), n('new-b', 0, 0, 600, 400)]
    const nodes = ok(appendGroupedFlowNodes(input, added, 'g'))
    expect(input).toEqual(before)
    expect(get(nodes, 'existing')).toBe(child)
    noOverlap(nodes)
    const slotNode = n('slot-rect', 28, 62, 400, 300, 'g')
    noOverlap([...nodes, slotNode])
    expect(get(nodes, 'new-a').position).not.toEqual(get(nodes, 'new-b').position)
    expect(get(nodes, 'g').width).toBeGreaterThanOrEqual(1500)
  })
  it('preserves runtime objects, initial launch intent, selection and untouched identity', () => {
    const input = [g('g'), n('unrelated', 2000, 2000)]
    const fresh = n('new')
    const intent = { type: 'sentinel' }
    fresh.data = { ...fresh.data, initialCommand: 'codex --resume session', launchIntent: intent as never,
      agentSessionId: 'session', cwd: '/work', respawnNonce: 7 }
    fresh.selected = true
    const nodes = ok(appendGroupedFlowNodes(input, [fresh], 'g'))
    const added = get(nodes, 'new')
    expect(added.data).toBe(fresh.data)
    expect(added.data.launchIntent).toBe(intent)
    expect(added.selected).toBe(true)
    expect(get(nodes, 'unrelated')).toBe(input[1])
    expect(get(nodes, 'g')).toBe(input[0])
  })
  it('rebases an append on concurrent UI edits and a frame created in the same tick', () => {
    const frame = g('new-frame')
    const captured = [frame, n('local', 2000, 2000)]
    const latest = [{ ...captured[1], data: { ...captured[1].data, title: 'concurrent local title' } }]
    const result = ok(appendGroupedFlowNodes(latest, [n('new')], frame.id, 0, captured))
    expect(get(result, 'local')).toBe(latest[0])
    expect(get(result, 'local').data.title).toBe('concurrent local title')
    expect(get(result, 'new').parentId).toBe(frame.id)
    noOverlap(result)
  })
  it('rejects an invalid group append without inserting a partial batch', () => {
    const input = [g('g')]
    const before = structuredClone(input)
    expect(appendGroupedFlowNodes(input, [n('a'), n('a')], 'g').ok).toBe(false)
    expect(appendGroupedFlowNodes(input, [n('new')], 'missing').ok).toBe(false)
    expect(input).toEqual(before)
  })
  it('reconciles nested measured resize and drag while keeping static obstacles and sessions', () => {
    const input = [g('outer', 0, 0, 800, 600), g('inner', 28, 62, 500, 400, 'outer'),
      n('member', 28, 62, 300, 200, 'inner'), n('wall', 800, 0, 400, 1200)]
    get(input, 'member').measured = { width: 1100, height: 700 }
    get(input, 'member').data.initialCommand = 'launch unchanged'
    const nodes = ok(reconcileDynamicFlowNodes(input, ['member']))
    noOverlap(nodes)
    expect(get(nodes, 'wall')).toBe(get(input, 'wall'))
    expect(get(nodes, 'member').data).toBe(get(input, 'member').data)
    expect(get(nodes, 'outer').width).toBeGreaterThan(1100)
    const moved = nodes.map((node) => node.id === 'inner' ? { ...node, position: { x: -100, y: -100 } } : node)
    noOverlap(ok(reconcileDynamicFlowNodes(moved, ['inner'])))
  })
  it('uses collapsed footprints, keeps expanded dimensions and skips unrelated gestures', () => {
    const collapsed = n('collapsed', 28, 62, 300, 40, 'g')
    collapsed.data = { ...collapsed.data, collapsed: true, expandedHeight: 900 }
    const nodes = [g('g'), collapsed, n('unrelated', 2000, 2000)]
    expect(ok(reconcileDynamicFlowNodes(nodes, ['unrelated']))).toBe(nodes)
    const result = ok(appendGroupedFlowNodes(nodes, [n('new')], 'g'))
    expect(get(result, 'collapsed')).toBe(collapsed)
    expect(flowToNodeStates(result).find((n) => n.id === 'collapsed')!.size.height).toBe(900)
    noOverlap(result)
  })
  it('keeps slot facts compatible with protected host metadata after negative UI growth', () => {
    const frame = g('g', 100, 200, 1800, 1200)
    const facts = { version: 1 as const, reservations: [
      { id: 'slot', width: 300, height: 200, position: { x: 800, y: 62 }, state: 'reserved' as const }
    ] }
    frame.data.dynamicGroup = facts
    const input = [frame, n('changed', -372, 62, 300, 200, 'g'), n('static', 400, 62, 300, 200, 'g')]
    const result = ok(reconcileDynamicFlowNodes(input, ['changed']))
    expect(get(result, 'g').data.dynamicGroup).toBe(facts)
    noOverlap([...result, n('slot-probe', 800, 62, 300, 200, 'g')])
    const stored = flowToNodeStates(result).map((node) => node.id === 'g'
      ? { ...node, dynamicGroup: structuredClone(facts) } : node)
    expect(stored.find((n) => n.id === 'g')!.dynamicGroup).toEqual(facts)
    const restored = nodeStatesToFlow(stored)
    expect(ok(reconcileDynamicFlowNodes(restored, ['changed']))).toBe(restored)
    noOverlap([...restored, n('slot-probe', 800, 62, 300, 200, 'g')])
  })
  it('roundtrips bounded metadata and renders only passive active slots', () => {
    const state = { version: 1 as const, reservations: [
      { id: 'active', width: 300, height: 200, position: { x: 28, y: 62 }, state: 'reserved' as const },
      { id: 'done', width: 300, height: 200, position: { x: 328, y: 62 }, state: 'consumed' as const, nodeId: 'terminal' },
      { id: 'released', width: 300, height: 200, position: { x: 628, y: 62 }, state: 'released' as const }
    ] }
    const stored = { ...flowToNodeStates([g('g')])[0], dynamicGroup: state }
    const roundtrip = flowToNodeStates(nodeStatesToFlow([stored]))[0]
    expect(roundtrip.dynamicGroup).toEqual(state)
    const html = renderToStaticMarkup(<GroupReservations state={roundtrip.dynamicGroup} color="#123456" />)
    expect(html).toContain('Reserved · active')
    expect(html).toContain('left:28px;top:62px;width:300px;height:200px')
    expect(html).toContain('pointer-events:none')
    expect(html).not.toContain('done')
    expect(html).not.toContain('released')
    expect(html).not.toContain('<button')
    expect(renderToStaticMarkup(<GroupReservations state={{ version: 1, reservations: [{ id: '../bad' }] }} color="red" />)).toBe('')
    const live = nodeStatesToFlow([roundtrip])
    expect(ungroupNodes(live, 'g')).toBe(live)
    expect(planDynamicGroups([roundtrip], { version: 1, groups: [], members: [], reserve: [], release: [],
      remove: [{ id: 'g', promoteTo: null }] }).ok).toBe(false)
  })
})
