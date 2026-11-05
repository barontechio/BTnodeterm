import { describe, expect, it } from 'vitest'
import { baselineAfterSave, mergeWorkspaceSave } from './workspace-save-merge'
import { defaultKanbanFor } from './kanban-default-board'
import { placeAssignment } from './kanban-order'
import type { BridgeLink, CanvasNodeState, Workspace } from './types'

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#0a84ff', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }
})
const workspace = (): Workspace => ({ version: 2, activeProjectId: 'p', projects: [{
  id: 'p', name: 'Project', color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a'), node('b')]
}] })

describe('rebasing an owner workspace save', () => {
  it('preserves a concurrent reorder when the submitted save only changes a field', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes[0].title = 'Edited'
    current.projects[0].nodes.reverse()
    const out = mergeWorkspaceSave(base, next, current)
    expect(out.projects[0].nodes.map((n) => n.id)).toEqual(['b', 'a'])
    expect(out.projects[0].nodes[1].title).toBe('Edited')
    expect(base.projects[0].nodes[0].title).toBe('a')
  })

  it('inserts a new node at its requested neighbor and preserves a concurrent addition', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes.splice(1, 0, node('mine'))
    current.projects[0].nodes.push(node('theirs'))
    expect(mergeWorkspaceSave(base, next, current).projects[0].nodes.map((n) => n.id))
      .toEqual(['a', 'mine', 'b', 'theirs'])
  })

  it('retains a claimed launch while an old tab renames the same node', () => {
    const base = workspace()
    base.projects[0].nodes[0].pendingLaunch = { command: 'claude', after: [], executor: 'server' }
    const next = structuredClone(base)
    const current = structuredClone(base)
    current.projects[0].nodes[0].pendingLaunch = { ...current.projects[0].nodes[0].pendingLaunch!, attempted: true, manualOnly: true }
    next.projects[0].nodes[0].title = 'Rename'
    expect(mergeWorkspaceSave(base, next, current).projects[0].nodes[0].pendingLaunch)
      .toMatchObject({ attempted: true, manualOnly: true })
  })

  it('refuses a drag expressed in an old coordinate frame after the host reparented the node', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes[0].position.x = 200
    current.projects[0].nodes[0].parentId = 'frame'
    current.projects[0].nodes.push({ ...node('frame'), kind: 'group' })
    expect(() => mergeWorkspaceSave(base, next, current)).toThrow('changed coordinate frames')
  })

  it('keeps unrelated board metadata and ordering when one card moves', () => {
    const base = workspace()
    base.projects[0].kanban = defaultKanbanFor('p')
    const next = structuredClone(base)
    const current = structuredClone(base)
    const board = next.projects[0].kanban!
    board.assignments = placeAssignment(board.assignments, 'a', board.columns[1].id, 'top')
    current.projects[0].kanban!.meta = [{ nodeId: 'b', priority: 'high' }]
    const result = mergeWorkspaceSave(base, next, current).projects[0].kanban!
    expect(result.assignments[0]).toMatchObject({ nodeId: 'a', columnId: board.columns[1].id })
    expect(result.meta).toEqual([{ nodeId: 'b', priority: 'high' }])
  })

  it('leaves governed content and the owner exec overlay for the existing authority to merge', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes[0].pendingLaunch = { command: 'claude', after: [], executor: 'server' }
    current.projects[0].nodes[0].title = 'Authority title'
    expect(mergeWorkspaceSave(base, next, current, () => true).projects[0].nodes[0])
      .toEqual(next.projects[0].nodes[0])
  })

  it('refuses a project both sides created: its id can really collide', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects.push({ ...next.projects[0], id: 'same-folder', name: 'Mine' })
    current.projects.push({ ...current.projects[0], id: 'same-folder', name: 'Another creation' })
    expect(() => mergeWorkspaceSave(base, next, current)).toThrow('workspace-save-conflict')
  })

  // A tab adopts a node the server just created, from an op or a server-change, and then saves it
  // with its own serialization. Its baseline lacks the node, because a baseline only moves when a
  // save lands, so refusing here failed that save and every later one until a reload.
  it('keeps the host copy of a node the writer adopted, and takes the rest of the save', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes[0].title = 'Edited in the same save'
    next.projects[0].nodes.push({ ...node('adopted'), size: { width: 999, height: 999 } })
    current.projects[0].nodes.push({ ...node('adopted'), pendingLaunch: { after: [], command: 'held' } })

    const merged = mergeWorkspaceSave(base, next, current).projects[0].nodes

    expect(merged.find((n) => n.id === 'adopted')).toEqual(current.projects[0].nodes.at(-1))
    expect(merged[0].title).toBe('Edited in the same save')
    expect(merged.filter((n) => n.id === 'adopted')).toHaveLength(1)
  })

  describe('what an adopting save cannot leave for later', () => {
    const adopting = (mine: Partial<CanvasNodeState>, host: Partial<CanvasNodeState>) => {
      const base = workspace()
      const next = structuredClone(base)
      const current = structuredClone(base)
      next.projects[0].nodes.push({ ...node('adopted'), ...mine })
      current.projects[0].nodes.push({ ...node('adopted'), ...host })
      return mergeWorkspaceSave(base, next, current).projects[0].nodes.find((n) => n.id === 'adopted')!
    }

    it('lands a launch claim, which the claimant reads as durable', () => {
      const claim = { after: [], command: 'run', attempted: true, manualOnly: true }
      expect(adopting({ pendingLaunch: claim }, { pendingLaunch: { after: [], command: 'run' } }).pendingLaunch).toEqual(claim)
    })

    it('never brings back a launch the host cleared, or claims a different one', () => {
      const claim = { after: [], command: 'run', attempted: true, manualOnly: true }
      expect(adopting({ pendingLaunch: claim }, {}).pendingLaunch).toBeUndefined()
      const other = { after: [], command: 'other' }
      expect(adopting({ pendingLaunch: claim }, { pendingLaunch: other }).pendingLaunch).toEqual(other)
    })

    it('never undoes a claim the host already holds', () => {
      const held = { after: [], command: 'run', attempted: true, manualOnly: true }
      expect(adopting({ pendingLaunch: { after: [], command: 'run' } }, { pendingLaunch: held }).pendingLaunch).toEqual(held)
    })

    const adoptingEdge = (mine: Partial<BridgeLink>, host: Partial<BridgeLink>) => {
      const base = workspace()
      const next = structuredClone(base)
      const current = structuredClone(base)
      next.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', ...mine }]
      current.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', ...host }]
      return mergeWorkspaceSave(base, next, current).projects[0].bridges![0]
    }

    it('lands a one-way reader, and never widens a link the host holds as one-way', () => {
      expect(adoptingEdge({ reader: 'a' }, {}).reader).toBe('a')
      expect(adoptingEdge({}, { reader: 'a' }).reader).toBe('a')
      expect(adoptingEdge({ reader: 'c' }, { reader: 'a' }).reader).toBe('a')
    })
  })

  it('takes an adopted child out of a frame this writer removed, instead of refusing', () => {
    const base = workspace()
    base.projects[0].nodes.push({ ...node('frame'), kind: 'group' })
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes = next.projects[0].nodes.filter((n) => n.id !== 'frame')
    next.projects[0].nodes.push({ ...node('adopted'), position: { x: 7, y: 8 } })
    current.projects[0].nodes.push({ ...node('adopted'), parentId: 'frame', position: { x: 1, y: 2 } })

    const adopted = mergeWorkspaceSave(base, next, current).projects[0].nodes.find((n) => n.id === 'adopted')!

    expect(adopted.parentId).toBeUndefined()
    expect(adopted.position).toEqual({ x: 7, y: 8 })
  })

  it('moves up a child this writer never saw, instead of refusing every save from here on', () => {
    const base = workspace()
    base.projects[0].nodes.push({ ...node('outer'), kind: 'group', position: { x: 100, y: 100 } })
    base.projects[0].nodes.push({ ...node('frame'), kind: 'group', parentId: 'outer', position: { x: 10, y: 10 } })
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes = next.projects[0].nodes.filter((n) => n.id !== 'frame')
    current.projects[0].nodes.push({ ...node('stranger'), parentId: 'frame', position: { x: 1, y: 2 } })

    const stranger = mergeWorkspaceSave(base, next, current).projects[0].nodes.find((n) => n.id === 'stranger')!

    expect(stranger.parentId).toBe('outer')
    expect(stranger.position).toEqual({ x: 11, y: 12 })
  })

  it('moves a child up through every frame this save removed', () => {
    const base = workspace()
    base.projects[0].nodes.push({ ...node('outer'), kind: 'group', position: { x: 100, y: 100 } })
    base.projects[0].nodes.push({ ...node('frame'), kind: 'group', parentId: 'outer', position: { x: 10, y: 10 } })
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes = next.projects[0].nodes.filter((n) => n.id !== 'frame' && n.id !== 'outer')
    current.projects[0].nodes.push({ ...node('stranger'), parentId: 'frame', position: { x: 1, y: 2 } })

    const stranger = mergeWorkspaceSave(base, next, current).projects[0].nodes.find((n) => n.id === 'stranger')!

    expect(stranger.parentId).toBeUndefined()
    expect(stranger.position).toEqual({ x: 111, y: 112 })
  })

  it('moves a child up out of a frame cycle in a hand-edited file, instead of hanging', () => {
    const base = workspace()
    base.projects[0].nodes.push({ ...node('x'), kind: 'group', parentId: 'y' })
    base.projects[0].nodes.push({ ...node('y'), kind: 'group', parentId: 'x' })
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes = next.projects[0].nodes.filter((n) => n.id !== 'x' && n.id !== 'y')
    current.projects[0].nodes.push({ ...node('stranger'), parentId: 'x' })

    const stranger = mergeWorkspaceSave(base, next, current).projects[0].nodes.find((n) => n.id === 'stranger')!

    expect(stranger.parentId).toBeUndefined()
  })

  describe('baselineAfterSave', () => {
    const adoptingSave = (mine: Partial<CanvasNodeState>, host: Partial<CanvasNodeState>) => {
      const base = workspace()
      const submitted = structuredClone(base)
      submitted.projects[0].nodes.push({ ...node('adopted'), ...mine })
      const merged = structuredClone(base)
      merged.projects[0].nodes.push({ ...node('adopted'), ...host })
      return baselineAfterSave(base, submitted, merged).projects[0].nodes.find((n) => n.id === 'adopted')!
    }

    it('takes the host value of a key both copies hold, so the writer\'s change shows as a change', () => {
      expect(adoptingSave({ title: 'Mine' }, { title: 'Host' }).title).toBe('Host')
    })

    it('leaves out a key only the host holds, so its absence is not a deletion', () => {
      const out = adoptingSave({}, { openedBy: 'someone', agentSessionId: 'session' })
      expect('openedBy' in out).toBe(false)
      expect('agentSessionId' in out).toBe(false)
    })

    it('leaves out a key only the writer holds, so it lands as an addition', () => {
      expect('collapsed' in adoptingSave({ collapsed: true }, {})).toBe(false)
    })

    it('keeps the writer\'s own value for what its copy cannot speak for', () => {
      const claimed = { after: [], command: 'run', attempted: true, manualOnly: true }
      const mine = { after: [], command: 'run' }
      expect(adoptingSave({ pendingLaunch: mine }, { pendingLaunch: claimed }).pendingLaunch).toEqual(mine)
      expect(adoptingSave({ shell: '/bin/a' }, { shell: '/bin/b' }).shell).toBe('/bin/a')
    })

    it('takes the host\'s parent even if the writer lacks one: leaving a frame is a change', () => {
      expect(adoptingSave({}, { parentId: 'f' }).parentId).toBe('f')
    })

    it('touches only adopted items: everything else stays as submitted', () => {
      const base = workspace()
      const submitted = structuredClone(base)
      submitted.projects[0].nodes[0].title = 'Mine'
      submitted.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c' }]
      const merged = structuredClone(submitted)
      merged.projects[0].nodes[0].title = 'Host changed it concurrently'
      merged.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', reader: 'a' }]
      base.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c' }]

      const out = baselineAfterSave(base, submitted, merged).projects[0]

      expect(out.nodes[0].title).toBe('Mine')
      expect(out.bridges).toEqual(submitted.projects[0].bridges)
    })

    it.each([
      ['no reader', undefined],
      ['another reader', 'c']
    ])('keeps the writer\'s own reader on an adopted edge whose copy has %s', (_name, reader) => {
      const base = workspace()
      const submitted = structuredClone(base)
      submitted.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', ...(reader ? { reader } : {}) }]
      const merged = structuredClone(base)
      merged.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', reader: 'a' }]

      expect(baselineAfterSave(base, submitted, merged).projects[0].bridges).toEqual(submitted.projects[0].bridges)
    })

    it('keeps the writer\'s placement when its copy names a frame it no longer holds', () => {
      const base = workspace()
      const submitted = structuredClone(base)
      submitted.projects[0].nodes.push({ ...node('child'), parentId: 'gone', position: { x: 1, y: 2 } })
      const merged = structuredClone(base)
      merged.projects[0].nodes.push({ ...node('child'), position: { x: 101, y: 102 } })

      const child = baselineAfterSave(base, submitted, merged).projects[0].nodes.find((n) => n.id === 'child')!

      expect(child.parentId).toBe('gone')
      expect(child.position).toEqual({ x: 1, y: 2 })
    })
  })

  it('does not interpret an unreadable project as a node deletion', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes[0].title = 'Keep this edit in memory'
    current.projects[0].unavailable = true
    current.projects[0].nodes = []
    expect(() => mergeWorkspaceSave(base, next, current)).toThrow('workspace-save-unavailable')
  })
})
