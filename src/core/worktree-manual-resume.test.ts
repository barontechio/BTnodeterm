import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createManualTmux } from './worktree-manual-shell'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { initCanvasSync } from './canvas-sync'
import { WorkspaceStore } from './workspace-store'
import { canvasExecutionBinding } from './canvas-execution-reservations'
import { installWorktreeCanvasAdmission } from './worktree-canvas-admission'
import { WorktreeRemovalJournal } from './worktree-removal-journal'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import { WorktreeRecoveryService } from './worktree-recovery-service'
import { OwnerLifetimes } from './owner-lifetimes'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Project } from '../shared/types'
import { PtyManager } from './pty-manager'
import { SANDBOX_ENV } from './tmux-test-socket'
import { execFileSync } from 'node:child_process'
import { TMUX_SOCKET, sessionName } from './tmux-naming'

vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
let root: string; const managers: PtyManager[] = []; const keys: string[] = []
beforeEach(() => {
  root = fs.realpathSync(testTmpDir('manual-resume-'))
  initPlatform(fakePlatform({ userDataDir: root })); initCanvasSync()
})
afterEach(() => {
  for (const manager of managers.splice(0)) { manager.setNodeExecutionAdmission(null); manager.killAll() }
  for (const key of keys.splice(0)) {
    try { execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(key)}`], { stdio: 'ignore' }) } catch { /* already exited */ }
  }
  resetPlatformForTests(); vi.restoreAllMocks()
})
async function fixture(tmux = false) {
  expect(process.env.TMUX_TMPDIR).toBe(process.env[SANDBOX_ENV]); expect(process.env[SANDBOX_ENV]).toBeTruthy()
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  const checkout = path.join(root, 'missing')
  const key = `resume-${process.pid}-${Date.now()}-${keys.length}`; keys.push(key)
  const node = (id: string, kind: CanvasNodeState['kind'], extra = {}): CanvasNodeState => ({ id, kind, title: id, color: '#fff', group: null,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, ...extra })
  const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    node('group', 'group', { cwd: repo }), node(key, 'terminal', { parentId: 'group', cwd: repo, shell: '/bin/bash',
      pendingLaunch: { after: [], command: 'touch HELD_COMMAND_MUST_NOT_RUN', attempted: false, manualOnly: true } })] }
  const store = new WorkspaceStore(); await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  const saved = (await store.load({ sideline: false })).projects[0]
  const members = saved.nodes.map((entry) => ({ nodeId: entry.id, binding: canvasExecutionBinding(saved, entry) }))
  const journal = new WorktreeRemovalJournal(path.join(root, 'journal.json'), { ownsFiles: () => true }); await journal.load()
  const row = await journal.prepare({ projectId: 'project', groupId: 'group', repoPath: repo, worktreePath: checkout,
    branch: 'feature', fallbackCwd: repo, directoryStamp: '1:2', members })
  await journal.markRemoved(row.id); await journal.planRepair(row.id, { members, manualStart: [key] }, () => {}); await journal.markRecovered(row.id)
  const admission = installWorktreeCanvasAdmission(store, journal); const dispatch = new WorktreeRecoveryDispatch(journal)
  const manager = new PtyManager(); managers.push(manager)
  const settings = structuredClone(DEFAULT_SETTINGS); settings.tmuxEnabled = tmux
  manager.init(() => settings)
  manager.setNodeExecutionAdmission((id, permit, operation) => dispatch.assertAllowed(id, permit, operation))
  const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
  const confirmations = { request: vi.fn(async () => ({ ok: true as const, consume: async () => true, current: () => owner.active(), cancel() {} })) }
  const service = new WorktreeRecoveryService({ journal, pty: manager, git: { worktreeList: async () => ({ ok: true, entries: [] }) },
    repair: { workspace: store, admission, dispatch, confirmations } })
  return { manager, service, journal, store, dispatch, owner, owners, key, row, repo, settings, confirmations }
}

describe.skipIf(process.platform !== 'linux')('manual recovery with real local processes', () => {
  for (const tmux of [false, true]) it.skipIf(tmux && !fs.existsSync('/usr/bin/tmux'))(`creates and durably admits only the actual shell (tmux=${tmux})`, async () => {
    const f = await fixture(tmux)
    const result = await f.service.resume(f.row.id, f.key, f.owner)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'resumed' })
    expect(f.dispatch.manualSessionActive(f.key)).toBe(true)
    expect(f.journal.list()[0]).toMatchObject({ repair: { manualStart: [f.key] }, manualResume: [{ state: 'observed', evidence: { backend: tmux ? 'tmux' : 'plain' } }] })
    expect(fs.existsSync(path.join(f.repo, 'HELD_COMMAND_MUST_NOT_RUN'))).toBe(false)
    const joined = await f.manager.createHeadless({ persistKey: f.key, ownerProjectId: 'project', cwd: f.repo, cols: 80, rows: 24 })
    expect(joined.fresh).toBe(false)
    f.manager.write(null, joined.sessionId, 'printf verified > actual-input.txt\r')
    await vi.waitFor(() => expect(fs.readFileSync(path.join(f.repo, 'actual-input.txt'), 'utf8')).toBe('verified'))
    await expect(f.manager.sendText(f.key, 'touch HELD_COMMAND_MUST_NOT_RUN', { enter: true })).rejects.toThrow('recovery-required')
    const reloaded = new WorktreeRemovalJournal(f.journal.file, { ownsFiles: () => true }); await reloaded.load()
    expect(() => new WorktreeRecoveryDispatch(reloaded).assertAllowed(f.key, undefined, { kind: 'input', target: f.manager.nodeExecutionIdentity(f.key) })).toThrow('recovery-required')
  }, 20000)
  it('records a real effect after owner loss, blocks input, and reconciles that exact live Session with fresh consent', async () => {
    const f = await fixture()
    const create = f.manager.createManualShell.bind(f.manager)
    vi.spyOn(f.manager, 'createManualShell').mockImplementationOnce(async (...args) => {
      const result = await create(...args); f.owners.forget(1); return result
    })
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
    const original = f.manager.nodeExecutionIdentity(f.key)
    await expect(f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })).rejects.toThrow('recovery-required')
    const nextOwner = f.owners.get(2, () => true)
    f.confirmations.request.mockImplementation(async () => ({ ok: true, consume: async () => true, current: () => nextOwner.active(), cancel() {} }))
    const result = await f.service.resume(f.row.id, f.key, nextOwner)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(f.manager.nodeExecutionIdentity(f.key)).toBe(original)
    expect(f.journal.list()[0].manualResume).toHaveLength(1)
  })

  it('never repeats an uncertain physical creation without a verifiable host Session', async () => {
    const f = await fixture()
    const create = vi.spyOn(f.manager, 'createManualShell').mockResolvedValue({ ok: false, dispatched: true, error: 'lost backend reply' })
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('dispatching')
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'refused', error: expect.stringContaining('uncertain') })
    expect(create).toHaveBeenCalledOnce()
  })

  it('revokes live admission when the held FIFO loses its final acknowledgement', async () => {
    const f = await fixture()
    const repair = f.store.updateWorkspaceForExecutionRepair.bind(f.store)
    vi.spyOn(f.store, 'updateWorkspaceForExecutionRepair').mockImplementationOnce(async (...args) => {
      await repair(...args); throw new Error('lost final acknowledgement')
    })
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
  })

  it('refuses profile changes after approval and preserves the prepared manual restriction', async () => {
    const f = await fixture()
    const create = f.manager.createManualShell.bind(f.manager)
    vi.spyOn(f.manager, 'createManualShell').mockImplementationOnce(async (...args) => {
      f.settings.defaultShell = '/bin/sh'; return create(...args)
    })
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(f.journal.list()[0]).toMatchObject({ manualResume: [{ state: 'refused' }], repair: { manualStart: [f.key] } })
    expect(f.manager.nodeExecutionIdentity(f.key)).toBeUndefined()
  })

  it.skipIf(!fs.existsSync('/usr/bin/tmux'))('the actual new-only tmux command refuses a name created after an absence probe', async () => {
    const f = await fixture(true)
    const args = ['-L', TMUX_SOCKET, 'new-session', '-A', '-D', '-s', sessionName(f.key), '-c', f.repo, '/bin/bash']
    const first = createManualTmux('/usr/bin/tmux', args, randomUUID(), { ...process.env } as Record<string, string>, f.repo, () => {})
    expect(() => createManualTmux('/usr/bin/tmux', args, randomUUID(), { ...process.env } as Record<string, string>, f.repo, () => {})).toThrow()
    const actual = execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', first.paneId, '#{session_id}|#{pane_pid}'], { encoding: 'utf8' }).trim()
    expect(actual).toBe(`${first.sessionId}|${first.panePid}`)
  })

  it.skipIf(!fs.existsSync('/usr/bin/tmux'))('invalidates input when the real tmux pane is replaced under the same Session', async () => {
    const f = await fixture(true)
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: true })
    const proof = f.journal.list()[0].manualResume![0].evidence!
    if (proof.backend !== 'tmux') throw new Error('expected tmux evidence')
    const target = f.manager.nodeExecutionIdentity(f.key)
    execFileSync('/usr/bin/tmux', ['-L', TMUX_SOCKET, 'respawn-pane', '-k', '-t', proof.paneId, '/bin/bash'])
    expect(f.manager.nodeExecutionIdentity(f.key)).toBe(target)
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
    await expect(f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })).rejects.toThrow('recovery-required')
  })

  it('retains history and requires fresh consent for a new plain process after exit', async () => {
    const f = await fixture()
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: true })
    const joined = await f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })
    f.manager.write(null, joined.sessionId, 'exit\r')
    await vi.waitFor(() => expect(f.manager.nodeExecutionIdentity(f.key)).toBeUndefined(), { timeout: 5000 })
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
    await expect(f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })).rejects.toThrow('recovery-required')
    const next = await f.service.resume(f.row.id, f.key, f.owner)
    expect(next, JSON.stringify(next)).toMatchObject({ ok: true })
    expect(f.journal.list()[0].manualResume).toHaveLength(2)
    expect(f.confirmations.request).toHaveBeenCalledTimes(2)
  })

  it('records creation but denies input when saved bytes change during final journal publication', async () => {
    const f = await fixture()
    const observed = f.journal.markManualObserved.bind(f.journal)
    vi.spyOn(f.journal, 'markManualObserved').mockImplementationOnce(async (...args) => {
      const result = await observed(...args)
      const file = path.join(f.repo, '.nodeterm', 'project.json')
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      data.nodes.find((node: { id: string }) => node.id === f.key).shell = '/bin/sh'
      fs.writeFileSync(file, JSON.stringify(data))
      return result
    })
    const result = await f.service.resume(f.row.id, f.key, f.owner)
    expect(result).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('durable-sync') })
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
  })

  it('refuses an unverified custom host profile reader instead of approving its fallback', async () => {
    const f = await fixture()
    f.manager.setProjectSpawnOverrides(async () => { throw new Error('profile read failed') })
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: false, outcome: 'refused', error: expect.stringContaining('manual-shell-profile-source-unavailable') })
    expect(f.confirmations.request).not.toHaveBeenCalled()
    expect(f.journal.list()[0].manualResume).toBeUndefined()
  })

  it('keeps private backend argv and process diagnostics out of the owner reply', async () => {
    const f = await fixture()
    vi.spyOn(f.manager, 'createManualShell').mockResolvedValue({ ok: false, dispatched: true,
      error: 'Command failed: tmux -e NODETERM_RECOVERY_ID=PRIVATE_NONCE /proc/123456/stat' })
    const result = await f.service.resume(f.row.id, f.key, f.owner)
    expect(result).toMatchObject({ ok: false, outcome: 'uncertain', error: expect.stringContaining('manual-shell-verification-failed') })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NONCE')
    expect(JSON.stringify(result)).not.toContain('123456')
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('dispatching')
  })

})
