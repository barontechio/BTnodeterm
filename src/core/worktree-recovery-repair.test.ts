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
import { installWorktreeCanvasAdmission, WorktreeCanvasAdmission } from './worktree-canvas-admission'
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
  const localGit = new GitService()
  const git = { worktreeList: vi.fn<GitService['worktreeList']>(async () => ({ ok: true, entries: [] })),
    worktreeRecoveryDirectories: localGit.worktreeRecoveryDirectories.bind(localGit) }
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
    expect(JSON.parse(fs.readFileSync(f.journal.file, 'utf8')).version).toBe(4)
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

it.each(['directory-open', 'temp-write', 'published'] as const)('changed Git branch during first journal %s must prevent subsequent effects', async (boundary) => {
 const f = await missingFixture()
 execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'feature', f.checkout], {stdio:'pipe'})
 fs.rmSync(f.checkout, {recursive:true})
 const head = path.join(f.repo, '.git', 'worktrees', 'checkout', 'HEAD')
 const open = fs.promises.open; const write = fs.promises.writeFile; const rename = fs.promises.rename; let injected = false
 const change = () => { injected = true; fs.writeFileSync(head, 'ref: refs/heads/other\n') }
 vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof write>) => {
   const result = await write(...args)
   if (!injected && boundary === 'temp-write' && String(args[0]).startsWith(f.journal.file + '.')) change()
   return result
 })
 vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
   const result = await rename(...args)
   if (!injected && boundary === 'published' && args[1] === f.journal.file) change()
   return result
 })
 vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
   const handle = await open(...args)
   if (!injected && boundary === 'directory-open' && args[0] === path.dirname(f.journal.file)) change()
   return handle
 })
 const result = await f.service.recoverMissing('group', f.owner)
 expect(injected).toBe(true)
 expect(result).toMatchObject({ok:false})
 expect(f.recycle).not.toHaveBeenCalled()
 expect(fs.existsSync(f.journal.file)).toBe(boundary === 'published')
 expect(f.store.getNodeForHostAction('group')?.worktree).toBeDefined()
 expect(f.journal.isNodePending('terminal')).toBe(true)
})
it('independent: replacing Git metadata during consent must invalidate captured repository', async () => {
 const f = await missingFixture()
 const request = f.confirmations.request.getMockImplementation()!
 f.confirmations.request.mockImplementationOnce(async (...args) => {
   fs.renameSync(path.join(f.repo,'.git'), path.join(f.repo,'.git-old'))
   execFileSync('git', ['-C', f.repo, 'init', '-b', 'unrelated'], {stdio:'pipe'})
   return request(...args)
 })
 const result = await f.service.recoverMissing('group', f.owner)
 expect(result).toMatchObject({ok:false})
 expect(f.recycle).not.toHaveBeenCalled()
 expect(fs.existsSync(f.journal.file)).toBe(false)
})
it('independent: v3 envelope unknown fields must be rejected', async () => {
 const f = await missingFixture()
 fs.writeFileSync(f.journal.file, JSON.stringify({kind:'worktree-removals',version:3,records:[],futureAuthority:true}))
 const reload = new WorktreeRemovalJournal(f.journal.file,{ownsFiles:()=>true})
 await expect(reload.load()).rejects.toThrow()
})

it('independent: first publication acknowledgement loss must not recycle or repair', async () => {
 const f = await missingFixture(); const rename = fs.promises.rename
 vi.spyOn(fs.promises,'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
   const result = await rename(...args)
   if (args[1] === f.journal.file) throw new Error('independent lost publication ack')
   return result
 })
 expect(await f.service.recoverMissing('group',f.owner)).toMatchObject({ok:false,outcome:'uncertain'})
 expect(f.recycle).not.toHaveBeenCalled()
 expect(f.store.getNodeForHostAction('group')?.worktree).toBeDefined()
 expect(f.journal.isNodePending('terminal')).toBe(true)
 const reload = new WorktreeRemovalJournal(f.journal.file,{ownsFiles:()=>true}); await reload.load()
 expect(reload.isNodePending('terminal')).toBe(true)
 expect(reload.list()[0].provenance.kind).toBe('observed-missing')
})
it('independent: owner expiration during first journal directory open prevents publication', async () => {
 const f = await missingFixture(); const open = fs.promises.open; let injected = false
 vi.spyOn(fs.promises,'open').mockImplementation(async (...args: Parameters<typeof open>) => {
  const handle = await open(...args)
  if (!injected && args[0] === path.dirname(f.journal.file)) { injected=true; f.owners.forget(1) }
  return handle
 })
 expect(await f.service.recoverMissing('group',f.owner)).toMatchObject({ok:false})
 expect(injected).toBe(true); expect(f.recycle).not.toHaveBeenCalled()
 expect(fs.existsSync(f.journal.file)).toBe(false)
})
it('independent: dangling parent is not checkout absence', async () => {
 const f = await missingFixture()
 const alias = path.join(root,'alias'); fs.symlinkSync(path.join(root,'not-present'),alias)
 await f.writer.edit(w => {const g = w.projects[0].nodes.find(n=>n.id==='group')!; g.worktree!.path=path.join(alias,'checkout')})
 expect(await f.service.recoverMissing('group',f.owner)).toMatchObject({ok:false,outcome:'refused'})
 expect(f.recycle).not.toHaveBeenCalled(); expect(fs.existsSync(f.journal.file)).toBe(false)
})
it('independent: descendant added during confirmation invalidates exact captured plan', async () => {
 const f=await missingFixture(); const request=f.confirmations.request.getMockImplementation()!
 f.confirmations.request.mockImplementationOnce(async (...args)=>{
  await f.writer.edit(w=>{w.projects[0].nodes.push(node('new-child','terminal',{parentId:'group',cwd:f.repo}))})
  return request(...args)
 })
 expect(await f.service.recoverMissing('group',f.owner)).toMatchObject({ok:false,outcome:'refused'})
 expect(f.recycle).not.toHaveBeenCalled(); expect(fs.existsSync(f.journal.file)).toBe(false)
})

it('pins a legitimate separate Git directory and does not require a surviving linked entry', async () => {
  const f = await missingFixture(); const metadata = path.join(root, 'separate-git')
  execFileSync('git', ['-C', f.repo, 'init', '--separate-git-dir', metadata], { stdio: 'pipe' })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true, outcome: 'recovered' })
  expect(f.journal.list()[0].provenance).toMatchObject({ kind: 'observed-missing', git: { gitDirectory: metadata, commonDirectory: metadata } })
})
it('refuses a redirected Git marker even when the underlying repository still answers', async () => {
  const f = await missingFixture(); const metadata = path.join(root, 'redirected-git')
  fs.renameSync(path.join(f.repo, '.git'), metadata); fs.symlinkSync(metadata, path.join(f.repo, '.git'))
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
  expect(f.confirmations.request).not.toHaveBeenCalled(); expect(f.recycle).not.toHaveBeenCalled()
})

async function rebindFixture(storage: 'folder' | 'appdata' | 'inline' = 'folder') {
  const f = await missingFixture(storage)
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true })
  const row = f.journal.list()[0]
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'feature', f.checkout], { stdio: 'pipe' })
  f.recycle.mockClear(); f.confirmations.request.mockClear()
  return { ...f, row }
}
it.each(['folder', 'appdata', 'inline'] as const)('rebinds verified %s association durably while retaining every manual restriction', async (storage) => {
  const f = await rebindFixture(storage)
  const terminal = structuredClone(f.store.getNodeForHostAction('terminal'))
  const origin = structuredClone(f.row.provenance)
  const result = await f.service.rebind(f.row.id, f.owner)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'rebound' })
  expect(f.recycle).not.toHaveBeenCalled(); expect(f.confirmations.request).toHaveBeenCalledOnce()
  const fresh = (await new WorkspaceStore().load({ sideline: false })).projects[0]
  expect(fresh.nodes.find((node) => node.id === 'group')).toMatchObject({ cwd: f.checkout, worktree: {
    path: f.checkout, repoPath: f.repo, branch: 'feature', baseRef: 'main', createdByApp: false
  } })
  expect(fresh.nodes.find((node) => node.id === 'terminal')).toEqual(terminal)
  expect(fresh.nodes.find((node) => node.id === 'editor')?.fileMissing).toBe(true)
  const reload = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reload.load()
  expect(reload.list()).toHaveLength(1)
  expect(reload.list()[0]).toMatchObject({ provenance: origin, rebind: { state: 'bound' }, repair: { manualStart: ['terminal'] } })
  expect(reload.blocks(f.checkout)).toBe(false); expect(reload.isNodePending('terminal')).toBe(true)
  expect(() => f.coordinator.assertAllowed('terminal')).toThrow('recovery-required')
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
})

it.each(['branch', 'inode', 'owner', 'git-marker'] as const)('refuses rebind when approved %s changes during consent', async (change) => {
  const f = await rebindFixture()
  f.confirmations.request.mockImplementationOnce(async () => {
    if (change === 'branch') execFileSync('git', ['-C', f.checkout, 'switch', '-c', 'different'], { stdio: 'pipe' })
    if (change === 'inode') { fs.renameSync(f.checkout, f.checkout + '-old'); fs.mkdirSync(f.checkout) }
    if (change === 'owner') f.owners.forget(1)
    if (change === 'git-marker') fs.appendFileSync(path.join(f.checkout, '.git'), '\n')
    return { ok: true, consume: async () => true, current: () => f.owner.active(), cancel() {} }
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false })
  expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
  expect(f.journal.list()[0].rebind).toBeUndefined()
  expect(f.journal.blocks(f.checkout)).toBe(true)
  expect(f.recycle).not.toHaveBeenCalled()
})

it.each(['folder', 'appdata', 'inline'] as const)('retains prepared %s rebind after failed metadata durability and reconciles with fresh consent', async (storage) => {
  const f = await rebindFixture(storage); const open = fs.promises.open
  const content = storage === 'folder' ? path.join(f.repo, '.nodeterm', 'project.json') : path.join(root, 'data', 'inline-projects', 'project.json')
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[0] === content) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('rebind flush failed'))
    return handle
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('rebind flush failed') })
  expect(f.journal.list()[0].rebind?.state).toBe('prepared')
  expect(f.journal.blocks(f.checkout)).toBe(true); expect(f.journal.isNodePending('terminal')).toBe(true)
  spy.mockRestore()
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: true, outcome: 'rebound' })
  expect(f.confirmations.request).toHaveBeenCalledTimes(2); expect(f.recycle).not.toHaveBeenCalled()
})

it.each(['content', 'index'] as const)('refuses releasing the path when durable %s changes during final publication', async (part) => {
  const f = await rebindFixture(); const mark = f.journal.markRebound.bind(f.journal)
  const file = part === 'content' ? path.join(f.repo, '.nodeterm', 'project.json') : path.join(root, 'data', 'workspace.json')
  vi.spyOn(f.journal, 'markRebound').mockImplementation(async (...args) => {
    // Simulate an external writer after metadata fsync, before the journal's dispatch guard.
    fs.appendFileSync(file, ' ')
    return mark(...args)
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('durable-sync-file-changed') })
  const reload = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reload.load()
  expect(reload.list()[0].rebind?.state).toBe('prepared'); expect(reload.blocks(f.checkout)).toBe(true)
  expect(reload.isNodePending('terminal')).toBe(true); expect(f.recycle).not.toHaveBeenCalled()
})

it('holds the workspace FIFO through bound publication and preserves a queued visual save', async () => {
  const f = await rebindFixture(); const entered = deferred(); const finish = deferred()
  const mark = f.journal.markRebound.bind(f.journal)
  vi.spyOn(f.journal, 'markRebound').mockImplementation(async (...args) => { entered.resolve(); await finish.promise; return mark(...args) })
  const rebinding = f.service.rebind(f.row.id, f.owner); await entered.promise
  let edited = false
  const queued = f.writer.edit((fresh) => { edited = true; fresh.projects[0].nodes.find((n) => n.id === 'group')!.position.x = 947 })
  await Promise.resolve(); expect(edited).toBe(false)
  finish.resolve(); expect(await rebinding).toMatchObject({ ok: true }); await queued
  expect(f.store.getNodeForHostAction('group')).toMatchObject({ position: { x: 947 }, worktree: { path: f.checkout } })
})

it('cannot use the rebind scope around a queued operation before the actual repair transition', async () => {
  const f = await rebindFixture(); const scope = f.admission.withVerifiedRebind.bind(f.admission)
  let checked = false
  vi.spyOn(f.admission, 'withVerifiedRebind').mockImplementation(async (permit, row, work) => scope(permit, row, async () => {
    const proposed = structuredClone(await f.store.load({ sideline: false }))
    const group = proposed.projects[0].nodes.find((n) => n.id === 'group')!
    group.worktree = structuredClone(row.rebind!.binding); group.cwd = f.checkout
    // No repair ALS yet: even the exact final binding remains unavailable.
    expect(f.admission.reservations.isRepairBinding(permit, proposed.projects[0], group)).toBe(false)
    expect(() => f.admission.assertWorkspace(proposed)).toThrow()
    const unheld = new WorktreeCanvasAdmission(f.store, f.journal)
    await unheld.withVerifiedRebind(permit, row, async () => {
      expect(() => unheld.assertWorkspace(proposed)).toThrow('recovery-required')
    })
    checked = true
    return work()
  }))
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: true })
  expect(checked).toBe(true)
})

it('does not bypass a second tombstone for the same checkout', async () => {
  const f = await rebindFixture(); const paths = f.journal.reservedPaths.bind(f.journal)
  vi.spyOn(f.journal, 'reservedPaths').mockImplementation(() => [...paths(), f.checkout])
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(f.journal.list()[0].rebind?.state).toBe('prepared')
  expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
})

it('retains quarantine on a lost bound publication acknowledgement and verifies durable facts on reload', async () => {
  const f = await rebindFixture(); const rename = fs.promises.rename
  let journalWrites = 0
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
    const result = await rename(...args)
    if (args[1] === f.journal.file && ++journalWrites === 2) throw new Error('bound acknowledgement lost')
    return result
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(() => f.journal.blocks(f.checkout)).toThrow('journal-unavailable')
  expect(f.journal.isNodePending('terminal')).toBe(true)
  const reload = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reload.load()
  expect(reload.list()[0].rebind?.state).toBe('bound')
  expect(reload.blocks(f.checkout)).toBe(false); expect(reload.isNodePending('terminal')).toBe(true)
  expect(f.confirmations.request).toHaveBeenCalledOnce(); expect(f.recycle).not.toHaveBeenCalled()
})

it.each(['prepare', 'content', 'bound'] as const)('rechecks original Git evidence during rebind %s publication', async (boundary) => {
  const f = await rebindFixture(); const write = fs.promises.writeFile; let injected = false; let journalWrites = 0
  vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof write>) => {
    const result = await write(...args); const target = String(args[0])
    const journalTemp = target.startsWith(f.journal.file + '.')
    if (journalTemp) journalWrites++
    const match = boundary === 'prepare' ? journalTemp && journalWrites === 1 : boundary === 'bound' ? journalTemp && journalWrites === 2 :
      target.startsWith(path.join(f.repo, '.nodeterm', 'project.json') + '.')
    if (match && !injected) {
      injected = true
      const admin = fs.readFileSync(path.join(f.checkout, '.git'), 'utf8').trim().slice('gitdir: '.length)
      fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/different\n')
    }
    return result
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(injected).toBe(true); expect(f.recycle).not.toHaveBeenCalled()
  const reload = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reload.load()
  expect(reload.list()[0].rebind?.state).not.toBe('bound'); expect(reload.blocks(f.checkout)).toBe(true)
  expect(reload.isNodePending('terminal')).toBe(true)
})

it('rechecks target evidence after syncing an unchanged private index', async () => {
  const f = await rebindFixture(); const open = fs.promises.open; let injected = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[0] === path.join(root, 'data', 'workspace.json')) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync(); injected = true
        const admin = fs.readFileSync(path.join(f.checkout, '.git'), 'utf8').trim().slice('gitdir: '.length)
        fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/different\n')
      })
    }
    return handle
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(injected).toBe(true); expect(f.journal.list()[0].rebind?.state).toBe('prepared')
  expect(f.journal.blocks(f.checkout)).toBe(true)
})

it.each(['version', 'envelope', 'target', 'members', 'created', 'phase'] as const)('rejects invalid v4 rebind %s without discarding manual restrictions', async (change) => {
  const f = await rebindFixture(); expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: true })
  const envelope = JSON.parse(fs.readFileSync(f.journal.file, 'utf8')); const record = envelope.records[0]
  if (change === 'version') envelope.version = 3
  if (change === 'envelope') envelope.futureAuthority = true
  if (change === 'target') record.rebind.binding.path = f.repo
  if (change === 'members') record.rebind.members.pop()
  if (change === 'created') record.rebind.binding.createdByApp = true
  if (change === 'phase') record.phase = 'removed'
  const bytes = JSON.stringify(envelope); fs.writeFileSync(f.journal.file, bytes)
  await expect(f.journal.load()).rejects.toThrow()
  expect(f.journal.isNodePending('terminal')).toBe(true)
  expect(fs.readFileSync(f.journal.file, 'utf8')).toBe(bytes)
})

// Independent review regressions: bind durable bytes and the actual primary Git HEAD.
it.each(['folder', 'appdata', 'inline'] as const)('rejects changed %s serialized group before durability descriptor capture', async storage => {
  const f = await rebindFixture(storage)
  const content = storage === 'folder' ? path.join(f.repo, '.nodeterm', 'project.json') : path.join(root, 'data', 'inline-projects', 'project.json')
  const open = fs.promises.open.bind(fs.promises)
  let injected = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (String(args[0]) === content && !injected) {
      injected = true
      const data = JSON.parse(fs.readFileSync(content, 'utf8'))
      const group = data.nodes.find((n: { id: string }) => n.id === 'group')
      expect(group.worktree?.path).toBe(f.checkout)
      delete group.worktree
      group.cwd = f.repo
      fs.writeFileSync(content, JSON.stringify(data))
    }
    return open(...args)
  })
  const result = await f.service.rebind(f.row.id, f.owner)
  expect(injected).toBe(true)
  const persisted = (await new WorkspaceStore().load({ sideline: false })).projects[0].nodes.find(n => n.id === 'group')
  expect(persisted?.worktree).toBeUndefined()
  expect(result, 'must not release a path against metadata that was not durably bound').toMatchObject({ ok: false })
  expect(f.journal.blocks(f.checkout)).toBe(true)
})

it('pins the actual primary merge branch when the recorded repoPath is itself a linked checkout', async () => {
  const f = await missingFixture()
  const linkedRepo = path.join(root, 'linked-repo')
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'linked-base', linkedRepo], { stdio: 'pipe' })
  await f.writer.edit(fresh => { fresh.projects[0].nodes.find(n => n.id === 'group')!.worktree!.repoPath = linkedRepo })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true })
  const row = f.journal.list()[0]
  expect(row.repoPath).toBe(linkedRepo)
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'feature', f.checkout], { stdio: 'pipe' })
  f.confirmations.request.mockImplementationOnce(async () => {
    execFileSync('git', ['-C', f.repo, 'switch', '-c', 'new-main'], { stdio: 'pipe' })
    return { ok: true, consume: async () => true, current: () => f.owner.active(), cancel() {} }
  })
  const result = await f.service.rebind(row.id, f.owner)
  const actualMain = execFileSync('git', ['-C', f.repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
  expect(actualMain).toBe('new-main')
  expect(result, 'must refuse the branch change after displaying/approving the old baseRef').toMatchObject({ ok: false })
  expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
})

it('control: the primary repo case detects the same main branch change during consent', async () => {
  const f = await rebindFixture()
  f.confirmations.request.mockImplementationOnce(async () => {
    execFileSync('git', ['-C', f.repo, 'switch', '-c', 'new-main'], { stdio: 'pipe' })
    return { ok: true, consume: async () => true, current: () => f.owner.active(), cancel() {} }
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false })
  expect(f.journal.blocks(f.checkout)).toBe(true)
  expect(f.store.getNodeForHostAction('group')?.worktree).toBeUndefined()
})

it.each(['folder', 'appdata', 'inline'] as const)('refuses changed %s private execution projection before durability capture', async (storage) => {
  const f = await rebindFixture(storage); const open = fs.promises.open; let injected = false
  const index = path.join(root, 'data', 'workspace.json')
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (args[0] === index && !injected) {
      injected = true
      const bytes = JSON.parse(fs.readFileSync(index, 'utf8'))
      bytes.entries[0].localExec = {}
      fs.writeFileSync(index, JSON.stringify(bytes))
    }
    return open(...args)
  })
  expect(await f.service.rebind(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('durable-sync-content-changed') })
  expect(injected).toBe(true); expect(f.journal.blocks(f.checkout)).toBe(true)
  expect(f.journal.list()[0].rebind?.state).toBe('prepared'); expect(f.journal.isNodePending('terminal')).toBe(true)
})

it.each([false, true])('supports linked repo rebinding while pinning the primary HEAD through final publication (changed=%s)', async (change) => {
  const f = await missingFixture(); const linked = path.join(root, 'linked-repository')
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'linked-base', linked], { stdio: 'pipe' })
  await f.writer.edit((fresh) => { fresh.projects[0].nodes.find((n) => n.id === 'group')!.worktree!.repoPath = linked })
  expect(await f.service.recoverMissing('group', f.owner)).toMatchObject({ ok: true })
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-b', 'feature', f.checkout], { stdio: 'pipe' })
  const mark = f.journal.markRebound.bind(f.journal)
  if (change) vi.spyOn(f.journal, 'markRebound').mockImplementation(async (...args) => {
    execFileSync('git', ['-C', f.repo, 'switch', '-c', 'different-primary'], { stdio: 'pipe' })
    return mark(...args)
  })
  expect(await f.service.rebind(f.journal.list()[0].id, f.owner)).toMatchObject({ ok: !change })
  if (!change) expect(f.store.getNodeForHostAction('group')?.worktree?.baseRef).toBe('main')
  const reload = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reload.load()
  expect(reload.blocks(f.checkout)).toBe(change); expect(reload.isNodePending('terminal')).toBe(true)
})
