import fs from 'node:fs'
import { OwnerConfirmationBroker, type ConfirmationIntent } from './owner-confirmation'
import { IPC } from '../shared/ipc'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
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

vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
let root: string; const managers: PtyManager[] = []; const brokers: OwnerConfirmationBroker[] = []; const keys: string[] = []
beforeEach(() => {
  root = fs.realpathSync(testTmpDir('manual-resume-'))
  initPlatform(fakePlatform({ userDataDir: root })); initCanvasSync()
})
afterEach(() => {
  for (const manager of managers.splice(0)) { manager.setNodeExecutionAdmission(null); manager.killAll() }
  keys.length = 0
  for (const broker of brokers.splice(0)) broker.dispose()
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
  const ownerPlatform = fakePlatform({ isOwnerClient: () => true })
  ownerPlatform.clients.push(1)
  const broker = new OwnerConfirmationBroker(ownerPlatform); brokers.push(broker)
  broker.connect(1)
  ownerPlatform.sendTo = (_id, channel, ...args) => {
    if (channel !== IPC.ownerConfirmationRequest) return
    const prompt = args[0] as OwnerConfirmation
    queueMicrotask(() => broker.decide(1, { id: prompt.id, token: prompt.token, proof: prompt.proof, answer: 'approve' }))
  }
  const confirmations = { request: vi.fn((intent: ConfirmationIntent) => broker.request(intent)) }
  const service = new WorktreeRecoveryService({ journal, pty: manager, git: { worktreeList: async () => ({ ok: true, entries: [] }) },
    repair: { workspace: store, admission, dispatch, confirmations } })
  return { manager, service, journal, store, dispatch, owner, owners, key, row, repo, settings, confirmations }
}


describe.skipIf(process.platform !== 'linux')('independent final publication adversarial regression', () => {
  it('refuses new input admission if the approved backend settings change during observed persistence', async () => {
    const f = await fixture()
    const observed = f.journal.markManualObserved.bind(f.journal)
    vi.spyOn(f.journal, 'markManualObserved').mockImplementationOnce(async (...args) => {
      const result = await observed(...args)
      f.settings.tmuxEnabled = true
      return result
    })
    const result = await f.service.resume(f.row.id, f.key, f.owner)
    if (result.ok) {
      const joined = await f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })
      f.manager.write(null, joined.sessionId, 'printf admitted > stale-profile-input.txt\r')
      await vi.waitFor(() => expect(fs.readFileSync(path.join(f.repo, 'stale-profile-input.txt'), 'utf8')).toBe('admitted'))
    }
    expect(result).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
    expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
    await expect(f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })).rejects.toThrow('recovery-required')
  })
  it('does not revoke an already admitted real Session for later settings changes', async () => {
    const f = await fixture()
    expect(await f.service.resume(f.row.id, f.key, f.owner)).toMatchObject({ ok: true })
    f.settings.tmuxEnabled = true
    expect(f.dispatch.manualSessionActive(f.key)).toBe(true)
    const joined = await f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })
    f.manager.write(null, joined.sessionId, 'printf established > established-session.txt\r')
    await vi.waitFor(() => expect(fs.readFileSync(path.join(f.repo, 'established-session.txt'), 'utf8')).toBe('established'))
  })

})
