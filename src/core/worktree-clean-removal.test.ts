import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { initCanvasSync } from './canvas-sync'
import { WorkspaceStore } from './workspace-store'
import { CanvasContentWriter } from './canvas-content-writer'
import { WorktreeRemovalJournal } from './worktree-removal-journal'
import { WorktreeRecoveryService } from './worktree-recovery-service'
import { installWorktreeCanvasAdmission } from './worktree-canvas-admission'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import { NodeExecutionCoordinator, type NodeExecutionOptions, type NodeExecutionBatchPermit } from './node-execution'
import { OwnerConfirmationBroker } from './owner-confirmation'
import { OwnerLifetimes } from './owner-lifetimes'
import { GitService } from './git-service'
import { IPC } from '../shared/ipc'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Project } from '../shared/types'
import type { WorktreeRemovalTarget } from './worktree-removal-physical'

import { PtyManager } from './pty-manager'
import { makeTmuxTmpdir, SANDBOX_ENV } from './tmux-test-socket'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
const managers: PtyManager[] = []
const keys: string[] = []
const brokers: OwnerConfirmationBroker[] = []
let tmuxRoot = ''
beforeEach(() => {
  tmuxRoot = makeTmuxTmpdir('d-rm-', TMUX_SOCKET)
  vi.stubEnv('TMUX_TMPDIR', tmuxRoot); vi.stubEnv(SANDBOX_ENV, tmuxRoot)
})
afterEach(() => {
  for (const manager of managers.splice(0)) { manager.setNodeExecutionAdmission(null); manager.killAll() }
  for (const key of keys.splice(0)) {
    try { execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(key)}`], { stdio: 'ignore' }) } catch { /* already gone */ }
  }
  if (fs.existsSync('/usr/bin/tmux')) {
    try { execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* no remaining fixture server */ }
  }
  if (tmuxRoot) fs.rmSync(tmuxRoot, { recursive: true, force: true })
  for (const broker of brokers.splice(0)) broker.dispose(); resetPlatformForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(realBackend?: 'plain' | 'tmux') {
  const terminalId = realBackend ? `remove-${process.pid}-${Date.now()}` : 'terminal'
  const root = fs.realpathSync(testTmpDir('clean-removal-'))
  const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout'); const data = path.join(root, 'data')
  fs.mkdirSync(repo); fs.mkdirSync(data)
  const gitRun = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  gitRun('init', '-b', 'main'); gitRun('config', 'user.name', 'Fixture'); gitRun('config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(repo, 'tracked'), 'base'); gitRun('add', '.'); gitRun('commit', '-m', 'base'); gitRun('worktree', 'add', '-b', 'feature', checkout)
  const host = fakePlatform({ userDataDir: data, isOwnerClient: id => id === 1 }); host.clients.push(1); initPlatform(host); initCanvasSync()
  const node = (id: string, kind: CanvasNodeState['kind'], extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({ id, kind, title: id, color: '#fff', group: null,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, ...extra })
  const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    node('group', 'group', { worktree: { repoPath: repo, path: checkout, branch: 'feature', baseRef: 'main', createdByApp: true } }),
    node(terminalId, 'terminal', { parentId: 'group', cwd: checkout, pendingLaunch: { after: [], command: 'echo held', attempted: false } }),
    node('editor', 'editor', { parentId: 'group', filePath: path.join(checkout, 'tracked') })
  ] }
  const store = new WorkspaceStore(); await store.save({ version: 2, activeProjectId: project.id, projects: [project] }); await store.load({ sideline: false })
  const journal = new WorktreeRemovalJournal(path.join(data, 'journal.json'), { ownsFiles: () => true }); await journal.load()
  const admission = installWorktreeCanvasAdmission(store, journal); const dispatch = new WorktreeRecoveryDispatch(journal)
  const coordinator = new NodeExecutionCoordinator(); coordinator.setDispatchAdmission((id, permit, operation) => dispatch.assertAllowed(id, permit, operation))
  const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
  const broker = new OwnerConfirmationBroker(host); brokers.push(broker); broker.connect(1)
  let valid = true
  const assertPhysical = vi.fn(() => { if (!valid) throw new Error('worktree-removal-runtime-changed') })
  const target: WorktreeRemovalTarget = Object.freeze({ nodeId: 'terminal', identity: {}, assertCurrent: assertPhysical })
  const recycle = vi.fn(async (id: string, permit: NodeExecutionBatchPermit, approved?: WorktreeRemovalTarget) => {
    permit.assertCurrent(); coordinator.assertAllowed(id)
    expect(approved).toBe(target); expect(fs.existsSync(checkout)).toBe(false); expect(journal.list()[0].phase).toBe('removed')
  })
  const pty = { prepareWorktreeRemoval: vi.fn(async () => Object.freeze({ nodeIds: ['terminal'], targets: new Map([['terminal', target]]), assertCurrent: assertPhysical, revalidate: async () => assertPhysical() })),
    runWorktreeAction: <T>(ids: readonly string[], options: NodeExecutionOptions, work: (permit: NodeExecutionBatchPermit) => Promise<T> | T) => coordinator.runMany(ids, 'worktree', options, work),
    recycleWorktreeMember: recycle }
  let manager: PtyManager | undefined
  const settings = structuredClone(DEFAULT_SETTINGS)
  if (realBackend) {
    manager = new PtyManager(); managers.push(manager); keys.push(terminalId)
    settings.tmuxEnabled = realBackend === 'tmux'
    manager.init(() => settings)
    manager.setNodeExecutionAdmission((id, permit, operation) => dispatch.assertAllowed(id, permit, operation))
    const created = await manager.createHeadless({ persistKey: terminalId, ownerProjectId: project.id, cwd: checkout, shell: '/bin/bash', shellArgs: ['--noprofile', '--norc'], cols: 80, rows: 24, newOnly: true })
    if (realBackend === 'tmux') await vi.waitFor(async () => expect(await manager!.localTmuxExecution(terminalId)).toBeDefined())
    // Bash can still open its saved terminal descriptor after createHeadless resolves. Prove
    // it reached its read loop before capturing the removal proof, which correctly rejects
    // descriptor changes. Keep the marker outside the checkout so Git's clean check stays real.
    if (realBackend === 'plain') {
      const ready = path.join(root, 'plain-shell-ready')
      manager.write(null, created.sessionId, `printf ready > '${ready}'\r`)
      await vi.waitFor(() => expect(fs.readFileSync(ready, 'utf8')).toBe('ready'), { timeout: 10000 })
    }
  }
  const git = new GitService()
  const remove = vi.spyOn(git, 'worktreeRemoveClean')
  const service = new WorktreeRecoveryService({ journal, pty: manager ?? pty, git, repair: { workspace: store, admission, dispatch, confirmations: broker } })
  const approve = async (work?: () => Promise<void> | void) => {
    const operation = service.removeClean('group', owner)
    await vi.waitFor(() => expect(host.sent.some(m => m.channel === IPC.ownerConfirmationRequest)).toBe(true))
    await work?.()
    const request = host.sent.find(m => m.channel === IPC.ownerConfirmationRequest)!.args[0] as OwnerConfirmation
    expect(broker.decide(1, { id: request.id, token: request.token, proof: request.proof, answer: 'approve' })).toBe(true)
    return operation
  }
  return { settings, terminalId, manager, root, repo, checkout, store, journal, admission, dispatch, coordinator, owners, owner, broker, host, pty, recycle, git, remove, service, approve, gitRun,
    invalidate: () => { valid = false } }
}

describe('owner clean removal with real Git, broker and durable workspace', () => {
  it('orders intent/Git/absence/recycle/FIFO receipt and preserves nodes, held commands and layout', async () => {
    const f = await fixture(); f.remove.mockRestore()
    const actualRemove = f.git.worktreeRemoveClean.bind(f.git)
    const remove = vi.spyOn(f.git, 'worktreeRemoveClean').mockImplementation(async (...args) => {
      expect(f.journal.list()[0].phase).toBe('prepared'); expect(f.recycle).not.toHaveBeenCalled()
      return actualRemove(...args)
    })
    const writer = new CanvasContentWriter({ workspaceStore: f.store })
    const result = await f.approve(async () => {
      expect(f.coordinator.isBusy('terminal')).toBe(false); expect(f.admission.reservations.active()).toBe(false)
      await writer.edit(w => { w.projects[0].nodes.find(n => n.id === 'terminal')!.position.x = 123 })
    })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'recovered' })
    expect(remove).toHaveBeenCalledOnce(); expect(f.recycle).toHaveBeenCalledOnce()
    expect(f.gitRun('branch', '--list', 'feature')).toContain('feature')
    expect(f.store.getNodeForHostAction('terminal')).toMatchObject({ cwd: f.repo, position: { x: 123 }, pendingLaunch: { command: 'echo held', manualOnly: true } })
    expect(f.store.getNodeForHostAction('editor')).toMatchObject({ filePath: path.join(f.checkout, 'tracked'), fileMissing: true })
    expect(f.journal.list()[0]).toMatchObject({ phase: 'recovered', repair: { manualStart: ['terminal'] } })
    const reloaded = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reloaded.load()
    expect(reloaded.isNodePending('terminal')).toBe(true)
  })
  for (const kind of ['dirty', 'ignored', 'locked']) it(`preserves sessions when Git refuses ${kind}`, async () => {
    const f = await fixture()
    if (kind === 'dirty') fs.writeFileSync(path.join(f.checkout, 'tracked'), 'changed')
    if (kind === 'ignored') { fs.writeFileSync(path.join(f.repo, '.git/info/exclude'), '.env\n'); fs.writeFileSync(path.join(f.checkout, '.env'), 'secret') }
    if (kind === 'locked') f.gitRun('worktree', 'lock', f.checkout)
    expect(await f.approve()).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.recycle).not.toHaveBeenCalled(); expect(fs.existsSync(f.checkout)).toBe(true)
    expect(f.journal.list()[0].phase).toBe('prepared')
  })
  it('invalidates a physical replacement while owner confirmation is pending before durable intent', async () => {
    const f = await fixture()
    expect(await f.approve(f.invalidate)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([]); expect(f.recycle).not.toHaveBeenCalled()
  })
  it('records actual absence after owner departure during Git without dispatching teardown', async () => {
    const f = await fixture(); f.remove.mockRestore(); const actual = f.git.worktreeRemoveClean.bind(f.git)
    vi.spyOn(f.git, 'worktreeRemoveClean').mockImplementation(async (...args) => { const result = await actual(...args); f.owners.forget(1); return result })
    expect(await f.approve()).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(fs.existsSync(f.checkout)).toBe(false); expect(f.journal.list()[0].phase).toBe('removed'); expect(f.recycle).not.toHaveBeenCalled()
    expect(f.journal.isNodePending('terminal')).toBe(true)
  })
  it('refuses archive hooks and overlapping history before confirmation or Git', async () => {
    const f = await fixture(); await f.store.updateLocalProjectSettings('project', { setup: { archiveScript: 'echo archive' } })
    expect(await f.service.removeClean('group', f.owner)).toMatchObject({ ok: false, error: 'worktree-removal-archive-hook-unsupported' })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([]); expect(f.host.sent.some(m => m.channel === IPC.ownerConfirmationRequest)).toBe(false)
    await f.store.updateLocalProjectSettings('project', undefined)
    const st = fs.statSync(f.checkout, { bigint: true })
    await f.journal.prepare({ projectId: 'project', groupId: 'group', repoPath: f.repo, worktreePath: f.checkout, branch: 'feature', fallbackCwd: f.repo,
      directoryStamp: `${st.dev}:${st.ino}`, members: [{ nodeId: 'group', binding: 'a'.repeat(64) }] })
    expect(await f.service.removeClean('group', f.owner)).toMatchObject({ ok: false, error: 'worktree-removal-history-overlap' })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.journal.list()).toHaveLength(1)
  })
  it('retains factual absence without teardown after an uncertain Git acknowledgement', async () => {
    const f = await fixture(); f.remove.mockRestore(); const actual = f.git.worktreeRemoveClean.bind(f.git)
    vi.spyOn(f.git, 'worktreeRemoveClean').mockImplementation(async (...args) => {
      const result = await actual(...args); expect(result.ok).toBe(true)
      return { ok: false, recoveryRequired: true, message: 'lost reply' }
    })
    expect(await f.approve()).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0].phase).toBe('removed'); expect(f.recycle).not.toHaveBeenCalled()
  })
  it('protects a configured runtime root and its ancestors before any intent', async () => {
    const f = await fixture(); vi.stubEnv('XDG_RUNTIME_DIR', path.join(f.checkout, 'runtime'))
    expect(await f.service.removeClean('group', f.owner)).toMatchObject({ ok: false, error: 'worktree-removal-protected-root' })
    expect(f.journal.list()).toEqual([]); expect(f.remove).not.toHaveBeenCalled(); expect(f.recycle).not.toHaveBeenCalled()
  })
  it('refuses an unverifiable physical snapshot before confirmation or Git', async () => {
    const f = await fixture(); f.pty.prepareWorktreeRemoval.mockRejectedValueOnce(new Error('worktree-removal-cold-runtime-unverifiable'))
    expect(await f.service.removeClean('group', f.owner)).toMatchObject({ ok: false, error: 'worktree-removal-cold-runtime-unverifiable' })
    expect(f.journal.list()).toEqual([]); expect(f.remove).not.toHaveBeenCalled()
    expect(f.host.sent.some(m => m.channel === IPC.ownerConfirmationRequest)).toBe(false)
  })
  it('retains removed facts when the immutable metadata durability receipt fails', async () => {
    const f = await fixture(); const actual = f.store.updateWorkspaceForExecutionRepair.bind(f.store)
    vi.spyOn(f.store, 'updateWorkspaceForExecutionRepair').mockImplementation((hold, edit, before, after) => actual(hold, edit, before,
      async (workspace) => after?.(workspace, () => { throw new Error('receipt replaced') })))
    expect(await f.approve()).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.recycle).toHaveBeenCalledOnce(); expect(f.journal.list()[0].phase).toBe('removed'); expect(f.journal.isNodePending('terminal')).toBe(true)
  })
})

describe.skipIf(process.platform !== 'linux')('clean removal with real managed PTYs', () => {
  for (const backend of ['plain', 'tmux'] as const) it.skipIf(backend === 'tmux' && !fs.existsSync('/usr/bin/tmux'))(`removes after actual ${backend} proof and acknowledges its exact teardown`, async () => {
    const f = await fixture(backend)
    const before = f.manager!.nodeExecutionIdentity(f.terminalId)
    expect(before).toBeDefined()
    const result = await f.approve()
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'recovered' })
    expect(f.manager!.nodeExecutionIdentity(f.terminalId)).toBeUndefined()
    expect(f.journal.list()[0]).toMatchObject({ phase: 'recovered', repair: { manualStart: [f.terminalId] } })
    expect(f.store.getNodeForHostAction(f.terminalId)?.pendingLaunch?.command).toBe('echo held')
  }, 20000)
  it.skipIf(!fs.existsSync('/usr/bin/tmux'))('does not kill a same-name tmux replacement after Git removed the checkout', async () => {
    const f = await fixture('tmux'); const actual = f.manager!.recycleWorktreeMember.bind(f.manager)
    let replacementCreated = false
    vi.spyOn(f.manager!, 'recycleWorktreeMember').mockImplementationOnce(async (...args) => {
      // Keep this server alive: killing its last session and immediately starting another
      // races tmux shutdown, which would test failed fixture creation instead of replacement.
      const anchor = `${f.terminalId}-anchor`; keys.push(anchor)
      execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName(anchor), '-c', f.repo, '/bin/bash'])
      execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(f.terminalId)}`])
      execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName(f.terminalId), '-c', f.repo, '/bin/bash'])
      const replacement = execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', `=${sessionName(f.terminalId)}`, '#{session_id}'], { encoding: 'utf8' }).trim()
      expect(replacement).not.toBe(args[2]!.tmux!.sessionId)
      replacementCreated = true
      return actual(...args)
    })
    expect(await f.approve()).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0].phase).toBe('removed'); expect(replacementCreated).toBe(true)
    expect(() => execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', `=${sessionName(f.terminalId)}`])).not.toThrow()
  }, 20000)

  it.skipIf(!fs.existsSync('/usr/bin/tmux'))('protects the actual backend config and observed socket ancestors', async () => {
    const f = await fixture('tmux')
    const target = await f.manager!.localTmuxExecution(f.terminalId)
    expect(target).toBeDefined()
    await expect(f.manager!.prepareWorktreeRemoval([f.terminalId], path.join(f.root, 'data'))).rejects.toThrow('protected-root')
    await expect(f.manager!.prepareWorktreeRemoval([f.terminalId], path.dirname(target!.socketPath))).rejects.toThrow('protected-root')
    await expect(f.manager!.prepareWorktreeRemoval([f.terminalId], f.checkout)).resolves.toMatchObject({ nodeIds: [f.terminalId] })
    expect(fs.existsSync(f.checkout)).toBe(true); expect(f.remove).not.toHaveBeenCalled()
  }, 20000)

  it('refuses the configured linked Claude root from actual host settings before owner prompt or Git', async () => {
    const f = await fixture('plain')
    f.settings.claudeAccounts = [{ id: 'linked-review', label: 'Linked account', configDir: f.checkout, createdAt: Date.now() }]
    expect(await f.service.removeClean('group', f.owner)).toMatchObject({ ok: false, outcome: 'refused', error: 'worktree-removal-protected-root' })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([]); expect(fs.existsSync(f.checkout)).toBe(true)
    expect(f.host.sent.some(m => m.channel === IPC.ownerConfirmationRequest)).toBe(false)
  })
  it('invalidates consent when the actual configured account roots change during owner review', async () => {
    const f = await fixture('plain')
    expect(await f.approve(() => {
      f.settings.claudeAccounts = [{ id: 'linked-later', label: 'Linked during approval', configDir: f.checkout, createdAt: Date.now() }]
    })).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.remove).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([]); expect(fs.existsSync(f.checkout)).toBe(true)
  })

})
