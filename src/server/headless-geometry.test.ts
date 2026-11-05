import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { createCanvasAuthority } from '../core/canvas-authority'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from '../core/canvas-sync'
import { DEFAULT_SETTINGS, type CanvasMutation, type CanvasNodeState, type Workspace } from '../shared/types'
import { createHeadlessNodeOwnership, HeadlessNodeFactory, type HeadlessNodeFactoryDeps, type HeadlessPty } from './headless-node-factory'

const node = (id: string, x = 0, y = 0): CanvasNodeState => ({
  id, kind: 'terminal', position: { x, y }, size: { width: 640, height: 440 },
  title: id, color: '#0a84ff', group: null, agentId: 'claude'
})
const frame = (id: string): CanvasNodeState => ({ ...node(id), kind: 'group', agentId: undefined })

describe('Server geometry without an attached renderer', () => {
  let store: WorkspaceStore
  let factory: HeadlessNodeFactory
  let deps: HeadlessNodeFactoryDeps
  let ops: CanvasMutation[]
  let dir: string
  const ownership = createHeadlessNodeOwnership()
  const effect = vi.fn(() => { throw new Error('geometry must not touch a terminal') })
  const read = async () => (await store.load()).projects[0]
  const change = async (edit: (workspace: Workspace) => void) => {
    const ws = await store.load(); edit(ws); await store.save(ws)
  }
  const own = (...ids: string[]) => ids.forEach((id) => ownership.record(id, { sourceNodeId: 'src', projectId: 'p' }))

  beforeEach(async () => {
    dir = testTmpDir('headless-geometry-')
    fs.mkdirSync(path.join(dir, 'data'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') }))
    store = new WorkspaceStore()
    ops = []; ownership.clear(); effect.mockClear()
    await store.save({ version: 2, activeProjectId: 'p', projects: [{
      id: 'p', name: 'Geometry', color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('src', -2000), node('a', 100, 200), node('b', 1000, 900)]
    }] })
    const pty: HeadlessPty = {
      createHeadless: effect, paneCommand: effect, sessionExists: effect, sendText: effect,
      persistentSpawnAvailable: effect, writeHeadless: effect, onOutput: effect,
      releaseHeadless: effect, destroySession: effect
    }
    deps = { workspaceStore: store, ptyManager: pty, ownership,
      settings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false }), stateOf: () => undefined,
      cliCaps: effect, grokCaps: effect, codexCaps: effect, codexSharedIdentity: effect,
      publishMutation: (_id, op) => ops.push(op) }
    factory = new HeadlessNodeFactory(deps)
    own('a', 'b')
  })
  afterEach(() => { factory.stop(); resetPlatformForTests(); expect(effect).not.toHaveBeenCalled() })

  it('resizes and places while preserving launch, identity and future metadata', async () => {
    await change((ws) => Object.assign(ws.projects[0].nodes[1], {
      titleAuto: false, tags: ['preserve'], accountId: 'account-a', openedBy: 'src',
      pendingLaunch: { command: 'opaque future claim' }, futureField: { untouched: true }
    }))
    const before = (await read()).nodes[1]
    expect(await factory.geometry('resize', 'src', { nodes: 'a', width: '700', height: '500' })).toMatchObject({ ok: true })
    expect(await factory.geometry('place', 'src', { nodes: 'a', x: '0', y: '-20' })).toMatchObject({ ok: true })
    expect((await read()).nodes[1]).toEqual({ ...before, position: { x: 0, y: -20 }, size: { width: 700, height: 500 } })
    expect(ops.filter((op) => op.op === 'upsert')).toHaveLength(2)
  })

  it('applies arrangement gap and alignment with Desktop replies', async () => {
    expect(await factory.geometry('arrange', 'src', { nodes: 'a,b', layout: 'row', gap: '19' })).toMatchObject({ ok: true })
    let p = await read()
    expect(p.nodes.find((n) => n.id === 'b')!.position.x - p.nodes.find((n) => n.id === 'a')!.position.x).toBe(659)
    expect(await factory.geometry('align', 'src', { nodes: 'a,b', edge: 'left' })).toMatchObject({ ok: true })
    p = await read()
    expect(p.nodes.find((n) => n.id === 'b')!.position.x).toBe(p.nodes.find((n) => n.id === 'a')!.position.x)
  })

  it('moves into and out of frames, then ungroups and prunes only that frame edges', async () => {
    await change((ws) => { ws.projects[0].nodes.push(frame('g')); ws.projects[0].ropes = [
      { id: 'r1', source: 'src', target: 'g' }, { id: 'r2', source: 'src', target: 'a' }
    ] })
    own('g')
    expect(await factory.geometry('move', 'src', { nodes: 'a,b', group: 'g' })).toMatchObject({ ok: true })
    expect((await read()).nodes.find((n) => n.id === 'a')!.parentId).toBe('g')
    expect(await factory.geometry('move', 'src', { nodes: 'b', group: 'top' })).toMatchObject({ ok: true })
    expect((await read()).nodes.find((n) => n.id === 'b')!.parentId).toBeUndefined()
    expect(await factory.geometry('ungroup', 'src', { group: 'g' })).toMatchObject({ ok: true, result: { freed: ['a'] } })
    const p = await read()
    expect(p.nodes.map((n) => n.id)).not.toContain('g')
    expect(p.nodes.every((n) => !n.parentId)).toBe(true)
    expect(p.ropes).toEqual([{ id: 'r2', source: 'src', target: 'a' }])
  })

  it('keeps a collapsed node header-only while changing its expanded height', async () => {
    await change((ws) => { ws.projects[0].nodes[1].collapsed = true })
    expect(await factory.geometry('resize', 'src', { nodes: 'a', height: '800' })).toMatchObject({ ok: true })
    expect((await read()).nodes[1]).toMatchObject({ collapsed: true, size: { height: 800 } })
  })

  it('restores maximized geometry before applying a new size', async () => {
    await change((ws) => { ws.projects[0].nodes[1].premaxRect = { x: 12, y: 34, width: 640, height: 440 } })
    expect(await factory.geometry('resize', 'src', { nodes: 'a', width: '720' })).toMatchObject({ ok: true })
    expect((await read()).nodes[1]).toMatchObject({ position: { x: 12, y: 34 }, size: { width: 720, height: 440 } })
    expect((await read()).nodes[1].premaxRect).toBeUndefined()
  })

  it.each([
    ['place', { nodes: 'a', x: 'bad', y: '0' }], ['resize', { nodes: 'a', width: '-1' }],
    ['move', { nodes: 'a', x: '1' }], ['arrange', { nodes: 'a', group: 'top' }],
    ['align', { nodes: 'a,b', edge: 'garbage' }], ['place', { nodes: 'a', dx: '2', 'dry-run': '' }]
  ] as const)('refuses malformed %s without publishing or saving', async (verb, args) => {
    const before = await store.load()
    expect(await factory.geometry(verb, 'src', args)).toMatchObject({ ok: false })
    expect(await store.load()).toEqual(before)
    expect(ops).toEqual([])
  })

  it('checks the whole affected subtree before any write', async () => {
    await change((ws) => { ws.projects[0].nodes.push(frame('g')); ws.projects[0].nodes[2].parentId = 'g' })
    ownership.forget('b'); own('g')
    const before = await store.load()
    expect(await factory.geometry('place', 'src', { nodes: 'g', dx: '20' })).toMatchObject({ ok: false, error: expect.stringContaining('not-owner') })
    expect(await store.load()).toEqual(before)
    expect(ops).toEqual([])
  })

  it('refuses a parent refit that would modify a foreign frame', async () => {
    await change((ws) => { ws.projects[0].nodes.push(frame('g')); ws.projects[0].nodes[1].parentId = 'g' })
    expect(await factory.geometry('resize', 'src', { nodes: 'a', width: '720' })).toMatchObject({ ok: false, error: expect.stringContaining('not-owner') })
    expect(ops).toEqual([])
  })

  it('admits project scope and refuses cloned ids even with creator proof', async () => {
    ownership.forget('a')
    factory = new HeadlessNodeFactory({ ...deps, controlScope: 'project' })
    expect(await factory.geometry('place', 'src', { nodes: 'a', dx: '5' })).toMatchObject({ ok: true })
    own('a')
    await change((ws) => { ws.projects.push({ ...ws.projects[0], id: 'p2', nodes: [node('a')] }) })
    const before = await store.load()
    expect(await factory.geometry('place', 'src', { nodes: 'a', dx: '5' })).toMatchObject({ ok: false, error: expect.stringContaining('project-refused') })
    expect(await store.load()).toEqual(before)
  })

  it('does not write a no-op or a malformed parent cycle', async () => {
    expect(await factory.geometry('resize', 'src', { nodes: 'a', width: '640' })).toMatchObject({ ok: true })
    expect(ops).toEqual([])
    await change((ws) => { const g = frame('g'); g.parentId = 'g'; ws.projects[0].nodes.push(g) })
    expect(await factory.geometry('place', 'src', { nodes: 'a', dx: '5' })).toMatchObject({ ok: false, error: expect.stringContaining('geometry-invalid-scene') })
    expect(ops).toEqual([])
  })

  it('plans relative placement after an earlier queued edit rather than overwriting it', async () => {
    const earlier = store.updateWorkspace((fresh) => {
      fresh.projects[0].nodes[1].position.x = 700
      fresh.projects[0].nodes[1].title = 'User title'
      return fresh
    })
    const placed = factory.geometry('place', 'src', { nodes: 'a', dx: '20' })
    await earlier
    expect(await placed).toMatchObject({ ok: true })
    expect((await read()).nodes[1]).toMatchObject({ position: { x: 720, y: 200 }, title: 'User title' })
  })

  it('reflects geometry into the shared authority before its save overlay', async () => {
    initCanvasSync()
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set(['p']), readContent: (id) => store.readProjectContent(id),
      writeContent: (id, content) => store.writeProjectContent(id, content), publish: publishCanvasMutation,
      setTimer: () => null, clearTimer: () => {}, log: () => {}
    })
    store.setContentAuthority(authority)
    setReflectedListener((id, op) => authority.onReflected(id, op))
    factory = new HeadlessNodeFactory({ ...deps, publishMutation: publishCanvasMutation })
    try {
      expect(await factory.geometry('place', 'src', { nodes: 'a', dx: '20' })).toMatchObject({ ok: true })
      expect((await read()).nodes[1].position.x).toBe(120)
    } finally {
      await authority.stop(); store.setContentAuthority(null); setReflectedListener(null)
    }
  })

  it('reports uncertain persistence after reflection and prevents automatic replay advice', async () => {
    const save = vi.spyOn(store, 'updateWorkspace')
    save.mockImplementationOnce(async (edit, beforeSave) => {
      const current = await store.load()
      const next = edit(structuredClone(current))
      beforeSave?.(current, next)
      throw new Error('disk full')
    })
    expect(await factory.geometry('place', 'src', { nodes: 'a', dx: '20' })).toMatchObject({
      ok: false, error: expect.stringContaining('save-uncertain: inspect list --geometry on before repeating')
    })
    expect(ops).not.toEqual([])
    save.mockRestore()
  })
})
