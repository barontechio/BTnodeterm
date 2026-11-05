import { describe, expect, it } from 'vitest'
import { mergeWorkspaceSave } from './workspace-save-merge'
import { defaultKanbanFor } from './kanban-default-board'
import { placeAssignment } from './kanban-order'
import type { CanvasNodeState, Workspace } from './types'

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

  it('keeps the host copy of an edge the writer adopted', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c' }]
    current.projects[0].bridges = [{ id: 'b', source: 'a', target: 'c', reader: 'a' }]

    expect(mergeWorkspaceSave(base, next, current).projects[0].bridges).toEqual(current.projects[0].bridges)
  })

  it('applies an edit to an adopted node once the baseline holds it', () => {
    const base = workspace()
    const current = structuredClone(base)
    const adopted = { ...node('adopted'), pendingLaunch: { after: [], command: 'held' } }
    current.projects[0].nodes.push(adopted)
    const first = structuredClone(base)
    first.projects[0].nodes.push({ ...node('adopted'), size: { width: 999, height: 999 } })
    const afterFirst = mergeWorkspaceSave(base, first, current)

    const second = structuredClone(first)
    second.projects[0].nodes.at(-1)!.title = 'Renamed later'
    const merged = mergeWorkspaceSave(first, second, afterFirst).projects[0].nodes.at(-1)!

    expect(merged.title).toBe('Renamed later')
    expect(merged.pendingLaunch).toEqual(adopted.pendingLaunch)
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
