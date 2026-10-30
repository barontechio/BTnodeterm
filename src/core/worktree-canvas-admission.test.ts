import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import { CanvasContentWriter } from './canvas-content-writer'
import { initCanvasSync, publishCanvasMutation } from './canvas-sync'
import { initWorktreeRecovery } from './worktree-recovery'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let root: string
let cwd: string
let checkout: string
let fake: ReturnType<typeof fakePlatform>
const node = (id: string, more: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#fff', group: null,
  position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, ...more
})
beforeEach(async () => {
  root = await fs.realpath(testTmpDir('worktree-canvas-admission-'))
  cwd = path.join(root, 'repo'); checkout = path.join(root, 'checkout')
  await fs.mkdir(cwd); await fs.mkdir(checkout)
  fake = fakePlatform({ userDataDir: root, isOwnerClient: () => true })
  fake.clients.push(1, 2); initPlatform(fake); initCanvasSync()
})
afterEach(() => resetPlatformForTests())

async function fixture(kind: 'folder' | 'app-data' | 'inline' = 'folder', corrupt = false) {
  const project: Project = { id: 'project-pending', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 },
    ...(kind !== 'inline' ? { cwd } : {}), ...(kind === 'app-data' ? { storeInAppData: true } : {}), nodes: [
      node('group-pending', { kind: 'group', worktree: { repoPath: cwd, path: checkout, branch: 'feature', baseRef: 'main', createdByApp: true } }),
      node('member-pending', { parentId: 'group-pending', cwd: checkout, shell: '/bin/bash' }), node('outside', { cwd })
    ] }
  const store = new WorkspaceStore()
  await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  const file = path.join(root, 'worktree-removals.json')
  await fs.writeFile(file, corrupt ? '{broken' : JSON.stringify({ kind: 'worktree-removals', version: 1, records: [{
    id: 'pending-removal', phase: 'prepared', createdAt: 1, projectId: project.id, groupId: 'group-pending',
    repoPath: cwd, worktreePath: checkout, branch: 'feature', fallbackCwd: cwd, directoryStamp: '1:2',
    members: [{ nodeId: 'group-pending', binding: 'a'.repeat(64) }, { nodeId: 'member-pending', binding: 'b'.repeat(64) }]
  }] }))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let runtime: Awaited<ReturnType<typeof initWorktreeRecovery>>
  try { runtime = await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission: () => {} }, () => true, store) }
  finally { warning.mockRestore() }
  const publish = vi.fn(publishCanvasMutation)
  const writer = new CanvasContentWriter({ workspaceStore: store, publishMutation: publish })
  return { store, writer, project, runtime: runtime!, publish, file }
}

describe('saved worktree references during recovery', () => {
  for (const kind of ['folder', 'app-data', 'inline'] as const) {
    it(`lets ${kind} nodes be repaired after restart, but refuses a stale snapshot restoring the retired path`, async () => {
      const { store, writer, project, runtime } = await fixture(kind)
      expect(runtime.canvasAdmission?.reservations.active()).toBe(false)
      const stale = structuredClone(await store.load())
      await writer.edit((fresh) => { fresh.projects[0].nodes[1].position.x = 100 })
      await writer.edit((fresh) => {
        delete fresh.projects[0].nodes[0].worktree
        fresh.projects[0].nodes[1].cwd = cwd
      })
      await expect(store.save(stale)).rejects.toThrow('recovery-required')
      expect(store.getNodeForHostAction('member-pending')).toMatchObject({ cwd, position: { x: 100 }, shell: '/bin/bash' })
      const reopened = await new WorkspaceStore().load()
      expect(reopened.projects[0].nodes[1]).toMatchObject({ cwd, position: { x: 100 } })
      expect(runtime.journal.list()[0].phase).toBe('prepared')
      expect(runtime.canvasAdmission!.inspectClient(project.id, { op: 'upsert', node: { ...project.nodes[1], position: { x: 900, y: 0 } } }, true))
        .toMatchObject({ canonical: { op: 'upsert', node: { cwd, position: { x: 900 } } } })
    })
  }

  it('rejects new members, editors and project roots inside a reserved checkout before Core publication', async () => {
    const { writer, publish, project } = await fixture()
    for (const candidate of [node('direct', { cwd: checkout }), node('inherited', { parentId: 'group-pending' }),
      node('editor', { kind: 'editor', filePath: path.join(checkout, 'file.ts') })]) {
      await expect(writer.edit((fresh) => { fresh.projects[0].nodes.push(candidate) })).rejects.toThrow('recovery-required')
    }
    await expect(writer.edit((fresh) => { fresh.projects.push({ ...project, id: 'another', cwd: checkout, nodes: [] }) }))
      .rejects.toThrow('recovery-required')
    expect(publish).not.toHaveBeenCalled()
  })

  it('allows closing a historical tab, deleting old nodes and marking displaced files as missing', async () => {
    const { store, writer } = await fixture()
    await writer.edit((fresh) => { fresh.projects[0].closed = true })
    await writer.edit((fresh) => { fresh.projects[0].nodes = fresh.projects[0].nodes.filter((item) => item.id !== 'member-pending') })
    await writer.edit((fresh) => {
      fresh.projects[0].nodes.push(node('missing-editor', { kind: 'editor', filePath: path.join(checkout, 'old.ts'), fileMissing: true }))
      fresh.projects[0].nodes.push(node('missing-diff', { kind: 'diff', cwd: checkout, filePath: 'old.ts', fileMissing: true }))
    })
    await expect(writer.edit((fresh) => { fresh.projects[0].nodes.find((item) => item.id === 'missing-editor')!.fileMissing = false }))
      .rejects.toThrow('recovery-required')
    await expect(writer.edit((fresh) => { fresh.projects[0].nodes.find((item) => item.id === 'missing-diff')!.fileMissing = false }))
      .rejects.toThrow('recovery-required')
    expect(store.getNodeForHostAction('member-pending')).toBeUndefined()
    expect(store.getNodeForHostAction('missing-editor')?.fileMissing).toBe(true)
  })

  it('corrects a refused optimistic new binding and explicitly notifies its sender', async () => {
    const { project } = await fixture()
    fake.senderListeners[IPC.canvasMut](1, project.id, { op: 'upsert', node: node('new-terminal', { cwd: checkout }), src: 'browser' })
    expect(fake.sent).toContainEqual(expect.objectContaining({ to: 1, channel: IPC.canvasMutationRejected }))
    const peer = fake.sent.filter((sent) => sent.to === 2 && sent.channel === IPC.canvasMut)
    expect(peer).toHaveLength(1)
    expect(peer[0].args[1]).toMatchObject({ op: 'remove', id: 'new-terminal' })
  })

  it.skipIf(process.platform === 'win32')('rejects aliases that still reach a removed checkout', async () => {
    const { writer } = await fixture()
    const alias = path.join(root, 'checkout-alias'); await fs.symlink('checkout', alias)
    await fs.rmdir(checkout)
    await expect(writer.edit((fresh) => { fresh.projects[0].nodes.push(node('alias', { cwd: path.join(alias, 'nested') })) }))
      .rejects.toThrow('recovery-required')
  })

  it('preserves historical layout and tab edits when the journal is corrupt, while refusing new physical references', async () => {
    const { store, writer, file } = await fixture('folder', true)
    await writer.edit((fresh) => { fresh.projects[0].nodes[1].position.x = 250; fresh.projects[0].closed = true })
    await expect(writer.edit((fresh) => { fresh.projects[0].nodes.push(node('new', { cwd })) })).rejects.toThrow('journal-unavailable')
    expect(store.getNodeForHostAction('member-pending')?.position.x).toBe(250)
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })

  it('adds no path resolution to ordinary saves when no recovery state exists', async () => {
    const store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'P', color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('ordinary')] }] } satisfies Workspace)
    const runtime = await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission: () => {} }, () => true, store)
    expect(runtime!.canvasAdmission!.active()).toBe(false)
    const resolve = vi.spyOn(fsSync.realpathSync, 'native')
    try {
      await expect(store.save(await store.load())).resolves.toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()
    } finally { resolve.mockRestore() }
    expect(runtime!.journal.list()).toEqual([])
  })

  it('checks large pending projects with bulk host snapshots and preserves the same private execution binding', async () => {
    const { store, writer, project } = await fixture()
    await writer.edit((fresh) => {
      for (let i = 0; i < 1000; i++) fresh.projects[0].nodes.push(node(`extra-${i}`, { cwd }))
    })
    expect(store.getProjectNodesForHostAction(project.id)?.find((item) => item.id === 'member-pending'))
      .toEqual(store.getNodeForHostAction('member-pending'))
    const individual = vi.spyOn(store, 'getNodeForHostAction')
    const bulk = vi.spyOn(store, 'getProjectNodesForHostAction')
    try {
      await store.save(await store.load())
      expect(individual).not.toHaveBeenCalled()
      expect(bulk.mock.calls.length).toBeGreaterThan(0)
      expect(bulk.mock.calls.length).toBeLessThanOrEqual(4)
    } finally { individual.mockRestore(); bulk.mockRestore() }
  })
})
