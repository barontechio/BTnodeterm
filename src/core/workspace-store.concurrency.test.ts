import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasContentWriter } from './canvas-content-writer'
import { createCanvasAuthority } from './canvas-authority'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from './canvas-sync'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Workspace } from '../shared/types'

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#0a84ff', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }
})

describe('owner saves and host commands share one write queue', () => {
  let platform: FakePlatform
  let store: WorkspaceStore
  let writer: CanvasContentWriter
  let cwd: string
  const load = (owner: number): Promise<Workspace> =>
    Promise.resolve(platform.handlers[IPC.workspaceLoad](owner) as Workspace)
  const save = (owner: number, ws: Workspace): Promise<void> =>
    Promise.resolve(platform.handlers[IPC.workspaceSave](owner, ws) as void)

  beforeEach(async () => {
    const dir = testTmpDir('workspace-concurrent-')
    cwd = path.join(dir, 'project')
    await fs.mkdir(cwd)
    await fs.mkdir(path.join(dir, 'data'))
    platform = fakePlatform({ userDataDir: path.join(dir, 'data'), isOwnerClient: () => true })
    initPlatform(platform)
    store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: 'p', projects: [{
      id: 'p', name: 'Project', cwd, color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a')]
    }] })
    store.registerIpc()
    writer = new CanvasContentWriter({ workspaceStore: store, publishMutation: () => {} })
  })

  afterEach(() => { vi.restoreAllMocks(); resetPlatformForTests() })

  it('keeps independent edits to the same node from two stale owner tabs', async () => {
    const a = await load(1)
    const b = await load(2)
    a.projects[0].nodes[0].position = { x: 400, y: 50 }
    b.projects[0].nodes[0].title = 'Reviewed'
    await Promise.all([save(1, a), save(2, b)])
    expect((await store.load()).projects[0].nodes[0]).toMatchObject({
      title: 'Reviewed', position: { x: 400, y: 50 }
    })
  })

  it('keeps the node an agent created when an old tab autosaves', async () => {
    const browser = await load(1)
    const command = await writer.loadForEdit()
    command.projects[0].nodes.push(node('agent-created'))
    await writer.castAndSave(command)
    browser.projects[0].nodes[0].title = 'User edit'
    await save(1, browser)
    const nodes = (await store.load()).projects[0].nodes
    expect(nodes.map((n) => n.id)).toEqual(['a', 'agent-created'])
    expect(nodes[0].title).toBe('User edit')
  })

  it('rebases a host command after a browser save already queued ahead of it', async () => {
    const command = await writer.loadForEdit()
    const browser = await load(1)
    browser.projects[0].nodes[0].position.x = 900
    const saving = save(1, browser)
    command.projects[0].nodes[0].title = 'Agent name'
    await writer.castAndSave(command)
    await saving
    expect((await store.load()).projects[0].nodes[0]).toMatchObject({
      title: 'Agent name', position: { x: 900, y: 0 }
    })
  })

  it('rebases core changes before publishing into a governed project and keeps the local launch overlay', async () => {
    initCanvasSync()
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set(['p']),
      readContent: (id) => store.readProjectContent(id),
      writeContent: (id, content) => store.writeProjectContent(id, content),
      publish: publishCanvasMutation,
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {}
    })
    store.setContentAuthority(authority)
    setReflectedListener((id, mutation) => authority.onReflected(id, mutation))
    try {
      const commandWriter = new CanvasContentWriter({ workspaceStore: store })
      const command = await commandWriter.loadForEdit()
      publishCanvasMutation('p', { op: 'upsert', node: { ...node('a'), position: { x: 700, y: 40 } } })
      command.projects[0].nodes[0].title = 'Core title'
      command.projects[0].nodes[0].pendingLaunch = { command: 'claude', after: [], executor: 'server' }
      await commandWriter.castAndSave(command)
      expect((await store.load()).projects[0].nodes[0]).toMatchObject({
        title: 'Core title', position: { x: 700, y: 40 }, pendingLaunch: { command: 'claude' }
      })
      const file = JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm', 'project.json'), 'utf8'))
      expect(file.nodes[0].pendingLaunch).toBeUndefined()
    } finally {
      await authority.stop()
      setReflectedListener(null)
      store.setContentAuthority(null)
    }
  })

  it('does not resurrect a host-deleted node when a stale tab edits its title', async () => {
    const browser = await load(1)
    await store.updateWorkspace((fresh) => { fresh.projects[0].nodes = []; return fresh })
    browser.projects[0].nodes[0].title = 'Stale title'
    await save(1, browser)
    expect((await store.load()).projects[0].nodes).toEqual([])
  })

  it('evaluates a delayed patch after queued deletion, not before acquiring the write queue', async () => {
    const browser = await load(1)
    browser.projects[0].nodes = []
    const deleting = save(1, browser)
    const apply = vi.fn(() => true)
    const patching = writer.savePatches([{ projectId: 'p', nodeId: 'a', apply }])
    await deleting
    expect(await patching).toEqual({ saved: false, applied: [false] })
    expect(apply).not.toHaveBeenCalled()
  })

  it('advances one tab baseline inside the queue before its next overlapping save', async () => {
    const first = await load(1)
    first.projects[0].nodes.push(node('new'))
    const second = structuredClone(first)
    second.projects[0].nodes[1].title = 'Edited immediately'
    await Promise.all([save(1, first), save(1, second)])
    expect((await store.load()).projects[0].nodes[1].title).toBe('Edited immediately')
  })

  it('reports a folder write failure and retains the baseline so the same save can recover', async () => {
    const browser = await load(1)
    browser.projects[0].nodes[0].title = 'Recover this edit'
    const rename = fs.rename.bind(fs)
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(cwd, '.nodeterm', 'project.json')) {
        throw Object.assign(new Error('disk write failed'), { code: 'EIO' })
      }
      return rename(from, to)
    })
    await expect(save(1, browser)).rejects.toThrow('disk write failed')
    failure.mockRestore()
    expect((await store.load()).projects[0].nodes[0].title).toBe('a')
    await save(1, browser)
    expect((await store.load()).projects[0].nodes[0].title).toBe('Recover this edit')
  })

  it('keeps another tab baseline when a client disconnects', async () => {
    const a = await load(1)
    const b = await load(2)
    store.forgetClient(1)
    await store.updateWorkspace((fresh) => { fresh.projects[0].nodes.push(node('host')); return fresh })
    b.projects[0].nodes[0].title = 'Still connected'
    await save(2, b)
    expect((await store.load()).projects[0].nodes.map((n) => n.id)).toEqual(['a', 'host'])
    expect(a.projects[0].nodes).toHaveLength(1)
  })

  it('refuses an old queued save across a disconnect or a new load of the same client ID', async () => {
    const beforeDisconnect = await load(1)
    beforeDisconnect.projects[0].nodes[0].title = 'Old connection'
    const queued = save(1, beforeDisconnect)
    store.forgetClient(1)
    await expect(queued).rejects.toThrow('workspace-save-stale-client')
    const beforeReload = await load(1)
    beforeReload.projects[0].nodes[0].title = 'Old page'
    const reloading = load(1)
    const oldPageSave = save(1, beforeReload)
    await reloading
    await expect(oldPageSave).rejects.toThrow('workspace-save-stale-client')
    expect((await store.load()).projects[0].nodes[0].title).toBe('a')
  })
})
