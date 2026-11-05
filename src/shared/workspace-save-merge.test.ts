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

  it('refuses ambiguous concurrent creation instead of guessing which item to overwrite', () => {
    const base = workspace()
    const next = structuredClone(base)
    const current = structuredClone(base)
    next.projects[0].nodes.push(node('collision'))
    current.projects[0].nodes.push({ ...node('collision'), title: 'Another creation' })
    expect(() => mergeWorkspaceSave(base, next, current)).toThrow('workspace-save-conflict')
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
