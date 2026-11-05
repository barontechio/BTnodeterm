import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { DEFAULT_SETTINGS, type CanvasMutation, type CanvasNodeState } from '../shared/types'
import { defaultKanbanFor } from '../shared/kanban-default-board'
import { createHeadlessNodeOwnership, HeadlessNodeFactory, type HeadlessNodeFactoryDeps, type HeadlessPty } from './headless-node-factory'

const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', agentId: 'claude', title: id,
  color: '#0a84ff', group: null, position: { x: 10, y: 20 }, size: { width: 640, height: 440 } })

describe('Server board automation', () => {
  let store: WorkspaceStore
  let factory: HeadlessNodeFactory
  let deps: HeadlessNodeFactoryDeps
  let ops: CanvasMutation[]
  let dir: string
  const logs = vi.fn(async () => true)
  const effect = vi.fn(() => { throw new Error('board commands never touch a terminal') })
  const read = async () => (await store.load()).projects[0]
  const ownership = createHeadlessNodeOwnership()

  beforeEach(async () => {
    dir = testTmpDir('headless-board-')
    fs.mkdirSync(path.join(dir, 'data'))
    resetPlatformForTests(); initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') }))
    store = new WorkspaceStore(); ops = []; logs.mockClear(); effect.mockClear(); ownership.clear()
    ownership.record('a', { sourceNodeId: 'src', projectId: 'p' })
    await store.save({ version: 2, activeProjectId: 'p', projects: [{
      id: 'p', name: 'Board', color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('src'), node('a'), node('foreign'), { ...node('image'), kind: 'editor' },
        { ...node('note'), kind: 'sticky', text: '# A note\nbody' }]
    }] })
    const pty: HeadlessPty = { createHeadless: effect, paneCommand: effect, sessionExists: effect,
      sendText: effect, persistentSpawnAvailable: effect, writeHeadless: effect, onOutput: effect,
      releaseHeadless: effect, destroySession: effect }
    deps = { workspaceStore: store, ptyManager: pty, ownership, settings: () => DEFAULT_SETTINGS,
      stateOf: () => undefined, cliCaps: effect, grokCaps: effect, codexCaps: effect,
      codexSharedIdentity: effect, appendBoardLog: logs, publishMutation: (_id, op) => ops.push(op) }
    factory = new HeadlessNodeFactory(deps)
  })
  afterEach(() => { factory.stop(); resetPlatformForTests(); expect(effect).not.toHaveBeenCalled() })

  it('lists only visible cards and keeps the default board lazy on reads', async () => {
    expect(await factory.board('src', {})).toMatchObject({ ok: true, result: { columns: [], ungrouped: ['src', 'a'] } })
    expect((await read()).kanban).toBeUndefined()
    factory = new HeadlessNodeFactory({ ...deps, controlScope: 'project' })
    expect(await factory.board('src', {})).toMatchObject({ ok: true, result: { ungrouped: ['src', 'a', 'foreign', 'note'] } })
  })

  it('lets an agent move its own card, persists the default columns once and logs the move', async () => {
    const before = (await read()).nodes
    const reply = await factory.assign('src', { node: 'src', column: 'in progress' })
    const columnId = defaultKanbanFor('p').columns[1].id
    expect(reply).toMatchObject({ ok: true, result: { node: 'src', column: columnId } })
    expect((await read()).kanban?.assignments).toMatchObject([{ nodeId: 'src', columnId }])
    expect((await read()).nodes).toEqual(before)
    expect(logs).toHaveBeenCalledWith('p', expect.objectContaining({ kind: 'event', nodeId: 'src',
      event: { type: 'card-moved', from: 'Ungrouped', to: 'In Progress' } }))
    const count = ops.length
    await factory.assign('src', { node: 'src', column: 'in progress' })
    expect(ops).toHaveLength(count)
    expect(logs).toHaveBeenCalledTimes(1)
  })

  it('orders before an existing card and preserves labels, metadata and provider mappings', async () => {
    const ws = await store.load()
    const board = defaultKanbanFor('p')
    board.meta = [{ nodeId: 'a', priority: 'urgent', labels: ['label-a'] }]
    board.labels = [{ id: 'label-a', name: 'Keep', color: 'green' }]
    board.github = { repository: 'owner/repo', columnMappings: [] }
    ws.projects[0].kanban = board
    await store.save(ws)
    await factory.assign('src', { node: 'src', column: 'Done' })
    await factory.assign('src', { node: 'a', column: 'Done', before: 'src' })
    const after = (await read()).kanban!
    expect(after.assignments.map((a) => a.nodeId)).toEqual(['a', 'src'])
    expect(after).toMatchObject({ meta: board.meta, labels: board.labels, github: board.github })
    expect(await factory.board('src', {})).toMatchObject({ result: { columns: [
      { cards: [] }, { cards: [] }, { cards: ['a', 'src'] }
    ] } })
    await factory.assign('src', { node: 'a', column: 'ungrouped' })
    expect((await read()).kanban!.assignments.map((a) => a.nodeId)).toEqual(['src'])
  })

  it('keeps simultaneous assignments to separate cards', async () => {
    await Promise.all([
      factory.assign('src', { node: 'src', column: 'To Do' }),
      new HeadlessNodeFactory(deps).assign('src', { node: 'a', column: 'In Progress' })
    ])
    const board = (await read()).kanban!
    expect(board.columns).toHaveLength(3)
    expect(board.assignments.map((a) => a.nodeId).sort()).toEqual(['a', 'src'])
  })

  it('refuses foreign projects, invisible cards, provider cards and unsupported flags before writing', async () => {
    const before = await store.load()
    const calls: Record<string, string>[] = [{ node: 'foreign', column: 'Done' }, { node: 'image', column: 'Done' },
      { node: 'a', column: 'Unknown' }, { node: 'a', column: 'Done', before: 'foreign' },
      { node: 'a', column: 'Done', source: 'github' }]
    for (const args of calls) {
      expect(await factory.assign('src', args)).toMatchObject({ ok: false })
    }
    expect(await factory.board('src', { project: 'other' })).toMatchObject({ ok: false })
    expect(await store.load()).toEqual(before)
    expect(ops).toEqual([]); expect(logs).not.toHaveBeenCalled()
  })

  it('persists an image editor and its opener without launching a session', async () => {
    const imagePath = path.join(dir, 'picture.png')
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHlcAAAAASUVORK5CYII=', 'base64'))
    const before = (await read()).nodes
    const reply = await factory.showImage('src', { path: imagePath }, true)
    expect(reply.ok).toBe(true)
    const p = await read()
    const image = p.nodes.find((n) => n.kind === 'editor' && n.filePath === imagePath)!
    expect(image).toMatchObject({ title: 'picture.png', openedBy: 'src', size: { width: 660, height: 460 } })
    expect(p.nodes.filter((n) => n.id !== image.id)).toEqual(before)
    expect(p.ropes).toMatchObject([{ source: 'src', target: image.id }])
    expect(factory.openerOf(image.id)).toEqual({ sourceNodeId: 'src', projectId: 'p' })
    expect(image.pendingLaunch).toBeUndefined()
    expect(ops).toContainEqual({ op: 'upsert', node: image })
  })

  it('refuses inaccessible image sources, unknown flags and unverified callers without creating nodes', async () => {
    const before = await store.load()
    const missing = path.join(dir, 'missing.png')
    const directory = path.join(dir, 'directory.png'); fs.mkdirSync(directory)
    const calls: Record<string, string>[] = [{ path: missing }, { path: directory }, { path: 'file.txt' }, { path: 'relative.png' }, { path: missing, project: 'other' }]
    for (const args of calls) {
      expect(await factory.showImage('src', args, true)).toMatchObject({ ok: false })
    }
    expect(await factory.showImage('src', { path: missing }, false)).toMatchObject({ ok: false, error: expect.stringContaining('identity-refused') })
    expect(await store.load()).toEqual(before); expect(ops).toEqual([])
  })

  it('never reads a local same-named image for a remote source', async () => {
    const imagePath = path.join(dir, 'picture.png'); fs.writeFileSync(imagePath, 'local image')
    const ws = await store.load(); ws.projects[0].nodes[0].sshRemoteTmux = true; await store.save(ws)
    expect(await factory.showImage('src', { path: imagePath }, true)).toMatchObject({ ok: false, error: expect.stringContaining('host-refused') })
    expect((await read()).nodes).toHaveLength(5); expect(ops).toEqual([])
  })

  it('refuses a source path replaced after open and closes its descriptor without saving a node', async () => {
    const file = path.join(dir, 'raced.png'); fs.writeFileSync(file, 'original image')
    const before = await store.load(); const open = fs.promises.open.bind(fs.promises)
    let swapped = false; let previewHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined
    const intercepted = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args)
      if (String(args[0]) === file && !swapped) {
        previewHandle = handle; swapped = true; fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'replacement')
      }
      return handle
    })
    try {
      expect(await factory.showImage('src', { path: file }, true)).toMatchObject({ ok: false, error: expect.stringContaining('file-refused') })
      expect(swapped).toBe(true); expect(previewHandle?.fd).toBe(-1)
      expect(await store.load()).toEqual(before); expect(ops).toEqual([])
    } finally { intercepted.mockRestore() }
  })

  it.skipIf(process.platform === 'win32')('refuses a final symbolic link without creating an image node', async () => {
    const file = path.join(dir, 'actual.png'); fs.writeFileSync(file, 'image')
    const link = path.join(dir, 'linked.png'); fs.symlinkSync(file, link)
    const before = await store.load()
    expect(await factory.showImage('src', { path: link }, true)).toMatchObject({ ok: false, error: expect.stringContaining('file-refused') })
    expect(await store.load()).toEqual(before)
  })
})
