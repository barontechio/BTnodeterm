import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitService } from './git-service'
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
afterEach(() => { resetPlatformForTests(); vi.restoreAllMocks() })
const node = (id: string, kind: CanvasNodeState['kind'], extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind, title: id, color: '#fff', group: null, position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, ...extra
})
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
async function fixture(agent = false, storage: 'folder' | 'appdata' | 'inline' = 'folder', recorded = true) {
  const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout'); fs.mkdirSync(repo); fs.mkdirSync(checkout)
  const stat = fs.lstatSync(checkout, { bigint: true })
  const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    node('group', 'group', { worktree: { path: checkout, repoPath: repo, branch: 'feature', baseRef: 'main', createdByApp: true } }),
    node('terminal', 'terminal', { ...(agent ? { agentId: 'claude' as const, agentSessionId: 'saved-session' } : {}), parentId: 'group', cwd: checkout, pendingLaunch: { after: [], command: 'echo held', attempted: false } }),
    node('editor', 'editor', { parentId: 'group', filePath: path.join(checkout, 'file') }),
    node('outside', 'terminal', { cwd: repo })
  ] }
  if (storage === 'appdata') project.storeInAppData = true
  if (storage === 'inline') delete project.cwd
  const store = new WorkspaceStore(); await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  const persisted = (await store.load({ sideline: false })).projects[0]
  const journal = new WorktreeRemovalJournal(path.join(root, 'data', 'worktree-removals.json'), { ownsFiles: () => true })
  await journal.load()
  const row = recorded ? await journal.prepare({ projectId: project.id, groupId: 'group', repoPath: repo, worktreePath: checkout,
    branch: 'feature', fallbackCwd: repo, directoryStamp: `${stat.dev}:${stat.ino}`,
    members: persisted.nodes.filter((n) => n.id !== 'outside').map((n) => ({ nodeId: n.id, binding: canvasExecutionBinding(persisted, n) })) }) : undefined
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
  const git = { worktreeList: vi.fn<GitService['worktreeList']>(async () => ({ ok: true, entries: [] })) }
  const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
  const confirmations = { request: vi.fn(async () => ({ ok: true as const, consume: async () => true, current: () => owner.active(), cancel() {} })) }
  const service = new WorktreeRecoveryService({ journal, pty, git, repair: { workspace: store, admission, dispatch, confirmations } })
  const writer = new CanvasContentWriter({ workspaceStore: store })
  return { store, writer, journal, row: row!, admission, dispatch, coordinator, recycle, service, owners, owner, git, repo, checkout, confirmations }
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

  it.each((['folder', 'appdata', 'inline'] as const).flatMap((storage) => ['file', 'directory'].map((part) => ({ storage, part }))))('keeps $storage recovery pending when $part cannot acknowledge durability', async ({ storage, part }) => {
    const f = await fixture(false, storage); const open = fs.promises.open
    const file = storage === 'folder' ? path.join(f.repo, '.nodeterm', 'project.json') : path.join(root, 'data', 'inline-projects', 'project.json')
    const target = part === 'file' ? file : path.dirname(file)
    const flushed = vi.fn(async () => { throw new Error('flush acknowledgement unavailable') })
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (args[0] === target) vi.spyOn(handle, 'sync').mockImplementation(flushed)
      return handle
    })
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('flush acknowledgement') })
    expect(flushed).toHaveBeenCalledOnce(); expect(f.recycle).toHaveBeenCalledOnce()
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
    expect(f.journal.list()[0].phase).toBe('removed')
    expect(f.journal.isNodePending('terminal')).toBe(true)
  })

  it.each(['overlay', 'mkdir'])('rechecks owner lifetime after asynchronous %s before publishing metadata bytes', async (boundary) => {
    const f = await fixture(); const started = deferred(); const finish = deferred()
    const file = path.join(f.repo, '.nodeterm', 'project.json'); const before = fs.readFileSync(file, 'utf8')
    if (boundary === 'overlay') {
      f.store.setContentAuthority({ overlayLoad: async (workspace) => workspace, overlaySave: async (workspace) => {
        if (!workspace.projects[0].nodes.find((node) => node.id === 'group')?.worktree) { started.resolve(); await finish.promise }
        return workspace
      } })
    } else {
      const mkdir = fs.promises.mkdir
      vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
        const result = await mkdir(...args)
        if (args[0] === path.dirname(file)) { started.resolve(); await finish.promise }
        return result
      })
    }
    const recovering = f.service.recover(f.row.id, f.owner)
    await started.promise; f.owners.forget(1)
    expect(f.admission.reservations.active()).toBe(true)
    finish.resolve(); expect(await recovering).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(f.journal.list()[0].phase).toBe('removed')
    expect(f.journal.isNodePending('terminal')).toBe(true)
  })

  it('reconciles the exact recorded split-file intermediate state after the private index write fails', async () => {
    const f = await fixture(); const rename = fs.promises.rename
    let fail = true
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
      if (fail && args[1] === path.join(root, 'data', 'workspace.json')) throw new Error('private index publication failed')
      return rename(...args)
    })
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0]).toMatchObject({ phase: 'removed', repair: { staged: expect.any(Array) } })
    expect(f.store.getNodeForHostAction('terminal')).toMatchObject({ cwd: f.repo })
    expect(f.journal.isNodePending('terminal')).toBe(true)
    fail = false
    expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
    expect(f.store.getNodeForHostAction('terminal')?.pendingLaunch?.manualOnly).toBe(true)
    expect(f.journal.isNodePending('terminal')).toBe(true)
    expect(f.confirmations.request).toHaveBeenCalledTimes(2)
  })

})

it.each(['appdata', 'inline'] as const)('%s planning leaves the live cache intact and repairs content plus private index durably', async (storage) => {
  const f = await fixture(false, storage)
  const contentFile = path.join(root, 'data', 'inline-projects', 'project.json')
  const originalContent = fs.readFileSync(contentFile, 'utf8')
  const planRepair = f.journal.planRepair.bind(f.journal)
  vi.spyOn(f.journal, 'planRepair').mockImplementation(async (...args) => {
    expect(f.store.getNodeForHostAction('terminal')?.cwd).toBe(f.checkout)
    expect(f.store.getNodeForHostAction('group')?.worktree).toBeDefined()
    expect(fs.readFileSync(contentFile, 'utf8')).toBe(originalContent)
    return planRepair(...args)
  })
  const open = fs.promises.open; const flushed: string[] = []
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const h = await open(...args); const sync = h.sync.bind(h)
    vi.spyOn(h, 'sync').mockImplementation(async () => { flushed.push(String(args[0])); await sync() })
    return h
  })
  const result = await f.service.recover(f.row.id, f.owner)
  expect(f.recycle).toHaveBeenCalledOnce()
  expect(f.journal.list()[0].phase).toBe('recovered')
  expect(fs.readFileSync(contentFile, 'utf8')).not.toBe(originalContent)
  const reloaded = (await new WorkspaceStore().load({ sideline: false })).projects[0]
  expect(reloaded.nodes.find((node) => node.id === 'terminal')).toMatchObject({ cwd: f.repo, pendingLaunch: { manualOnly: true } })
  expect(reloaded.nodes.find((node) => node.id === 'group')?.worktree).toBeUndefined()
  expect(reloaded.nodes.find((node) => node.id === 'editor')?.fileMissing).toBe(true)
  expect(f.store.getNodeForHostAction('terminal')?.cwd).toBe(f.repo)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'recovered' })
  expect(flushed).toContain(path.join(root, 'data', 'workspace.json'))
  expect(flushed.some(file => file.includes('/inline-projects/') && file.endsWith('.json'))).toBe(true)
  expect(flushed).toContain(path.join(root, 'data', 'inline-projects'))
  const journal = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await journal.load()
  expect(journal.isNodePending('terminal')).toBe(true)
})


it.each((['folder', 'appdata', 'inline'] as const).flatMap((storage) => ['content', 'index'].map((part) => ({ storage, part }))))('refuses $storage $part publication after owner departure during the temporary write', async ({ storage, part }) => {
  const f = await fixture(false, storage)
  const target = part === 'index' ? path.join(root, 'data', 'workspace.json') : storage === 'folder' ? path.join(f.repo, '.nodeterm', 'project.json') : path.join(root, 'data', 'inline-projects', 'project.json')
  const before = fs.readFileSync(target, 'utf8'); const write = fs.promises.writeFile
  let departed = false
  vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof write>) => {
    const result = await write(...args)
    if (String(args[0]).startsWith(target + '.') && String(args[0]).endsWith('.tmp')) { departed = true; f.owners.forget(1) }
    return result
  })
  expect(await f.service.recover(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(departed).toBe(true)
  expect(fs.readFileSync(target, 'utf8')).toBe(before)
  expect(f.journal.list()[0].phase).toBe('removed')
  expect(f.journal.isNodePending('terminal')).toBe(true)
})

async function missingFixture(storage: 'folder' | 'appdata' | 'inline' = 'folder') {
  const f = await fixture(false, storage, false)
  const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { stdio: 'pipe' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('commit', '--allow-empty', '-m', 'base')
  const backend = new GitService()
  f.git.worktreeList.mockImplementation((...args) => backend.worktreeList(...args))
  return f
}
it.each(['folder', 'appdata', 'inline'] as const)('recovers an already missing %s checkout without inventing a prior inode or deletion', async (storage) => {
  const f = await missingFixture(storage)
  expect(f.journal.list()).toEqual([])
  expect(fs.existsSync(f.journal.file)).toBe(false)
  expect(await f.service.discoverMissing(f.owner)).toMatchObject({ ok: true, candidates: [{ groupId: 'group', path: f.checkout }] })
  expect(fs.existsSync(f.journal.file)).toBe(false)
  const recycle = f.recycle.getMockImplementation()!
  f.recycle.mockImplementationOnce(async (...args) => {
    const row = f.journal.list()[0]
    expect(row).toMatchObject({ phase: 'removed', provenance: { kind: 'observed-missing', ancestor: root } })
    expect(row.directoryStamp).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(f.journal.file, 'utf8')).version).toBe(3)
    return recycle(...args)
  })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
  expect(f.confirmations.request).toHaveBeenCalledOnce()
  expect(f.recycle).toHaveBeenCalledOnce()
  expect((await new WorkspaceStore().load({ sideline: false })).projects[0].nodes.find((n) => n.id === 'terminal')?.cwd).toBe(f.repo)
  const restart = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await restart.load()
  expect(restart.isNodePending('terminal')).toBe(true)
  expect(await f.service.discoverMissing(f.owner)).toEqual({ ok: true, candidates: [] })
  expect(await f.service.keep(restart.list()[0].id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
})
it.each(['recreated', 'metadata', 'owner', 'repository', 'symlink'] as const)('refuses changed %s before recording observed absence or teardown', async (change) => {
  const f = await missingFixture()
  const request = f.confirmations.request.getMockImplementation()!
  f.confirmations.request.mockImplementationOnce(async (...args) => {
    if (change === 'recreated') fs.mkdirSync(f.checkout)
    if (change === 'metadata') await f.writer.edit((fresh) => { fresh.projects[0].nodes.find((node) => node.id === 'terminal')!.cwd = f.repo })
    if (change === 'owner') f.owners.forget(1)
    if (change === 'repository') { fs.renameSync(f.repo, f.repo + '-old'); fs.mkdirSync(f.repo) }
    if (change === 'symlink') fs.symlinkSync(f.repo, f.checkout)
    return request(...args)
  })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
  expect(f.recycle).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([])
})
it('retains observed absence on a later teardown failure and reconciles only via its durable record', async () => {
  const f = await missingFixture()
  f.recycle.mockRejectedValueOnce(new Error('teardown acknowledgement lost'))
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  const row = f.journal.list()[0]
  expect(row.provenance.kind).toBe('observed-missing'); expect(row.directoryStamp).toBeUndefined()
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
  expect(await f.service.recover(row.id, f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
  expect(f.confirmations.request).toHaveBeenCalledTimes(2)
})

it('accepts real prunable linked metadata without pruning or claiming a Git deletion', async () => {
  const f = await missingFixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('worktree', 'add', '-b', 'feature', f.checkout)
  fs.rmSync(f.checkout, { recursive: true }) // fixture models external deletion before any host record
  const before = git('worktree', 'list', '--porcelain')
  expect(before).toContain('prunable')
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
  expect(git('worktree', 'list', '--porcelain')).toBe(before)
  expect(f.journal.list()[0]).not.toHaveProperty('directoryStamp')
})
it('refuses a missing checkout with changed linked branch metadata before journal or terminal effects', async () => {
  const f = await missingFixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { stdio: 'pipe' })
  git('worktree', 'add', '-b', 'other', f.checkout)
  fs.rmSync(f.checkout, { recursive: true })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
  expect(f.confirmations.request).not.toHaveBeenCalled(); expect(f.recycle).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([])
})
