import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from './types'
import { GROUP_HEADER, GROUP_PAD } from './canvas-geometry'
import { NODE_SIZE_MAX } from './default-node-size'
import {
  normalizeDynamicGroupState, parseDynamicGroupsSpec, placeDynamicGroupMember,
  planDynamicGroups, reconcileDynamicGroups, type DynamicGroupsResult, type DynamicGroupsSpec
} from './dynamic-groups'

const node = (id: string, x = 0, y = 0, width = 300, height = 200, parentId?: string): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#123456', group: null, position: { x, y }, size: { width, height },
  ...(parentId ? { parentId } : {})
})
const group = (id: string, x = 0, y = 0, width = 500, height = 400, parentId?: string): CanvasNodeState => ({
  ...node(id, x, y, width, height, parentId), kind: 'group'
})
const spec = (partial: Partial<DynamicGroupsSpec> = {}): DynamicGroupsSpec => ({
  version: 1, groups: [], members: [], reserve: [], release: [], remove: [], ...partial
})
function success(result: DynamicGroupsResult): Extract<DynamicGroupsResult, { ok: true }> {
  expect(result.ok, !result.ok ? result.error : '').toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result
}
const get = (nodes: CanvasNodeState[], id: string) => nodes.find((n) => n.id === id)!
function root(nodes: CanvasNodeState[], id: string): { x: number; y: number } {
  const n = get(nodes, id)
  const parent = n.parentId ? root(nodes, n.parentId) : { x: 0, y: 0 }
  return { x: n.position.x + parent.x, y: n.position.y + parent.y }
}
function checkLayout(nodes: CanvasNodeState[]): void {
  for (const n of nodes) {
    const height = n.collapsed ? 40 : n.size.height
    if (n.parentId) {
      const p = get(nodes, n.parentId)
      expect(n.position.x).toBeGreaterThanOrEqual(GROUP_PAD)
      expect(n.position.y).toBeGreaterThanOrEqual(GROUP_PAD + GROUP_HEADER)
      expect(n.position.x + n.size.width + GROUP_PAD).toBeLessThanOrEqual(p.size.width)
      expect(n.position.y + height + GROUP_PAD).toBeLessThanOrEqual(p.size.height)
    }
    for (const other of nodes) {
      if (other.id === n.id || other.parentId !== n.parentId) continue
      const otherHeight = other.collapsed ? 40 : other.size.height
      expect(n.position.x >= other.position.x + other.size.width || other.position.x >= n.position.x + n.size.width ||
        n.position.y >= other.position.y + otherHeight || other.position.y >= n.position.y + height,
      `${n.id} overlaps ${other.id}`).toBe(true)
    }
  }
}

describe('dynamic group schema and hostile persisted state', () => {
  it('normalizes optional arrays and validates explicit promotion destinations', () => {
    expect(parseDynamicGroupsSpec('{"version":1}')).toEqual({ ok: true, spec: spec() })
    for (const raw of [
      '{"version":2}', '{"version":1,"members":null}', '{"version":1,"unexpected":true}', '{"version":1,"remove":[{"id":"g"}]}',
      '{"version":1,"groups":[{"id":"../g"}]}', '{"version":1,"members":[{"id":"t","group":false}]}',
      '{"version":1,"groups":[{"id":"g"},{"id":"g"}]}',
      JSON.stringify({ version: 1, reserve: [{ id: 's', group: 'g', width: 1, height: 200 }] }),
      JSON.stringify({ version: 1, groups: Array.from({ length: 257 }, (_, i) => ({ id: `g${i}` })) }),
      JSON.stringify({ version: 1, reserve: [{ id: 's', group: 'g', width: NODE_SIZE_MAX.width + 1, height: 200 }] })
    ]) expect(parseDynamicGroupsSpec(raw).ok, raw).toBe(false)
  })
  it('copies bounded metadata and refuses duplicates, invalid states and missing consume facts', () => {
    const state = { version: 1, reservations: [{ id: 's', width: 400, height: 200, position: { x: 28, y: 62 }, state: 'reserved' }] }
    const normalized = normalizeDynamicGroupState(state)!
    normalized.reservations[0].position.x = 90
    expect(state.reservations[0].position.x).toBe(28)
    expect(normalizeDynamicGroupState({ ...state, reservations: [...state.reservations, ...state.reservations] })).toBeUndefined()
    for (const patch of [{ width: Infinity }, { state: 'consumed' }, { state: 'unknown' }, { nodeId: 'other' }, { position: { x: NaN, y: 1 } }]) {
      expect(normalizeDynamicGroupState({ ...state, reservations: [{ ...state.reservations[0], ...patch }] })).toBeUndefined()
    }
    expect(normalizeDynamicGroupState({ version: 1, reservations: Array(257).fill(state.reservations[0]) })).toBeUndefined()
  })
})

describe('atomic declarative planning', () => {
  it('activates existing named frames without changing their geometry or input metadata', () => {
    const input = [group('outer', 0, 0, 1000, 800), group('inner', 28, 62, 500, 400, 'outer')]
    const before = structuredClone(input)
    const desired = spec({ groups: [{ id: 'outer' }, { id: 'inner' }] })
    const result = success(planDynamicGroups(input, desired))
    expect(input).toEqual(before)
    for (const n of result.nodes) {
      expect(n).toEqual({ ...get(input, n.id), dynamicGroup: { version: 1, reservations: [] } })
    }
    expect(result.required).toEqual(['inner', 'outer'])
    expect(success(planDynamicGroups(result.nodes, desired)).nodes).toEqual(result.nodes)
  })
  it('preserves existing reservations and tombstones when activating a named frame again', () => {
    const reserved = success(planDynamicGroups([group('g')], spec({ reserve: [
      { id: 'pending', group: 'g', width: 300, height: 200 },
      { id: 'released', group: 'g', width: 300, height: 200 }
    ] }))).nodes
    const input = success(planDynamicGroups(reserved, spec({ release: [{ id: 'released', group: 'g' }] }))).nodes
    const result = success(planDynamicGroups(input, spec({ groups: [{ id: 'g' }] })))
    expect(result.nodes).toEqual(input)
    expect(get(result.nodes, 'g').dynamicGroup!.reservations.map((slot) => slot.state)).toEqual(['reserved', 'released'])
  })
  it('refuses removal with active reservations even when children have a promotion target', () => {
    const input = success(planDynamicGroups([group('g'), group('destination', 1000)], spec({
      reserve: [{ id: 'pending', group: 'g', width: 300, height: 200 }]
    }))).nodes
    const before = structuredClone(input)
    for (const promoteTo of [null, 'destination']) {
      const result = planDynamicGroups(input, spec({ groups: [{ id: 'unrelated-new' }], remove: [{ id: 'g', promoteTo }] }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('active reservations')
      expect(input).toEqual(before)
    }
    const released = success(planDynamicGroups(input, spec({ release: [{ id: 'pending', group: 'g' }] }))).nodes
    const removed = success(planDynamicGroups(released, spec({ remove: [{ id: 'g', promoteTo: null }] })))
    expect(removed.removed).toEqual(['g'])
    expect(removed.nodes.map((n) => n.id)).toEqual(['destination'])
  })
  it('creates nested frames and heterogeneous members deterministically and converges on repetition', () => {
    const input = [node('a', 0, 0, 700, 200), node('b', 0, 0, 300, 500)]
    const desired = spec({ groups: [{ id: 'outer', title: 'Outer', parent: null }, { id: 'inner', parent: 'outer' }],
      members: [{ id: 'a', group: 'inner' }, { id: 'b', group: 'inner' }],
      reserve: [{ id: 'future', group: 'inner', width: 400, height: 300 }] })
    const before = structuredClone(input)
    const result = success(planDynamicGroups(input, desired))
    expect(input).toEqual(before)
    expect(result.created).toEqual(['outer', 'inner'])
    checkLayout(result.nodes)
    expect(success(planDynamicGroups(input, desired)).nodes).toEqual(result.nodes)
    expect(success(planDynamicGroups(result.nodes, desired)).nodes).toEqual(result.nodes)
    expect(result.required).toEqual(expect.arrayContaining(['a', 'b', 'inner', 'outer']))
  })
  it('wraps distant existing members without covering intervening static obstacles', () => {
    const input = [node('t', 1000, 1000), node('wall', 500, 0, 300, 2000)]
    const result = success(planDynamicGroups(input, spec({ groups: [{ id: 'new' }], members: [{ id: 't', group: 'new' }] })))
    expect(root(result.nodes, 't')).toEqual(root(input, 't'))
    expect(get(result.nodes, 'new').size.width).toBe(356)
    expect(get(result.nodes, 'wall')).toEqual(get(input, 'wall'))
    checkLayout(result.nodes)
  })
  it('grows beyond the terminal size cap and propagates around static root obstacles', () => {
    const input = [group('outer', 0, 0, 500, 400), group('inner', 28, 62, 300, 200, 'outer'),
      node('t', 28, 62, 2300, 1500, 'inner'), node('wall', 500, -2000, 500, 5000)]
    const result = success(reconcileDynamicGroups(input, ['t']))
    checkLayout(result.nodes)
    expect(get(result.nodes, 'outer').size.width).toBeGreaterThan(NODE_SIZE_MAX.width)
    expect(get(result.nodes, 'wall')).toEqual(get(input, 'wall'))
    expect(result.required).toEqual(expect.arrayContaining(['t', 'inner', 'outer']))
    expect(result.required).not.toContain('wall')
  })
  it('preserves manual frame sizes and existing valid positions; deletion never compacts', () => {
    const input = [group('g', 0, 0, 1800, 1200), node('t', 900, 400, 300, 200, 'g')]
    expect(success(reconcileDynamicGroups(input, ['t'])).nodes).toEqual(input)
    const withSlot = success(planDynamicGroups(input, spec({ reserve: [{ id: 's', group: 'g', width: 300, height: 200 }] }))).nodes
    const released = success(planDynamicGroups(withSlot, spec({ release: [{ id: 's', group: 'g' }] }))).nodes
    expect(get(released, 'g').size).toEqual({ width: 1800, height: 1200 })
    expect(get(released, 't')).toEqual(get(input, 't'))
  })
  it('rejects the whole batch for invalid scenes, references, cycles and conflicting operations', () => {
    const input = [group('g'), node('t', 28, 62, 300, 200, 'g')]
    const before = structuredClone(input)
    for (const desired of [
      spec({ groups: [{ id: 'new' }], members: [{ id: 'absent', group: 'new' }] }),
      spec({ groups: [{ id: 'g', parent: 'g' }] }),
      spec({ groups: [{ id: 'g', parent: 'new' }, { id: 'new', parent: 'g' }] }),
      spec({ groups: [{ id: 't' }] }),
      spec({ groups: [{ id: 'new', parent: 't' }] }),
      spec({ groups: [{ id: 'g' }], remove: [{ id: 'g', promoteTo: null }] })
    ]) expect(planDynamicGroups(input, desired).ok).toBe(false)
    expect(input).toEqual(before)
    for (const scene of [[...input, input[0]], [{ ...input[0], parentId: 't' }, input[1]], [{ ...input[0], position: { x: Infinity, y: 0 } }]]) {
      expect(planDynamicGroups(scene, spec()).ok).toBe(false)
    }
  })
  it('promotes children without changing root geometry, launch state, sessions or link metadata', () => {
    const t = { ...node('t', 28, 62, 300, 200, 'g'), cwd: '/project', agentId: 'codex', agentSessionId: 'session',
      openedBy: 'source', pendingLaunch: { command: 'codex', after: ['dependency'] } } as CanvasNodeState
    const input = [group('g', 100, 200), t]
    const desired = spec({ remove: [{ id: 'g', promoteTo: null }] })
    const result = success(planDynamicGroups(input, desired))
    expect(result.removed).toEqual(['g'])
    expect(root(result.nodes, 't')).toEqual(root(input, 't'))
    expect(get(result.nodes, 't')).toEqual({ ...t, parentId: undefined, position: root(input, 't') })
    expect(success(planDynamicGroups(result.nodes, desired)).nodes).toEqual(result.nodes)
  })
  it('requires old/new ancestors and descendants whose root footprint moves', () => {
    const input = [group('old', 0, 0, 800, 700), group('new', 1000, 0, 800, 700),
      group('inner', 28, 62, 500, 400, 'old'), node('t', 28, 62, 300, 200, 'inner')]
    const result = success(planDynamicGroups(input, spec({ members: [{ id: 'inner', group: 'new' }] })))
    expect(result.required).toEqual(expect.arrayContaining(['old', 'new', 'inner', 't']))
    checkLayout(result.nodes)
  })
  it('refuses worktree frame removal and changes in cwd/worktree inheritance including descendants', () => {
    const bound = { ...group('work'), worktree: { path: '/work', branch: 'topic' } } as CanvasNodeState
    expect(planDynamicGroups([bound], spec({ remove: [{ id: 'work', promoteTo: null }] })).ok).toBe(false)
    const input = [bound, group('plain', 1000), group('inner', 28, 62, 500, 400, 'work'), node('t', 28, 62, 300, 200, 'inner')]
    expect(planDynamicGroups(input, spec({ members: [{ id: 'inner', group: 'plain' }] })).ok).toBe(false)
    const cwd = [ { ...group('a'), cwd: '/a' }, { ...group('b', 1000), cwd: '/b' }, node('t', 28, 62, 300, 200, 'a') ]
    expect(planDynamicGroups(cwd, spec({ members: [{ id: 't', group: 'b' }] })).ok).toBe(false)
  })
})

describe('reserved and ordinary group opens', () => {
  const reserve = spec({ reserve: [{ id: 'slot', group: 'g', width: 600, height: 440 }] })
  it('allocates actual free rectangles, consumes once and preserves tombstones after serialization', () => {
    const input = [group('g', 0, 0, 1400, 1000), node('existing', 28, 62, 700, 600, 'g')]
    const reserved = success(planDynamicGroups(input, reserve)).nodes
    const before = structuredClone(reserved)
    const opened = success(placeDynamicGroupMember(reserved, 'g', node('new', 0, 0, 600, 440), 'slot'))
    expect(reserved).toEqual(before)
    checkLayout(opened.nodes)
    const slot = get(opened.nodes, 'g').dynamicGroup!.reservations[0]
    expect(slot).toMatchObject({ id: 'slot', state: 'consumed', nodeId: 'new' })
    expect(get(opened.nodes, 'new').position).toEqual(slot.position)
    const restored = JSON.parse(JSON.stringify(opened.nodes)) as CanvasNodeState[]
    expect(placeDynamicGroupMember(restored, 'g', node('duplicate'), 'slot').ok).toBe(false)
    expect(success(planDynamicGroups(restored, reserve)).nodes).toEqual(restored)
    expect(placeDynamicGroupMember(reserved, 'g', node('oversize', 0, 0, 800, 500), 'slot').ok).toBe(false)
  })
  it('released slots remain unavailable even when the original reserve batch is replayed', () => {
    const reserved = success(planDynamicGroups([group('g')], reserve)).nodes
    const released = success(planDynamicGroups(reserved, spec({ release: [{ id: 'slot', group: 'g' }] }))).nodes
    const replay = success(planDynamicGroups(released, reserve)).nodes
    expect(get(replay, 'g').dynamicGroup!.reservations[0].state).toBe('released')
    expect(placeDynamicGroupMember(replay, 'g', node('new'), 'slot').ok).toBe(false)
  })
  it('serial ordinary opens avoid both slots and prior heterogeneously sized members', () => {
    let nodes = success(planDynamicGroups([group('g')], reserve)).nodes
    for (let i = 0; i < 8; i++) nodes = success(placeDynamicGroupMember(nodes, 'g', node(`t${i}`, 0, 0, 300 + i * 50, 200 + i * 25))).nodes
    checkLayout(nodes)
    const slot = get(nodes, 'g').dynamicGroup!.reservations[0]
    nodes = success(placeDynamicGroupMember(nodes, 'g', node('reserved', 0, 0, slot.width, slot.height), 'slot')).nodes
    checkLayout(nodes)
  })
  it('maintains containment and disjoint siblings through nested growth and sequential opens', () => {
    let nodes = success(planDynamicGroups([], spec({ groups: [
      { id: 'outer' }, { id: 'left', parent: 'outer' }, { id: 'right', parent: 'outer' }
    ] }))).nodes
    for (let i = 0; i < 24; i++) {
      const frame = i % 2 ? 'left' : 'right'
      nodes = success(placeDynamicGroupMember(nodes, frame,
        node(`terminal-${i}`, 0, 0, 260 + (i * 137) % 800, 160 + (i * 73) % 500))).nodes
      checkLayout(nodes)
      const stable = success(reconcileDynamicGroups(nodes, [`terminal-${i}`])).nodes
      expect(stable).toEqual(nodes)
    }
  })
  it('uses collapsed height while preserving the expanded size', () => {
    const input = [group('g', 0, 0, 800, 400), { ...node('collapsed', 28, 62, 300, 900, 'g'), collapsed: true }, node('next', 28, 102, 300, 200, 'g')]
    expect(success(reconcileDynamicGroups(input, ['next'])).nodes).toEqual(input)
  })
  it('keeps unrelated pre-existing overlaps and moves only the changed sibling', () => {
    const input = [group('g', 0, 0, 2000, 1400), node('a', 28, 62, 300, 200, 'g'), node('b', 28, 62, 300, 200, 'g'),
      node('moved', 28, 62, 300, 200, 'g')]
    const result = success(reconcileDynamicGroups(input, ['moved']))
    expect(get(result.nodes, 'a')).toEqual(get(input, 'a'))
    expect(get(result.nodes, 'b')).toEqual(get(input, 'b'))
    expect(get(result.nodes, 'moved').position).toEqual({ x: 28, y: 262 })
  })
  it('preserves already-valid affected positions while resolving nearby collisions', () => {
    const input = [group('g', 0, 0, 2000, 1400), node('static', 28, 62, 300, 200, 'g'),
      node('a-conflicted', 28, 62, 300, 200, 'g'), node('z-valid', 28, 262, 300, 200, 'g')]
    const result = success(reconcileDynamicGroups(input, ['a-conflicted', 'z-valid']))
    expect(get(result.nodes, 'z-valid')).toEqual(get(input, 'z-valid'))
    checkLayout(result.nodes)
  })
  it('fits a real hole among heterogeneous obstacles without growing a manually sized frame', () => {
    const input = [group('g', 0, 0, 1000, 800), node('left', 28, 62, 300, 600, 'g'),
      node('upper', 628, 62, 300, 200, 'g'), node('lower', 328, 262, 600, 400, 'g')]
    const result = success(placeDynamicGroupMember(input, 'g', node('new')))
    expect(get(result.nodes, 'new').position).toEqual({ x: 328, y: 62 })
    expect(get(result.nodes, 'g').size).toEqual(get(input, 'g').size)
    checkLayout(result.nodes)
  })
  it('expands left/top around negative children without moving their root positions', () => {
    const input = [group('g', 100, 200), node('t', -100, -100, 300, 200, 'g')]
    const result = success(reconcileDynamicGroups(input, ['t']))
    expect(root(result.nodes, 't')).toEqual(root(input, 't'))
    checkLayout(result.nodes)
  })
  it('keeps active and tombstone slot coordinates fixed through left/top growth and protected-facts replay', () => {
    const frame = group('g', 100, 200, 1400, 1000)
    frame.dynamicGroup = { version: 1, reservations: [
      { id: 'active', width: 400, height: 300, position: { x: 28, y: 62 }, state: 'reserved' },
      { id: 'consumed', width: 300, height: 200, position: { x: 500, y: 62 }, state: 'consumed', nodeId: 'historic' },
      { id: 'released', width: 300, height: 200, position: { x: 500, y: 300 }, state: 'released' }
    ] }
    const input = [frame, node('changed', -100, -100, 300, 200, 'g'), node('static', 900, 600, 300, 200, 'g')]
    const before = structuredClone(input)
    const facts = structuredClone(frame.dynamicGroup)
    const result = success(reconcileDynamicGroups(input, ['changed']))
    expect(input).toEqual(before)
    expect(get(result.nodes, 'g').dynamicGroup).toEqual(facts)
    expect(root(result.nodes, 'static')).toEqual(root(input, 'static'))
    const probe = node('active-slot-probe', facts.reservations[0].position.x, facts.reservations[0].position.y,
      facts.reservations[0].width, facts.reservations[0].height, 'g')
    checkLayout([...result.nodes, probe])
    // The host replaces a client's reservation facts on save with this pre-gesture copy.
    const restored = result.nodes.map((n) => n.id === 'g' ? { ...n, dynamicGroup: structuredClone(facts) } : n)
    expect(success(reconcileDynamicGroups(restored, ['changed'])).nodes).toEqual(result.nodes)
    const opened = success(placeDynamicGroupMember(restored, 'g', node('opened', 0, 0, 400, 300), 'active'))
    checkLayout(opened.nodes)
    expect(get(opened.nodes, 'opened').position).toEqual(facts.reservations[0].position)
    expect(get(opened.nodes, 'g').dynamicGroup!.reservations[0]).toMatchObject({ state: 'consumed', nodeId: 'opened', position: facts.reservations[0].position })
    expect(get(opened.nodes, 'g').dynamicGroup!.reservations.slice(1)).toEqual(facts.reservations.slice(1))
  })
  it('avoids a static child swept by a fixed-relative slot during frame compensation', () => {
    const frame = group('g', 100, 200, 1800, 1200)
    frame.dynamicGroup = { version: 1, reservations: [
      { id: 'slot', width: 300, height: 200, position: { x: 800, y: 62 }, state: 'reserved' }
    ] }
    const input = [frame, node('changed', -372, 62, 300, 200, 'g'), node('static', 400, 62, 300, 200, 'g')]
    const result = success(reconcileDynamicGroups(input, ['changed']))
    expect(get(result.nodes, 'g').dynamicGroup).toEqual(frame.dynamicGroup)
    expect(root(result.nodes, 'static')).toEqual(root(input, 'static'))
    expect(root(result.nodes, 'changed')).toEqual(root(input, 'changed'))
    checkLayout([...result.nodes, node('slot-probe', 800, 62, 300, 200, 'g')])
    expect(result.required).toEqual(expect.arrayContaining(['g', 'changed', 'static']))
    expect(success(reconcileDynamicGroups(result.nodes, ['changed'])).nodes).toEqual(result.nodes)
  })
  it('keeps compensation collision-free and convergent with fractional UI dimensions', () => {
    const frame = group('g', 100, 200, 1800, 1200)
    frame.dynamicGroup = { version: 1, reservations: [
      { id: 'slot', width: 300, height: 200.1, position: { x: 800, y: 62 }, state: 'reserved' }
    ] }
    const input = [frame, node('changed', -372, 62, 300, 200, 'g'), node('static', 400, 62, 300, 200.3, 'g')]
    const result = success(reconcileDynamicGroups(input, ['changed']))
    expect(get(result.nodes, 'g').dynamicGroup).toEqual(frame.dynamicGroup)
    const staticBefore = root(input, 'static'), staticAfter = root(result.nodes, 'static')
    expect(staticAfter.x).toBeCloseTo(staticBefore.x, 8)
    expect(staticAfter.y).toBeCloseTo(staticBefore.y, 8)
    checkLayout([...result.nodes, node('slot-probe', 800, 62, 300, 200.1, 'g')])
    expect(success(reconcileDynamicGroups(result.nodes, ['changed'])).nodes).toEqual(result.nodes)
  })
  it('keeps slot facts stable and members contained through nested negative growth', () => {
    const outer = group('outer', 0, 0, 1200, 1000)
    const inner = group('inner', 28, 300, 800, 700, 'outer')
    for (const frame of [outer, inner]) frame.dynamicGroup = { version: 1, reservations: [
      { id: `${frame.id}-slot`, width: 300, height: 200, position: { x: 28, y: 62 }, state: 'reserved' }
    ] }
    const input = [outer, inner, node('changed', -100, -100, 300, 200, 'inner'), node('static', 400, 400, 300, 200, 'inner')]
    const result = success(reconcileDynamicGroups(input, ['changed']))
    expect(get(result.nodes, 'outer').dynamicGroup).toEqual(outer.dynamicGroup)
    expect(get(result.nodes, 'inner').dynamicGroup).toEqual(inner.dynamicGroup)
    checkLayout([...result.nodes, node('outer-slot-probe', 28, 62, 300, 200, 'outer'), node('inner-slot-probe', 28, 62, 300, 200, 'inner')])
    expect(success(reconcileDynamicGroups(result.nodes, ['changed'])).nodes).toEqual(result.nodes)
  })
  it('uses root-space grid coordinates for a new slot in an offset frame', () => {
    const input = [group('g', 5, 7, 1000, 800)]
    const result = success(planDynamicGroups(input, reserve, { grid: 20 }))
    const g = get(result.nodes, 'g'), slot = g.dynamicGroup!.reservations[0]
    expect((slot.position.x + g.position.x) % 20).toBe(0)
    expect((slot.position.y + g.position.y) % 20).toBe(0)
  })
  it('rejects a corrupted reserved footprint rather than consuming it elsewhere', () => {
    const reserved = success(planDynamicGroups([group('g')], reserve)).nodes
    const slot = get(reserved, 'g').dynamicGroup!.reservations[0]
    reserved.push(node('obstacle', slot.position.x, slot.position.y, 300, 200, 'g'))
    expect(placeDynamicGroupMember(reserved, 'g', node('new'), 'slot').ok).toBe(false)
    expect(slot.state).toBe('reserved')
  })
  it('refuses a bounded canvas conflict without mutating the source', () => {
    const input = [node('wall1', -10_000_000, -10_000_000, 10_000_000, 10_000_000),
      node('wall2', 0, -10_000_000, 10_000_000, 10_000_000),
      node('wall3', -10_000_000, 0, 10_000_000, 10_000_000),
      node('wall4', 0, 0, 10_000_000, 10_000_000), node('moving')]
    const before = structuredClone(input)
    const result = reconcileDynamicGroups(input, ['moving'])
    expect(result.ok).toBe(false)
    expect(input).toEqual(before)
    expect(reconcileDynamicGroups(input, ['moving'], { grid: -1 }).ok).toBe(false)
  })
})
