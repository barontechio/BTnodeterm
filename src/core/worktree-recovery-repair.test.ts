import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { initCanvasSync } from './canvas-sync'
import { WorkspaceStore } from './workspace-store'
import { CanvasContentWriter } from './canvas-content-writer'
import { canvasExecutionBinding } from './canvas-execution-reservations'
import { installWorktreeCanvasAdmission } from './worktree-canvas-admission'
import { WorktreeRemovalJournal } from './worktree-removal-journal'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import { WorktreeRecoveryService } from './worktree-recovery-service'
import { NodeExecutionCoordinator, type NodeExecutionBatchPermit, type NodeExecutionOptions } from './node-execution'
import { OwnerLifetimes } from './owner-lifetimes'
import type { CanvasNodeState, Project } from '../shared/types'

let root: string
beforeEach(() => {
  root = fs.realpathSync(testTmpDir('worktree-repair-'))
  fs.mkdirSync(path.join(root, 'data')); initPlatform(fakePlatform({ userDataDir: path.join(root, 'data') })); initCanvasSync()
})
afterEach(() => resetPlatformForTests())
const node = (id: string, kind: CanvasNodeState['kind'], extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind, title: id, color: '#fff', group: null, position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, ...extra
})
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
async function fixture(agent = false) {
  const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout'); fs.mkdirSync(repo); fs.mkdirSync(checkout)
  const stat = fs.lstatSync(checkout, { bigint: true })
  const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    node('group', 'group', { worktree: { path: checkout, repoPath: repo, branch: 'feature', baseRef: 'main', createdByApp: true } }),
    node('terminal', 'terminal', { ...(agent ? { agentId: 'claude' as const, agentSessionId: 'saved-session' } : {}), parentId: 'group', cwd: checkout, pendingLaunch: { after: [], command: 'echo held', attempted: false } }),
    node('editor', 'editor', { parentId: 'group', filePath: path.join(checkout, 'file') }),
    node('outside', 'terminal', { cwd: repo })
  ] }
  const store = new WorkspaceStore(); await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  const persisted = (await store.load({ sideline: false })).projects[0]
  const journal = new WorktreeRemovalJournal(path.join(root, 'data', 'worktree-removals.json'), { ownsFiles: () => true })
  await journal.load()
  const row = await journal.prepare({ projectId: project.id, groupId: 'group', repoPath: repo, worktreePath: checkout,
    branch: 'feature', fallbackCwd: repo, directoryStamp: `${stat.dev}:${stat.ino}`,
    members: persisted.nodes.filter((n) => n.id !== 'outside').map((n) => ({ nodeId: n.id, binding: canvasExecutionBinding(persisted, n) })) })
  fs.rmdirSync(checkout)
  const admission = installWorktreeCanvasAdmission(store, journal); const dispatch = new WorktreeRecoveryDispatch(journal)
  const coordinator = new NodeExecutionCoordinator(); coordinator.setDispatchAdmission((id, permit) => dispatch.assertAllowed(id, permit))
  const generation = {}; let live: object | undefined = generation
  const recycle = vi.fn(async (id: string, permit: NodeExecutionBatchPermit) => {
    permit.assertCurrent(); coordinator.assertAllowed(id); live = undefined
  })
  const pty = { nodeExecutionIdentity: () => live,
    runWorktreeAction: <T>(ids: readonly string[], options: NodeExecutionOptions, work: (permit: NodeExecutionBatchPermit) => Promise<T> | T) =>
      coordinator.runMany(ids, 'worktree', options, work), recycleWorktreeMember: recycle }
  const git = { worktreeList: vi.fn(async () => ({ ok: true, entries: [] })) }
  const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
  const confirmations = { request: vi.fn(async () => ({ ok: true as const, consume: async () => true, current: () => owner.active(), cancel() {} })) }
  const service = new WorktreeRecoveryService({ journal, pty, git, repair: { workspace: store, admission, dispatch, confirmations } })
  const writer = new CanvasContentWriter({ workspaceStore: store })
  return { store, writer, journal, row, admission, dispatch, coordinator, recycle, service, owners, owner, git, repo, checkout, confirmations }
}

describe.skipIf(process.platform === 'win32')('recorded missing-checkout recovery', () => {
  it('acknowledges teardown, preserves concurrent layout, durably repairs metadata and keeps manual-start quarantine after restart', async () => {
    const f = await fixture(); const started = deferred(); const finish = deferred()
    f.recycle.mockImplementationOnce(async (id, permit) => {
      f.coordinator.assertAllowed(id); permit.assertCurrent(); started.resolve(); await finish.promise
    })
    const recovering = f.service.recover(f.row.id, f.owner); await started.promise
    await f.writer.edit((fresh) => { fresh.projects[0].nodes.find((n) => n.id === 'terminal')!.position.x = 123 })
    expect(f.journal.list()[0]).toMatchObject({ phase: 'removed', repair: { manualStart: ['terminal'] } })
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeDefined()
    finish.resolve()
    expect(await recovering).toMatchObject({ ok: true, outcome: 'recovered' })
    expect(f.store.getNodeForHostAction('terminal')).toMatchObject({ cwd: f.repo, position: { x: 123 }, pendingLaunch: { manualOnly: true, command: 'echo held' } })
    expect(f.store.getNodeForHostAction('editor')).toMatchObject({ fileMissing: true, filePath: path.join(f.checkout, 'file') })
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
    expect(f.git.worktreeList).not.toHaveBeenCalled()
    expect(() => f.coordinator.assertAllowed('terminal')).toThrow('recovery-required')
    const reloaded = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reloaded.load()
    expect(reloaded.isNodePending('terminal')).toBe(true)
    expect(reloaded.blocks(f.checkout)).toBe(true)
    expect(f.service.list(f.owner)).toMatchObject({ ok: true, records: [{ phase: 'recovered', manualStartIds: ['terminal'] }] })
    expect(JSON.stringify(f.service.list(f.owner))).not.toContain('echo held')
  })

  it('keeps exclusion until real teardown settles after departure and performs no later metadata repair', async () => {
    const f = await fixture(); const started = deferred(); const finish = deferred()
    f.recycle.mockImplementationOnce(async () => { started.resolve(); await finish.promise })
    const recovering = f.service.recover(f.row.id, f.owner); await started.promise; f.owners.forget(1)
    expect(f.coordinator.isBusy('terminal')).toBe(true); expect(f.admission.reservations.active()).toBe(true)
    finish.resolve(); expect(await recovering).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeDefined()
    expect(f.journal.list()[0].phase).toBe('removed')
    expect(f.journal.isNodePending('terminal')).toBe(true)
    expect(f.admission.reservations.active()).toBe(false)
  })

  it('refuses changed metadata and a recreated directory before terminal effects', async () => {
    const f = await fixture()
    fs.mkdirSync(f.checkout)
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    fs.rmdirSync(f.checkout)
    await f.writer.edit((fresh) => { const terminal = fresh.projects[0].nodes.find((n) => n.id === 'terminal')!; terminal.cwd = f.repo; delete terminal.parentId })
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.recycle).not.toHaveBeenCalled(); expect(f.journal.list()[0].phase).toBe('prepared')
  })
  it('refuses unsupported account/runtime identities and expired approval before effects', async () => {
    const f = await fixture(true)
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused', error: expect.stringContaining('account/runtime') })
    expect(f.recycle).not.toHaveBeenCalled(); expect(f.confirmations.request).not.toHaveBeenCalled()
  })

  it('does not dispatch when the existing broker refuses consumption of changed approval', async () => {
    const f = await fixture()
    f.confirmations.request.mockImplementationOnce(async () => ({ ok: true, consume: async () => false, current: () => false, cancel() {} }))
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.recycle).not.toHaveBeenCalled(); expect(f.journal.list()[0].phase).toBe('prepared')
  })

  it('retains the durable plan after a lost metadata acknowledgement and reconciles only that plan with fresh consent', async () => {
    const f = await fixture(); const update = f.store.updateWorkspaceForExecutionRepair.bind(f.store)
    let lose = true
    vi.spyOn(f.store, 'updateWorkspaceForExecutionRepair').mockImplementation(async (...args) => {
      const result = await update(...args)
      if (lose && !f.store.getNodeForHostAction('group')?.worktree) { lose = false; throw new Error('metadata acknowledgement lost') }
      return result
    })
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0]).toMatchObject({ phase: 'removed', repair: { manualStart: ['terminal'] } })
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
    expect(f.journal.isNodePending('terminal')).toBe(true)
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
    expect(f.confirmations.request).toHaveBeenCalledTimes(2)
    expect(f.journal.isNodePending('terminal')).toBe(true)
    expect(f.git.worktreeList).not.toHaveBeenCalled()
  })

})
