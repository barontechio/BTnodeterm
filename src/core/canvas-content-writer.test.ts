import { describe, expect, it, vi } from 'vitest'
import { CanvasContentWriter } from './canvas-content-writer'
import type { CanvasMutation, CanvasNodeState, Project, Workspace } from '../shared/types'

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 640, height: 440 },
  title: id, color: '#0a84ff', group: null
})

function fixture() {
  let stored: Workspace = {
    version: 2, activeProjectId: 'p', projects: [{
      id: 'p', name: 'Project', color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('a')]
    }]
  }
  const published: Project[] = []
  const mutations: CanvasMutation[] = []
  const save = vi.fn(async (ws: Workspace) => { stored = structuredClone(ws) })
  const writer = new CanvasContentWriter({
    workspaceStore: { load: async () => stored, save },
    publishMutation: (_id, m) => mutations.push(m),
    publishProject: (p) => published.push(p)
  })
  return { writer, save, published, mutations, read: () => stored }
}

describe('host canvas content writes', () => {
  it('edits a private copy and publishes node and edge changes before the save can overlay them', async () => {
    const f = fixture()
    const ws = await f.writer.loadForEdit()
    ws.projects[0].nodes.push(node('b'))
    ws.projects[0].ropes = [{ id: 'r', source: 'a', target: 'b' }]
    expect(f.read().projects[0].nodes.map((n) => n.id)).toEqual(['a'])
    f.save.mockImplementationOnce(async (next) => {
      expect(f.mutations).toEqual([
        { op: 'upsert', node: node('b') },
        { op: 'edge-upsert', kind: 'rope', edge: { id: 'r', source: 'a', target: 'b' } }
      ])
      expect(next.projects[0].nodes).toHaveLength(2)
    })
    expect(await f.writer.castAndSave(ws)).toBe(true)
  })

  it('broadcasts the stored project after persistence, including changes the store contributed', async () => {
    const f = fixture()
    const ws = await f.writer.loadForEdit()
    ws.projects[0].nodes[0].title = 'Renamed'
    await f.writer.castAndSave(ws)
    // A collaborator's change lands after the command saved and before its browser notification.
    f.read().projects[0].nodes.push(node('collaborator'))
    await f.writer.publishPersisted(['p'])
    expect(f.published[0].nodes.map((n) => n.id)).toEqual(['a', 'collaborator'])
    expect(f.published[0].nodes[0].title).toBe('Renamed')
  })

  it('does not resurrect a node deleted while an external effect was running', async () => {
    const f = fixture()
    await f.writer.loadForEdit()
    f.read().projects[0].nodes = []
    const apply = vi.fn(() => true)
    expect(await f.writer.savePatches([{ projectId: 'p', nodeId: 'a', apply }])).toEqual({
      saved: false, applied: [false]
    })
    expect(apply).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('refuses late writes and notifications after shutdown starts', async () => {
    const f = fixture()
    let stopped = false
    const writer = new CanvasContentWriter({
      workspaceStore: { load: async () => f.read(), save: f.save },
      isStopped: () => stopped,
      publishMutation: () => { throw new Error('late mutation') },
      publishProject: () => { throw new Error('late notification') }
    })
    const ws = await writer.loadForEdit()
    ws.projects[0].nodes.push(node('b'))
    stopped = true
    expect(await writer.castAndSave(ws)).toBe(false)
    await writer.publishPersisted(['p'])
    expect(f.save).not.toHaveBeenCalled()
  })
})
