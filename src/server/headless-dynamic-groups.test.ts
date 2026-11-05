import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { initCanvasSync, setReflectedBatchListener, setReflectedListener, setDynamicGroupMetadataResolver } from '../core/canvas-sync'
import { WorkspaceStore } from '../core/workspace-store'
import { FakeHeadlessPty } from '../core/test-headless-pty'
import { testTmpDir } from '../core/test-tmp'
import { HeadlessNodeFactory, createHeadlessNodeOwnership, type HeadlessNodeFactoryDeps } from '../core/headless-node-factory'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type CanvasMutationBatch, type CanvasNodeState, type Workspace } from '../shared/types'

const node = (id: string, x: number): CanvasNodeState => ({ id, kind: 'terminal', agentId: 'codex', title: id,
  position: { x, y: 0 }, size: { width: 640, height: 440 }, color: '#0a84ff', group: null })
const scene = { version: 1, groups: [{ id: 'managed', title: 'Managed', parent: null }],
  members: [{ id: 'a', group: 'managed' }], reserve: [{ id: 'review', group: 'managed', width: 800, height: 600 }] }

describe('host dynamic groups use the canonical project transaction', () => {
  let p: FakePlatform, store: WorkspaceStore, factory: HeadlessNodeFactory, pty: FakeHeadlessPty
  let deps: HeadlessNodeFactoryDeps, batches: CanvasMutationBatch[], dir: string
  const read = async () => (await store.load({ sideline: false })).projects[0]
  const apply = (spec: unknown, extra: Record<string, string> = {}) => factory.groups('source', { spec: JSON.stringify(spec), ...extra }, true)
  beforeEach(async () => {
    dir = testTmpDir('headless-dynamic-'); fs.mkdirSync(path.join(dir, 'data'))
    p = fakePlatform({ userDataDir: path.join(dir, 'data'), isOwnerClient: () => true })
    initPlatform(p); initCanvasSync(); store = new WorkspaceStore(); pty = new FakeHeadlessPty(); batches = []
    await store.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'P', color: '#fff',
      viewport: { x: 99, y: -200, zoom: 0.7 }, nodes: [node('source', -2000), node('a', 0), node('b', 1200)],
      bridges: [{ id: 'context', source: 'a', target: 'b' }], ropes: [{ id: 'lineage', source: 'source', target: 'a' }] }] })
    deps = { workspaceStore: store, ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false }),
      controlScope: 'project', stateOf: () => 'done',
      cliCaps: async () => ({ version: null, sessionIdFlag: false, autoPermissionMode: false, fullscreenTui: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }), codexCaps: async () => ({ approvalValues: null }),
      codexSharedIdentity: async () => false, launchTiming: { quietMs: 0, capMs: 0 } }
    factory = new HeadlessNodeFactory(deps)
    setReflectedBatchListener((_id, batch) => batches.push(batch))
  })
  afterEach(() => { factory.stop(); setReflectedBatchListener(null); setReflectedListener(null); vi.restoreAllMocks(); resetPlatformForTests() })

  it('previews without publication, then applies one batch and converges without changing sessions, links or camera', async () => {
    const before = await read()
    expect(await apply(scene, { 'dry-run': '' })).toMatchObject({ ok: true, result: { status: 'planned' } })
    expect(await read()).toEqual(before); expect(batches).toEqual([])
    expect(await apply(scene)).toMatchObject({ ok: true, result: { status: 'applied', created: ['managed'] } })
    expect(batches).toHaveLength(1)
    const applied = await read()
    expect(applied.nodes.find((n) => n.id === 'a')).toMatchObject({ parentId: 'managed', agentId: 'codex', title: 'a' })
    expect(applied.bridges).toEqual(before.bridges); expect(applied.ropes).toEqual(before.ropes); expect(applied.viewport).toEqual(before.viewport)
    expect(factory.openerOf('managed')).toMatchObject({ sourceNodeId: 'source', projectId: 'p' })
    expect(await apply(scene)).toMatchObject({ ok: true, result: { status: 'unchanged', created: [] } })
    expect(await read()).toEqual(applied); expect(batches).toHaveLength(1)
    expect(pty.creates).toEqual([]); expect(pty.sends).toEqual([]); expect(pty.destroys).toEqual([])
  })

  it('validates all permissions including unchanged ancestors, and never creates a partial frame', async () => {
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps, controlScope: 'creator' })
    const before = await read()
    expect((await apply(scene)).ok).toBe(false)
    expect(await read()).toEqual(before); expect(batches).toEqual([])
    expect(factory.openerOf('managed')).toBeUndefined()
    expect(await factory.groups('source', { spec: JSON.stringify({ version: 1, groups: [{ id: 'empty' }] }) }, false)).toMatchObject({ ok: false })
    expect(await read()).toEqual(before)
  })

  it('rejects invalid references, cycles and cross-project ID collisions before effects', async () => {
    const before = await read()
    for (const spec of [
      { version: 1, groups: [{ id: 'new' }], members: [{ id: 'missing', group: 'new' }] },
      { version: 1, groups: [{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }] },
      { version: 1, groups: [{ id: 'a' }] }
    ]) expect((await apply(spec)).ok).toBe(false)
    expect(await read()).toEqual(before); expect(batches).toEqual([])
    await store.updateWorkspace((ws) => { ws.projects.push({ ...ws.projects[0], id: 'other', nodes: [
      { ...node('collision', 0), kind: 'group' }
    ] }); return ws })
    expect((await apply({ version: 1, groups: [{ id: 'collision' }] })).ok).toBe(false)
    expect((await read()).nodes.some((n) => n.id === 'collision')).toBe(false)
  })

  it('refuses indirect ancestor growth even when the caller owns the target child frame', async () => {
    await store.updateWorkspace((ws) => {
      ws.projects[0].nodes.push(
        { ...node('foreign-parent', 3000), kind: 'group', size: { width: 800, height: 700 } },
        { ...node('owned-child', 28), kind: 'group', parentId: 'foreign-parent', position: { x: 28, y: 62 },
          dynamicGroup: { version: 1, reservations: [] } })
      return ws
    })
    const ownership = createHeadlessNodeOwnership()
    ownership.record('owned-child', { sourceNodeId: 'source', projectId: 'p' })
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps, controlScope: 'creator', ownership })
    const before = await read()
    const result = await apply({ version: 1, reserve: [{ id: 'large', group: 'owned-child', width: 1800, height: 1400 }] })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('foreign-parent') })
    expect(await read()).toEqual(before); expect(batches).toEqual([]); expect(pty.creates).toEqual([])
  })

  it('consumes one slot atomically across two independent factories, without starting anything on the loser', async () => {
    expect((await apply(scene)).ok).toBe(true)
    const secondPty = new FakeHeadlessPty()
    const second = new HeadlessNodeFactory({ ...deps, ptyManager: secondPty })
    try {
      const args = { group: 'managed', reservation: 'review' }
      expect(await factory.openTerminal('source', { ...args, 'dry-run': '' }, true)).toMatchObject({ ok: true })
      const replies = await Promise.all([factory.openTerminal('source', args, true), second.openTerminal('source', args, true)])
      expect(replies.filter((reply) => reply.ok)).toHaveLength(1)
      const after = await read(); const frame = after.nodes.find((n) => n.id === 'managed')!
      const slot = frame.dynamicGroup!.reservations[0]
      expect(slot.state).toBe('consumed'); expect(after.nodes.some((n) => n.id === slot.nodeId)).toBe(true)
      expect(pty.creates.length + secondPty.creates.length).toBe(1)
      expect((await apply(scene)).ok).toBe(true)
      expect((await read()).nodes.find((n) => n.id === 'managed')!.dynamicGroup!.reservations[0]).toEqual(slot)
      expect((await factory.openTerminal('source', args, true)).ok).toBe(false)
    } finally { second.stop() }
  })

  it('rejects bad reservation options in preview and actual open without consuming the slot', async () => {
    await apply(scene); const before = await read()
    for (const args of [
      { reservation: 'review' }, { group: 'managed', reservation: 'missing' },
      { group: 'managed', reservation: 'review', count: '2' }
    ] as Record<string, string>[]) for (const dry of [false, true]) {
      expect((await factory.openTerminal('source', { ...args, ...(dry ? { 'dry-run': '' } : {}) }, true)).ok).toBe(false)
    }
    expect(await read()).toEqual(before); expect(pty.creates).toEqual([])
  })

  it('still opens and arranges groups when an unrelated node names a frame that is gone', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({ ...node('damaged', 3000), parentId: 'group-gone' })
    await store.save(workspace)

    expect(await apply({ version: 1, groups: [{ id: 'managed', title: 'M' }] })).toMatchObject({ ok: true })
    expect(await factory.openTerminal('source', { group: 'managed' }, true)).toMatchObject({ ok: true })

    const stored = (await store.load({ sideline: false })).projects[0].nodes
    expect(stored.find((n) => n.id === 'damaged')).toMatchObject({ parentId: 'group-gone', position: { x: 3000, y: 0 } })
    expect(stored.filter((n) => n.parentId === 'managed')).toHaveLength(1)
  })

  it('keeps context edges from a new grouped agent to its existing dependency', async () => {
    await apply({ version: 1, groups: [{ id: 'managed' }] })
    const result = await factory.openAgent('source', { agent: 'codex', group: 'managed', after: 'a' }, true)
    expect(result.ok).toBe(true)
    const member = (result.result as { id: string }).id
    const project = await read()
    expect(project.bridges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'source', target: member }),
      expect.objectContaining({ source: member, target: 'a' })
    ]))
    expect(project.bridges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'context' })]))
    expect(project.nodes.find((n) => n.id === member)).toMatchObject({ parentId: 'managed' })
  })

  it('restart retains reservation facts but restores no creator proof or automatic launches', async () => {
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps, controlScope: 'creator' })
    expect((await apply({ version: 1, groups: [{ id: 'managed' }], reserve: scene.reserve })).ok).toBe(true)
    const before = await read(); factory.stop(); factory = new HeadlessNodeFactory({ ...deps, controlScope: 'creator' })
    expect(await factory.groups('source', { get: '' }, true)).toMatchObject({ result: { groups: [] } })
    expect((await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)).ok).toBe(false)
    expect(await read()).toEqual(before); expect(pty.creates).toEqual([])
  })

  it('retiring a frame promotes children without closing sessions or removing survivor links', async () => {
    await apply({ version: 1, groups: [{ id: 'managed' }], members: scene.members })
    const before = await read(); const member = before.nodes.find((n) => n.id === 'a')!
    const position = { x: before.nodes.find((n) => n.id === 'managed')!.position.x + member.position.x,
      y: before.nodes.find((n) => n.id === 'managed')!.position.y + member.position.y }
    expect((await apply({ version: 1, remove: [{ id: 'managed', promoteTo: null }] })).ok).toBe(true)
    const after = await read(); expect(after.nodes.find((n) => n.id === 'a')).toMatchObject({ position, agentId: 'codex' })
    expect(after.bridges).toEqual(before.bridges); expect(after.ropes).toEqual(before.ropes)
    expect(pty.creates).toEqual([]); expect(pty.destroys).toEqual([])
  })

  it('legacy resize retains reserved space through one batch, and ungroup/close refuse active slots', async () => {
    await apply(scene)
    const before = await read(); batches.length = 0
    expect((await factory.geometry('resize', 'source', { nodes: 'a', width: '1600', height: '1200' })).ok).toBe(true)
    expect(batches).toHaveLength(1)
    const resized = await read(), a = resized.nodes.find((n) => n.id === 'a')!
    const slot = resized.nodes.find((n) => n.id === 'managed')!.dynamicGroup!.reservations[0]
    expect(a.position.x >= slot.position.x + slot.width || a.position.y >= slot.position.y + slot.height ||
      a.position.x + a.size.width <= slot.position.x || a.position.y + a.size.height <= slot.position.y).toBe(true)
    expect(await factory.geometry('ungroup', 'source', { group: 'managed' })).toMatchObject({ ok: false })
    expect(await factory.close('source', { node: 'managed' }, true)).toMatchObject({ ok: false })
    expect(await read()).toEqual(resized)
    expect((await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)).ok).toBe(true)
    expect((await read()).bridges).toEqual(before.bridges); expect(pty.destroys).toEqual([])
  })

  it('legacy grouping inside a managed frame preserves usable reservations and publishes one batch', async () => {
    await apply(scene); batches.length = 0
    await store.updateWorkspace((workspace) => {
      workspace.projects[0].nodes.find((node) => node.id === 'managed')!.size = { width: 3000, height: 3000 }
      return workspace
    })
    const reply = await factory.group('source', { nodes: 'a', label: 'Nested wrapper' })
    expect(reply.ok).toBe(true); expect(batches).toHaveLength(1)
    const id = (reply.result as { groupId: string }).groupId
    const after = await read()
    expect(after.nodes.find((n) => n.id === 'managed')!.size).toEqual({ width: 3000, height: 3000 })
    expect(after.nodes.find((n) => n.id === 'a')).toMatchObject({ parentId: id, agentId: 'codex' })
    expect(after.nodes.find((n) => n.id === id)).toMatchObject({ parentId: 'managed', dynamicGroup: { version: 1 } })
    expect(factory.openerOf(id)).toMatchObject({ sourceNodeId: 'source' })
    expect((await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)).ok).toBe(true)
    expect(pty.destroys).toEqual([])
  })

  it('rechecks frame close inside the FIFO after a concurrent factory reserves new space', async () => {
    await apply({ version: 1, groups: scene.groups, members: scene.members })
    const second = new HeadlessNodeFactory(deps)
    const update = store.updateWorkspace.bind(store)
    let inject = true
    vi.spyOn(store, 'updateWorkspace').mockImplementation(async (edit, beforeSave) => {
      if (inject) {
        inject = false
        expect((await second.groups('source', { spec: JSON.stringify({ version: 1, reserve: scene.reserve }) }, true)).ok).toBe(true)
      }
      return update(edit, beforeSave)
    })
    try {
      expect(await factory.close('source', { node: 'managed' }, true)).toMatchObject({ ok: false })
      const group = (await read()).nodes.find((n) => n.id === 'managed')!
      expect(group.dynamicGroup!.reservations[0].state).toBe('reserved')
      expect(pty.destroys).toEqual([])
    } finally { second.stop() }
  })

  it('reports committed group/retirement effects as indeterminate if their post-save notification fails', async () => {
    await apply({ version: 1, groups: scene.groups, members: scene.members })
    factory.stop()
    factory = new HeadlessNodeFactory({ ...deps, publishProject: () => { throw new Error('post-save notification lost') } })
    const grouped = await factory.group('source', { nodes: 'a', label: 'Committed subgroup' })
    expect(grouped).toMatchObject({ ok: false, indeterminate: true, error: expect.stringContaining('save-uncertain') })
    expect((await read()).nodes.some((n) => n.id === (grouped.result as { groupId: string }).groupId)).toBe(true)
    expect(await factory.close('source', { node: 'managed' }, true))
      .toMatchObject({ ok: false, indeterminate: true, error: expect.stringContaining('save-uncertain') })
    expect((await read()).nodes.some((n) => n.id === 'managed')).toBe(false)
    expect(pty.destroys).toEqual([])
  })

  it('refuses a connected old client before publication and classifies a lost disk acknowledgement as indeterminate', async () => {
    p.clients.push(12)
    const before = await read(); const refused = await apply(scene)
    expect(refused).toMatchObject({ ok: false, result: { status: 'rejected' } }); expect(refused.indeterminate).not.toBe(true)
    expect(await read()).toEqual(before); expect(batches).toEqual([])
    p.clients.length = 0
    vi.spyOn(store, 'updateWorkspace').mockImplementationOnce(async (edit, beforeSave) => {
      const current = await store.load(); const next = edit(structuredClone(current)); beforeSave?.(current, next)
      throw new Error('disk acknowledgement lost')
    })
    expect(await apply(scene)).toMatchObject({ ok: false, indeterminate: true, result: { status: 'indeterminate' } })
    expect(batches).toHaveLength(1); expect(pty.creates).toEqual([])
  })

  it('carries consumed facts across a stale UI save while retaining an unrelated title edit', async () => {
    store.registerIpc(); await apply(scene)
    const browser = await p.handlers[IPC.workspaceLoad](1) as Workspace
    const reply = await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)
    expect(reply.ok).toBe(true)
    browser.projects[0].nodes.find((n: CanvasNodeState) => n.id === 'b')!.title = 'User note'
    delete browser.projects[0].nodes.find((n: CanvasNodeState) => n.id === 'managed')!.dynamicGroup
    await p.handlers[IPC.workspaceSave](1, browser)
    const after = await read()
    expect(after.nodes.find((n) => n.id === 'managed')!.dynamicGroup!.reservations[0].state).toBe('consumed')
    expect(after.nodes.find((n) => n.id === 'b')!.title).toBe('User note')
    expect(after.nodes).toHaveLength(5)
  })

  it('protects restored facts when no agent-control factory is running', async () => {
    await apply(scene)
    factory.stop(); setDynamicGroupMetadataResolver(null)
    const restored = new WorkspaceStore()
    await restored.load(); restored.registerIpc()
    const held = structuredClone((await read()).nodes.find((n) => n.id === 'managed')!)
    delete held.dynamicGroup
    p.clients.push(1)
    p.senderListeners[IPC.canvasMut](1, 'p', { op: 'upsert', node: held, src: 'stale-ui', seen: 0 })
    const reflected = p.sent.filter((event) => event.channel === IPC.canvasMut)
      .map((event) => event.args[1]).filter((mutation) => mutation.op === 'upsert' && mutation.node.id === 'managed')
    expect(reflected.length).toBeGreaterThan(0)
    expect(reflected.every((mutation) => mutation.node.dynamicGroup.reservations[0].state === 'reserved')).toBe(true)
  })

  it('refuses a stale gesture occupying a newly reserved hole before saving, while accepting ordinary title edits', async () => {
    store.registerIpc()
    await apply({ version: 1, groups: scene.groups, members: scene.members })
    const browser = await p.handlers[IPC.workspaceLoad](1) as Workspace
    browser.projects[0].nodes.find((n) => n.id === 'a')!.position.y = 700
    await apply({ version: 1, reserve: scene.reserve })
    const current = await read()
    await expect(p.handlers[IPC.workspaceSave](1, browser)).rejects.toThrow('workspace-save-group-layout-conflict')
    expect(await read()).toEqual(current)
    const ordinary = await p.handlers[IPC.workspaceLoad](1) as Workspace
    ordinary.projects[0].nodes.find((n) => n.id === 'a')!.title = 'User title'
    await p.handlers[IPC.workspaceSave](1, ordinary)
    expect((await read()).nodes.find((n) => n.id === 'a')!.title).toBe('User title')
    expect((await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)).ok).toBe(true)
  })

  it('a stale UI mutation during batch publication sees the in-flight consumed facts, not the preceding disk snapshot', async () => {
    await apply(scene)
    const stale = structuredClone((await read()).nodes.find((n) => n.id === 'managed')!)
    p.clients.push(1); p.senderListeners[IPC.canvasBatchSubscribe](1, true)
    setReflectedBatchListener((_id, batch) => {
      batches.push(batch)
      p.senderListeners[IPC.canvasMut](1, 'p', { op: 'upsert', node: stale, src: 'old-ui', seen: 0 })
    })
    expect((await factory.openTerminal('source', { group: 'managed', reservation: 'review' }, true)).ok).toBe(true)
    const reflected = p.sent.filter((event) => event.channel === IPC.canvasMut)
      .map((event) => event.args[1]).filter((mutation) => mutation.op === 'upsert' && mutation.node.id === 'managed')
    expect(reflected.length).toBeGreaterThan(0)
    expect(reflected.every((mutation) => mutation.node.dynamicGroup.reservations[0].state === 'consumed')).toBe(true)
  })
})
