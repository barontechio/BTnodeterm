import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasContentWriter, CanvasBatchWriteError } from './canvas-content-writer'
import { WorkspaceStore } from './workspace-store'
import { createCanvasAuthority } from './canvas-authority'
import { initCanvasSync, setReflectedListener, setReflectedBatchListener } from './canvas-sync'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import type { CanvasMutationBatch, CanvasNodeState, Workspace } from '../shared/types'

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#fff', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }
})
describe('canonical FIFO batch writer', () => {
  let store: WorkspaceStore
  let writer: CanvasContentWriter
  let batches: CanvasMutationBatch[]
  let cwd: string
  beforeEach(async () => {
    const dir = testTmpDir('canvas-batch-writer-')
    cwd = path.join(dir, 'project')
    await fs.mkdir(cwd); await fs.mkdir(path.join(dir, 'data'))
    initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') })); initCanvasSync()
    store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: 'P', projects: [{
      id: 'P', name: 'P', color: '#fff', cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a')]
    }] })
    batches = []
    writer = new CanvasContentWriter({ workspaceStore: store,
      preflightBatch: () => ({ ok: true }), publishBatch: (_id, batch) => { batches.push(batch); return true } })
  })
  afterEach(() => { setReflectedListener(null); setReflectedBatchListener(null); vi.restoreAllMocks(); resetPlatformForTests() })

  it('plans against the preceding FIFO edit and publishes one detached diff for the whole transformation', async () => {
    const earlier = store.updateWorkspace((fresh) => {
      fresh.projects[0].nodes[0].position.x = 900
      return fresh
    })
    const edited = writer.editBatch((fresh) => {
      expect(fresh.projects[0].nodes[0].position.x).toBe(900)
      fresh.projects[0].nodes[0].title = 'New title'
      fresh.projects[0].nodes.push({ ...node('frame'), kind: 'group' })
      fresh.projects[0].nodes[0].parentId = 'frame'
      return 'applied'
    })
    await earlier; expect(await edited).toEqual({ value: 'applied', saved: true })
    expect(batches).toHaveLength(1); expect(batches[0].mutations).toHaveLength(2)
    expect((await store.load()).projects[0].nodes[0]).toMatchObject({ title: 'New title', parentId: 'frame', position: { x: 900 } })
  })

  it('a no-op or preview that only computes a value neither saves nor publishes', async () => {
    const before = await fs.readFile(path.join(cwd, '.nodeterm', 'project.json'), 'utf8')
    const stamp = (await fs.stat(path.join(cwd, '.nodeterm', 'project.json'))).mtimeMs
    expect(await writer.editBatch((fresh) => ({ previewIds: fresh.projects[0].nodes.map((n) => n.id) }))).toEqual({
      value: { previewIds: ['a'] }, saved: false
    })
    expect(batches).toEqual([])
    expect(await fs.readFile(path.join(cwd, '.nodeterm', 'project.json'), 'utf8')).toBe(before)
    expect((await fs.stat(path.join(cwd, '.nodeterm', 'project.json'))).mtimeMs).toBe(stamp)
  })

  it('does not persist a semantic no-op consisting of node array reordering', async () => {
    await store.updateWorkspace((fresh) => { fresh.projects[0].nodes.push(node('b')); return fresh })
    expect(await writer.editBatch((fresh) => { fresh.projects[0].nodes.reverse() })).toEqual({ value: undefined, saved: false })
    expect((await store.load()).projects[0].nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(batches).toEqual([])
  })

  it('rejects compatibility failures, invalid diffs and callback authorization errors without publication or saved effects', async () => {
    const before = await store.load()
    const denied = new CanvasContentWriter({ workspaceStore: store,
      preflightBatch: () => ({ ok: false, error: 'canvas-batch-client-incompatible' }),
      publishBatch: () => { throw new Error('must not publish') } })
    await expect(denied.editBatch((fresh) => { fresh.projects[0].nodes.push(node('b')) }))
      .rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-client-incompatible' })
    await expect(writer.editBatch((fresh) => { fresh.projects[0].nodes[0].position.x = NaN }))
      .rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-invalid' })
    await expect(writer.editBatch((fresh) => { fresh.projects[0].nodes.push(node('b')); throw new Error('not-owner') }))
      .rejects.toMatchObject({ indeterminate: false, message: 'not-owner' })
    expect(batches).toEqual([]); expect((await store.load()).projects).toEqual(before.projects)
  })

  it('refuses multiple changed projects and changes to camera/metadata before emitting a batch', async () => {
    await store.updateWorkspace((fresh) => {
      fresh.projects.push({ ...fresh.projects[0], id: 'Q', cwd: undefined, nodes: [node('q')] }); return fresh
    })
    await expect(writer.editBatch((fresh) => { fresh.projects.forEach((p) => { p.nodes[0].title = 'changed' }) }))
      .rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-project-local-only' })
    await expect(writer.editBatch((fresh) => { fresh.projects[0].viewport.x = 100 }))
      .rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-content-only' })
    expect(batches).toEqual([])
  })

  it('requires the real FIFO API rather than using a racy load/save fallback', async () => {
    const legacy = new CanvasContentWriter({ workspaceStore: { load: store.load.bind(store), save: store.save.bind(store) } })
    await expect(legacy.editBatch(() => {})).rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-fifo-unavailable' })
  })

  it('a publisher false is a pre-effect refusal but a thrown publisher/storage error is indeterminate', async () => {
    const denied = new CanvasContentWriter({ workspaceStore: store, preflightBatch: () => ({ ok: true }), publishBatch: () => false })
    await expect(denied.editBatch((fresh) => { fresh.projects[0].nodes.push(node('b')) }))
      .rejects.toMatchObject({ indeterminate: false, message: 'canvas-batch-publication-refused' })
    const broken = new CanvasContentWriter({ workspaceStore: store, preflightBatch: () => ({ ok: true }),
      publishBatch: () => { throw new Error('transport failed after dispatch') } })
    await expect(broken.editBatch((fresh) => { fresh.projects[0].nodes.push(node('b')) }))
      .rejects.toMatchObject({ indeterminate: true })
    // Fail persistence after the reflected batch already reached authority/clients.
    const update = store.updateWorkspace.bind(store)
    vi.spyOn(store, 'updateWorkspace').mockImplementation((edit, beforeSave) => update(edit, (current, next) => {
      beforeSave?.(current, next); throw new Error('disk unavailable after publication')
    }))
    try { await writer.editBatch((fresh) => { fresh.projects[0].nodes.push(node('b')) }); throw new Error('expected failure') }
    catch (error) {
      expect(error).toBeInstanceOf(CanvasBatchWriteError)
      expect(error).toMatchObject({ indeterminate: true, message: 'disk unavailable after publication' })
    }
    expect(batches).toHaveLength(1)
  })

  it('reflects the complete batch before authority overlays save, preserving private fields and reservation metadata', async () => {
    const authority = createCanvasAuthority({ sharedProjectIds: () => new Set(['P']),
      readContent: (id) => store.readProjectContent(id), writeContent: (id, c) => store.writeProjectContent(id, c),
      publish: () => {}, setTimer: () => null, clearTimer: () => {} })
    store.setContentAuthority(authority)
    setReflectedListener(authority.onReflected); setReflectedBatchListener(authority.onReflectedBatch)
    const host = new CanvasContentWriter({ workspaceStore: store })
    try {
      await host.editBatch((fresh) => {
        fresh.projects[0].nodes.push({ ...node('frame'), kind: 'group', dynamicGroup: { version: 1, reservations: [] } })
        fresh.projects[0].nodes[0].parentId = 'frame'
        fresh.projects[0].nodes[0].pendingLaunch = { after: [], command: 'private-command', executor: 'server' }
      })
      const saved = (await store.load()).projects[0]
      expect(saved.nodes.find((n) => n.id === 'a')).toMatchObject({ parentId: 'frame', pendingLaunch: { command: 'private-command' } })
      expect(saved.nodes.find((n) => n.id === 'frame')?.dynamicGroup).toEqual({ version: 1, reservations: [] })
      expect(await fs.readFile(path.join(cwd, '.nodeterm', 'project.json'), 'utf8')).not.toContain('private-command')
    } finally { await authority.stop(); store.setContentAuthority(null) }
  })
})
