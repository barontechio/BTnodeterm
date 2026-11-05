// A tab's whole save over a node the host created, through the real WorkspaceStore handlers: each
// client's load baseline, the merge and the file on disk.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'

const TAB = 1
const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#000', group: null,
  position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, ...extra
})
const frame = (id: string): CanvasNodeState => ({
  id, kind: 'group', title: id, color: '#000', group: null,
  position: { x: 500, y: 500 }, size: { width: 900, height: 700 }
})

describe('a tab saving a node the host created', () => {
  let store: WorkspaceStore
  let fake: ReturnType<typeof fakePlatform>
  let cwd: string

  const load = async (): Promise<Workspace> => structuredClone(await fake.handlers[IPC.workspaceLoad](TAB) as Workspace)
  const save = (ws: Workspace): Promise<unknown> => Promise.resolve(fake.handlers[IPC.workspaceSave](TAB, structuredClone(ws)))
  const onDisk = (): Project => JSON.parse(fs.readFileSync(path.join(cwd, '.nodeterm', 'project.json'), 'utf8'))
  const diskNode = (id: string): CanvasNodeState | undefined => onDisk().nodes.find((n) => n.id === id)
  /** The host's own write, as a canvas verb's rebased save. */
  const hostAdds = async (...nodes: CanvasNodeState[]): Promise<void> => {
    const before = structuredClone(await store.load({ sideline: false }))
    const after = structuredClone(before)
    after.projects[0].nodes.push(...nodes)
    await store.saveChanges(before, after)
  }
  /** The tab's copy of the host's node: the same node, serialized its own way. */
  const adopt = (ws: Workspace, id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState => {
    const copy = node(id, { size: { width: 401, height: 301 }, ...extra })
    ws.projects[0].nodes.push(copy)
    return copy
  }

  beforeEach(async () => {
    resetPlatformForTests()
    const root = testTmpDir('adopted-save-')
    cwd = path.join(root, 'project')
    fs.mkdirSync(cwd)
    fake = fakePlatform({ userDataDir: path.join(root, 'data') })
    fs.mkdirSync(path.join(root, 'data'))
    initPlatform(fake)
    store = new WorkspaceStore()
    store.registerIpc()
    await store.save({ version: 2, activeProjectId: 'p', projects: [{
      id: 'p', name: 'P', color: '#000', cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a'), frame('f')]
    }] })
  })

  it('keeps saving after the adoption, and later edits land whole', async () => {
    const tab = await load()
    await hostAdds(node('opened'))

    const mine = adopt(tab, 'opened')
    tab.projects[0].nodes[0].title = 'Edited with it'
    await save(tab)
    expect(diskNode('a')?.title).toBe('Edited with it')
    expect(diskNode('opened')?.size).toEqual({ width: 400, height: 300 })

    // An edit made before that save and one made after it both reach the disk with the next save.
    mine.position = { x: 70, y: 80 }
    mine.title = 'Renamed'
    await save(tab)
    expect(diskNode('opened')).toMatchObject({ title: 'Renamed', position: { x: 70, y: 80 } })
  })

  it('an edit made before the first save lands with the next one, not only if changed again', async () => {
    const tab = await load()
    await hostAdds(node('opened'))
    const mine = adopt(tab, 'opened', { position: { x: 70, y: 80 } })
    await save(tab)

    mine.title = 'Only the title changes now'
    await save(tab)

    expect(diskNode('opened')).toMatchObject({ title: 'Only the title changes now', position: { x: 70, y: 80 } })
  })

  it('does not refuse later moves of a node put in a frame before the first save', async () => {
    const tab = await load()
    await hostAdds(node('opened'))
    const mine = adopt(tab, 'opened', { parentId: 'f', position: { x: 5, y: 5 } })
    await save(tab)

    mine.position = { x: 9, y: 9 }
    await expect(save(tab)).resolves.not.toThrow()
    expect(diskNode('opened')).toMatchObject({ parentId: 'f', position: { x: 9, y: 9 } })

    mine.position = { x: 11, y: 11 }
    await save(tab)
    expect(diskNode('opened')?.position).toEqual({ x: 11, y: 11 })
  })

  it('lands a removal of the adopted node by its next save', async () => {
    const tab = await load()
    await hostAdds(node('opened'))
    adopt(tab, 'opened')
    await save(tab)

    tab.projects[0].nodes = tab.projects[0].nodes.filter((n) => n.id !== 'opened')
    await save(tab)

    expect(diskNode('opened')).toBeUndefined()
  })

  it('does not take a save that predates the adoption for a deletion', async () => {
    const tab = await load()
    await hostAdds(node('opened'))
    tab.projects[0].nodes[0].title = 'Saved before the op arrived'

    await save(tab)

    expect(diskNode('opened')).toBeDefined()
    expect(diskNode('a')?.title).toBe('Saved before the op arrived')
  })
})
