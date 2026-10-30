import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { CanvasContentWriter } from './canvas-content-writer'
import { CanvasExecutionReservations } from './canvas-execution-reservations'
import { NodeExecutionCoordinator } from './node-execution'
import { OwnerLifetimes } from './owner-lifetimes'
import { contentOf } from '../shared/canvas-content'
import { initCanvasSync, publishCanvasMutation, setCanvasMutationObserver } from './canvas-sync'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let dir: string
let root: string
const groupId = 'group-worktree'
const memberId = 'term-abc-123'
const node = (id: string, more: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', title: id, position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
  color: '#fff', group: null, ...more
})
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-canvas-execution-'))
  root = path.join(dir, 'repo'); await fs.mkdir(root)
  await fs.mkdir(path.join(dir, 'data'))
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') })); initCanvasSync()
})
afterEach(async () => { resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })

async function fixture(kind: 'folder' | 'app-data' | 'inline' = 'folder') {
  const project: Project = {
    id: 'project-reservations', name: 'Work', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 },
    ...(kind !== 'inline' ? { cwd: root } : {}), ...(kind === 'app-data' ? { storeInAppData: true } : {}),
    nodes: [node(groupId, { kind: 'group', cwd: path.join(root, 'checkout') }),
      node(memberId, { parentId: groupId, cwd: path.join(root, 'checkout'), shell: '/bin/bash', accountId: 'account-a' }),
      node('outside', { cwd: root })]
  }
  const workspace: Workspace = { version: 2, activeProjectId: project.id, projects: [project] }
  const store = new WorkspaceStore(); await store.save(workspace)
  const reservations = new CanvasExecutionReservations({
    project: (id) => store.projectExecutionLocation(id),
    node: (projectId, id) => store.projectIdsForNode(id).includes(projectId) ? store.getNodeForHostAction(id) : undefined
  })
  setCanvasMutationObserver((projectId, mutation, trusted) => reservations.onReflected(projectId, mutation, trusted))
  store.setExecutionAdmission(reservations)
  const publish = vi.fn(publishCanvasMutation)
  const writer = new CanvasContentWriter({ workspaceStore: store, publishMutation: publish })
  const coordinator = new NodeExecutionCoordinator()
  const file = kind === 'folder' ? path.join(root, '.nodeterm/project.json') :
    path.join(dir, 'data/inline-projects/project-reservations.json')
  return { project, store, writer, reservations, coordinator, publish, file }
}

describe('canvas metadata during a claimed host operation', () => {
  for (const kind of ['folder', 'app-data', 'inline'] as const) {
    it(`keeps execution bindings and storage in ${kind}, while allowing layout and unrelated edits`, async () => {
      const { project, store, writer, reservations, coordinator, publish, file } = await fixture(kind)
      await coordinator.runMany([groupId, memberId], 'worktree', { current: () => true }, async (permit) => {
        const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
        try {
          expect(() => reservations.assertCurrent()).not.toThrow()
          const before = await fs.readFile(file, 'utf8')
          await expect(writer.edit((fresh) => { fresh.projects[0].nodes[1].cwd = root })).rejects.toThrow('reserved')
          expect(publish).not.toHaveBeenCalled()
          expect(await fs.readFile(file, 'utf8')).toBe(before)
          await expect(store.updateWorkspace((fresh) => ({ ...fresh, projects: [] }))).rejects.toThrow('reserved')
          await expect(store.updateWorkspace((fresh) => {
            fresh.projects[0].cwd = path.join(root, 'other'); return fresh
          })).rejects.toThrow('reserved')
          await expect(store.prepareFolderStorage(project.id)).rejects.toThrow('reserved')
          await expect(store.releaseFolderFiles(project.id, false)).rejects.toThrow('reserved')
          await writer.edit((fresh) => {
            fresh.projects[0].nodes[1].position.x = 500
            fresh.projects[0].nodes[2].cwd = path.join(root, 'other')
          })
          expect(store.getNodeForHostAction(memberId)).toMatchObject({ position: { x: 500 }, shell: '/bin/bash', accountId: 'account-a' })
          expect(() => reservations.assertCurrent()).not.toThrow()
          await expect(writer.edit((fresh) => {
            fresh.projects[0].nodes.push(node('new', { parentId: groupId }))
          })).rejects.toThrow('reserved')
          await expect(writer.edit((fresh) => { fresh.projects[0].nodes[2].parentId = groupId })).rejects.toThrow('reserved')
        } finally { fence.release() }
      })
      await writer.edit((fresh) => { fresh.projects[0].nodes[1].cwd = root })
      expect(store.getNodeForHostAction(memberId)?.cwd).toBe(root)
    })
  }

  it('rejects authority flushes and phone removals before file publication, including app-data canvases', async () => {
    for (const kind of ['folder', 'app-data'] as const) {
      const { store, writer, reservations, coordinator, project, file } = await fixture(kind)
      await coordinator.runMany([groupId, memberId], 'worktree', { current: () => true }, async (permit) => {
        const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
        try {
          const current = (await store.load()).projects[0]
          const changed = structuredClone(current); changed.nodes[1].accountId = 'account-b'
          const before = await fs.readFile(file, 'utf8')
          await expect(store.writeProjectContent(project.id, contentOf(changed))).rejects.toThrow('reserved')
          await expect(store.removeRemoteNode(memberId)).rejects.toThrow('reserved')
          expect(await fs.readFile(file, 'utf8')).toBe(before)
          const moved = structuredClone(current); moved.nodes[0].position.x = 900
          await expect(store.writeProjectContent(project.id, contentOf(moved))).resolves.toBe(true)
          expect(() => reservations.assertCurrent()).not.toThrow()
        } finally { fence.release() }
      })
    }
  })

  it('orders acquisition with queued storage changes and refuses before publishing a conflicting Core edit', async () => {
    const { store, writer, reservations, coordinator, publish } = await fixture('app-data')
    await coordinator.runMany([groupId, memberId], 'worktree', { current: () => true }, async (permit) => {
      const claim = writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
      const move = store.prepareFolderStorage('project-reservations')
      void move.catch(() => {})
      const { value: fence } = await claim
      try {
        await expect(move).rejects.toThrow('reserved')
        await expect(writer.edit((fresh) => { fresh.projects[0].nodes.splice(1, 1) })).rejects.toThrow('reserved')
        expect(publish).not.toHaveBeenCalled()
      } finally { fence.release() }
    })
  })

  it('corrects conflicting optimistic edits without losing a permitted visual edit or exposing private launch state', async () => {
    const { store, writer, reservations, coordinator, project } = await fixture()
    await coordinator.runMany([groupId, memberId], 'worktree', { current: () => true }, async (permit) => {
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
      try {
        const peer = store.getNodeForHostAction(memberId)!; delete peer.shell
        peer.position.x = 700
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: peer }, false)).toBeNull()
        publishCanvasMutation(project.id, { op: 'upsert', node: peer }, { trusted: false })
        const changed = { ...peer, cwd: root }
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: changed }, true)).toMatchObject({
          canonical: { op: 'upsert', node: { cwd: path.join(root, 'checkout'), position: { x: 700 } } }
        })
        expect(reservations.inspectClient(project.id, { op: 'remove', id: memberId }, false)).toMatchObject({ canonical: { op: 'upsert' } })
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: node('fresh', { parentId: groupId }) }, true)).toMatchObject({
          canonical: { op: 'remove', id: 'fresh' }
        })
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: node('outside', { parentId: groupId }) }, true)).toMatchObject({
          canonical: { op: 'upsert', node: { id: 'outside', cwd: root } }
        })
      } finally { fence.release() }
    })
  })

  it('uses accepted Core layout changes when correcting a later refused removal', async () => {
    const { writer, reservations, coordinator, project } = await fixture()
    await coordinator.runMany([groupId, memberId], 'worktree', { current: () => true }, async (permit) => {
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
      try {
        const visual = structuredClone(project.nodes[1]); visual.position.x = 950
        publishCanvasMutation(project.id, { op: 'upsert', node: visual })
        expect(reservations.inspectClient(project.id, { op: 'remove', id: memberId }, true)).toMatchObject({
          canonical: { op: 'upsert', node: { position: { x: 950 } } }
        })
      } finally { fence.release() }
    })
  })

  it('holds metadata after owner departure until the dispatched operation settles', async () => {
    const { writer, reservations, coordinator } = await fixture()
    const owner = new OwnerLifetimes(); const acquired = deferred(); const settle = deferred()
    const action = coordinator.runMany([groupId, memberId], 'worktree', { current: () => true, owner: owner.get(1, () => true) }, async (permit) => {
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [groupId, memberId], permit))
      acquired.resolve()
      try { await settle.promise } finally { fence.release() }
    })
    void action.catch(() => {}); await acquired.promise; owner.forget(1)
    await expect(writer.edit((fresh) => { fresh.projects[0].nodes[1].accountId = 'replacement' })).rejects.toThrow('reserved')
    expect(reservations.active()).toBe(true)
    settle.resolve(); await expect(action).rejects.toThrow('expired')
    expect(reservations.active()).toBe(false)
  })

  it('cannot introduce another placement of a held node through the phone registrar', async () => {
    const { store, writer, reservations, coordinator, project } = await fixture()
    const otherRoot = path.join(dir, 'other-repo'); await fs.mkdir(otherRoot)
    await writer.edit((fresh) => {
      fresh.projects.push({ ...structuredClone(project), id: 'project-other', cwd: otherRoot, nodes: [] })
    })
    const otherFile = path.join(otherRoot, '.nodeterm/project.json')
    const before = await fs.readFile(otherFile, 'utf8')
    await coordinator.runMany([memberId], 'worktree', { current: () => true }, async (permit) => {
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [memberId], permit))
      try {
        await expect(store.appendRemoteNode('project-other', { id: memberId })).rejects.toThrow('ambiguous')
        expect(await fs.readFile(otherFile, 'utf8')).toBe(before)
      } finally { fence.release() }
    })
  })

  it('keeps the private held launch on peer layout edits and refuses owner launch changes while reserved', async () => {
    const { store, writer, reservations, coordinator, project } = await fixture()
    await writer.edit((fresh) => {
      fresh.projects[0].nodes[1].pendingLaunch = { command: 'claude', after: [], executor: 'core', manualOnly: true }
    })
    await coordinator.runMany([memberId], 'worktree', { current: () => true }, async (permit) => {
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [memberId], permit))
      try {
        const peer = store.getNodeForHostAction(memberId)!; delete peer.shell; delete peer.pendingLaunch
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: peer }, false)).toBeNull()
        expect(reservations.inspectClient(project.id, { op: 'upsert', node: peer }, true)).toMatchObject({
          canonical: { op: 'upsert', node: { pendingLaunch: { command: 'claude' } } }
        })
        const rawSave = await store.load(); rawSave.projects[0].nodes[1].pendingLaunch = undefined
        await expect(store.save(rawSave)).rejects.toThrow('reserved')
        expect(store.getNodeForHostAction(memberId)?.pendingLaunch?.command).toBe('claude')
      } finally { fence.release() }
    })
  })

  it('cannot claim an incomplete group or duplicate placement and cannot copy a reserved id into another project', async () => {
    const { store, writer, reservations, coordinator } = await fixture()
    await coordinator.runMany([groupId], 'worktree', { current: () => true }, async (permit) => {
      await expect(writer.edit((fresh) => reservations.hold(fresh, [groupId], permit))).rejects.toThrow('incomplete-group')
      expect(reservations.active()).toBe(false)
    })
    await coordinator.runMany([memberId], 'worktree', { current: () => true }, async (permit) => {
      const workspace = await store.load(); workspace.projects.push(structuredClone(workspace.projects[0]))
      expect(() => reservations.hold(workspace, [memberId], permit)).toThrow('unavailable')
      const { value: fence } = await writer.edit((fresh) => reservations.hold(fresh, [memberId], permit))
      try {
        await expect(writer.edit((fresh) => {
          fresh.projects.push({ ...structuredClone(fresh.projects[0]), id: 'project-copy' })
        })).rejects.toThrow('reserved')
        const copy = structuredClone((await store.load()).projects[0]); copy.id = 'project-copy'
        expect(() => reservations.assertProject(copy)).toThrow('ambiguous')
      } finally { fence.release(); fence.release() }
    })
  })
})
