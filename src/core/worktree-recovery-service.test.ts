import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import { WorktreeRecoveryService } from './worktree-recovery-service'
import { WorktreeRemovalJournal, type WorktreeRemovalRecord } from './worktree-removal-journal'
import { NodeExecutionCoordinator } from './node-execution'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import { OwnerLifetimes } from './owner-lifetimes'
import { GitService } from './git-service'
import { setGitRemoteResolver } from './remote-ssh/remote-git'
import { writeFileDurableAtomic } from './fs-atomic'
import { testTmpDir } from './test-tmp'

let root: string; let repo: string; let checkout: string
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
describe.skipIf(process.platform === 'win32')('owner kept-checkout recovery against real Git and durable facts', () => {
  beforeEach(() => {
    root = fs.realpathSync(testTmpDir('worktree-keep-recovery-')); repo = path.join(root, 'repo'); checkout = path.join(root, 'checkout')
    fs.mkdirSync(repo)
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    fs.writeFileSync(path.join(repo, 'tracked'), 'base'); git('add', 'tracked'); git('commit', '-m', 'base')
    git('worktree', 'add', '-b', 'feature', checkout)
  })
  async function fixture() {
    let fail = false
    const journal = new WorktreeRemovalJournal(path.join(root, 'removals.json'), { ownsFiles: () => true,
      persist: async (file, data) => { await writeFileDurableAtomic(file, data, { mode: 0o600 }); if (fail) throw new Error('acknowledgement lost') } })
    await journal.load()
    const stat = fs.lstatSync(checkout, { bigint: true })
    const row = await journal.prepare({ projectId: 'project', groupId: 'group', repoPath: repo, worktreePath: checkout,
      branch: 'feature', fallbackCwd: repo, directoryStamp: `${stat.dev}:${stat.ino}`,
      members: [{ nodeId: 'group', binding: 'a'.repeat(64) }, { nodeId: 'member', binding: 'b'.repeat(64) }] })
    const coordinator = new NodeExecutionCoordinator(); const dispatch = new WorktreeRecoveryDispatch(journal)
    coordinator.setDispatchAdmission((id, permit) => dispatch.assertAllowed(id, permit))
    const backend = new GitService()
    const pty = { runWorktreeAction: <T>(ids: readonly string[], options: Parameters<NodeExecutionCoordinator['runMany']>[2],
      work: (permit: Parameters<Parameters<NodeExecutionCoordinator['runMany']>[3]>[0]) => T | Promise<T>) => coordinator.runMany(ids, 'worktree', options, work) }
    const service = new WorktreeRecoveryService({ journal, pty, git: backend })
    const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
    return { journal, row, coordinator, service, owner, owners, pty, backend, fail: () => { fail = true } }
  }

  it('keeps dirty files, the branch and sessions while releasing the original prepared record', async () => {
    const f = await fixture(); fs.writeFileSync(path.join(checkout, 'unfinished'), 'preserve me')
    expect(f.service.list(f.owner)).toMatchObject({ ok: true, records: [{ path: checkout, memberIds: ['group', 'member'] }] })
    const wire = JSON.stringify(f.service.list(f.owner))
    expect(wire).not.toContain('binding'); expect(wire).not.toContain('directoryStamp')
    expect(await f.service.inspect(f.row.id, f.owner)).toMatchObject({ ok: true, status: 'kept' })
    expect(() => f.coordinator.assertAllowed('member')).toThrow('recovery-required')
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: true, outcome: 'kept' })
    expect(fs.readFileSync(path.join(checkout, 'unfinished'), 'utf8')).toBe('preserve me')
    expect(git('branch', '--list', 'feature')).toContain('feature')
    expect(f.journal.list()).toEqual([]); expect(() => f.coordinator.assertAllowed('member')).not.toThrow()
  })

  it('refuses missing and changed directories without pruning, deleting or dropping recovery facts', async () => {
    const f = await fixture(); fs.renameSync(checkout, path.join(root, 'original-checkout'))
    expect(await f.service.inspect(f.row.id, f.owner)).toMatchObject({ ok: true, status: 'missing' })
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    fs.mkdirSync(checkout); fs.writeFileSync(path.join(checkout, 'unrelated'), 'keep this')
    expect(await f.service.inspect(f.row.id, f.owner)).toMatchObject({ ok: true, status: 'changed' })
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(fs.readFileSync(path.join(checkout, 'unrelated'), 'utf8')).toBe('keep this')
    expect(f.journal.list()).toEqual([f.row]); expect(f.journal.isNodePending('member')).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(checkout)
  })

  it('refuses a changed branch and a recorded removal, even if a directory is currently present', async () => {
    const f = await fixture()
    execFileSync('git', ['-C', checkout, 'checkout', '-b', 'replacement'], { stdio: 'ignore' })
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.journal.isNodePending('member')).toBe(true)
    execFileSync('git', ['-C', checkout, 'checkout', 'feature'], { stdio: 'ignore' })
    await f.journal.markRemoved(f.row.id)
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, error: expect.stringContaining('different recovery') })
    expect(f.journal.list()[0].phase).toBe('removed')
  })

  it('cancels after owner departure while Git proof is pending and retains the actual node claims until it settles', async () => {
    const f = await fixture(); const started = deferred(); const done = deferred()
    const service = new WorktreeRecoveryService({ journal: f.journal, pty: f.pty, git: { worktreeList: async (directory) => {
      started.resolve(); await done.promise; return f.backend.worktreeList(directory)
    } } })
    const work = service.keep(f.row.id, f.owner); await started.promise; f.owners.forget(1)
    expect(f.coordinator.isBusy('member')).toBe(true)
    expect(await service.keep(f.row.id, f.owners.get(2, () => true))).toMatchObject({ ok: false })
    done.resolve(); expect(await work).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.coordinator.isBusy('member')).toBe(false); expect(f.journal.list()).toEqual([f.row])
  })

  it('reports uncertain publication and preserves known quarantine until recovery state is reloaded', async () => {
    const f = await fixture(); f.fail()
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.isNodePending('member')).toBe(true)
    const reconstructed = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true })
    expect(await reconstructed.load()).toEqual([])
    expect(reconstructed.isNodePending('member')).toBe(false)
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('base')
  })

  it('binds the saved local Git destination even while another project has installed a global remote resolver', async () => {
    const f = await fixture()
    setGitRemoteResolver(() => { throw new Error('wrong remote destination') })
    try { expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: true }) }
    finally { setGitRemoteResolver(null) }
  })

  it('refuses inactive owners and unknown references, and distinguishes an unreadable Git list from a changed checkout', async () => {
    const f = await fixture(); const unavailable = new WorktreeRecoveryService({ journal: f.journal, pty: f.pty,
      git: { worktreeList: async () => ({ ok: false, entries: [] }) } })
    expect(await unavailable.inspect(f.row.id, f.owner)).toMatchObject({ ok: true, status: 'unavailable' })
    expect(await unavailable.keep(f.row.id, f.owner)).toMatchObject({ ok: false })
    expect(await f.service.keep('unknown', f.owner)).toMatchObject({ ok: false })
    f.owners.forget(1)
    expect(f.service.list(f.owner)).toMatchObject({ ok: false, error: 'worktree-recovery-owner-required' })
    expect(await f.service.keep(f.row.id, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.journal.list()).toEqual([f.row] satisfies WorktreeRemovalRecord[])
  })
})
