import fs from 'node:fs'
import { AsyncResource } from 'node:async_hooks'
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

it.skipIf(process.platform !== 'linux')('review: changed actual project settings must refuse final admission', async () => {
  const { makeProjectSpawnOverrides } = await import('./project-spawn-overrides')
  const { ProjectTrustStore, localTrustKey, hashTrustContent } = await import('./project-trust-store')
  const { projectTrustContent } = await import('../shared/project-settings')
  const f = await fixture()
  const original = { agents: { env: { REVIEW_PROFILE: 'approved' } } }
  expect(await f.store.writeProjectSettings('project', original)).toBe(true)
  const trust = new ProjectTrustStore()
  await trust.record(localTrustKey(f.repo), 'agents', hashTrustContent(projectTrustContent('agents', original)!), new Date().toISOString())
  const read = makeProjectSpawnOverrides({ captureSettings: id => f.store.captureProjectSpawnSettings(id), readSettings: id => f.store.readProjectSettings(id),
    targetInfo: id => f.store.projectTargetInfo(id), trust })
  f.manager.setProjectSpawnOverrides(read)
  expect(await read('project')).toEqual({ env: { REVIEW_PROFILE: 'approved' } })
  const observed = f.journal.markManualObserved.bind(f.journal)
  vi.spyOn(f.journal, 'markManualObserved').mockImplementationOnce(async (...args) => {
    const result = await observed(...args)
    expect(await f.store.writeProjectSettings('project', { agents: { env: { REVIEW_PROFILE: 'changed' } } })).toBe(true)
    expect(await read('project')).toBeNull()
    return result
  })
  const result = await f.service.resume(f.row.id, f.key, f.owner)
  if (result.ok) {
    const joined = await f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })
    f.manager.write(null, joined.sessionId, 'printf admitted > stale-project-profile.txt\r')
    await vi.waitFor(() => expect(fs.readFileSync(path.join(f.repo, 'stale-project-profile.txt'), 'utf8')).toBe('admitted'))
    console.log('REVIEW_ACTUAL_STALE_PROJECT_INPUT', result, f.dispatch.manualSessionActive(f.key), f.journal.list()[0].repair?.manualStart)
  }
  expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
  expect(result).toMatchObject({ ok: false, outcome: 'uncertain' })
  expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
})

for (const change of ['none', 'trust', 'local'] as const) it.skipIf(process.platform !== 'linux')(`pins actual project profile sources through final publication (${change})`, async () => {
  const { makeProjectSpawnOverrides } = await import('./project-spawn-overrides')
  const { ProjectTrustStore, localTrustKey, hashTrustContent } = await import('./project-trust-store')
  const { projectTrustContent } = await import('../shared/project-settings')
  const f = await fixture(); const original = { agents: { env: { REVIEW_PROFILE: 'approved' } } }
  expect(await f.store.writeProjectSettings('project', original)).toBe(true)
  const trust = new ProjectTrustStore(); const key = localTrustKey(f.repo)
  await trust.record(key, 'agents', hashTrustContent(projectTrustContent('agents', original)!), new Date().toISOString())
  f.manager.setProjectSpawnOverrides(makeProjectSpawnOverrides({ captureSettings: id => f.store.captureProjectSpawnSettings(id),
    readSettings: id => f.store.readProjectSettings(id), targetInfo: id => f.store.projectTargetInfo(id), trust }))
  const observed = f.journal.markManualObserved.bind(f.journal)
  let localWrite: Promise<boolean> | undefined
  const externalWriter = new AsyncResource('manual-profile-independent-settings-writer')
  vi.spyOn(f.journal, 'markManualObserved').mockImplementationOnce(async (...args) => {
    const result = await observed(...args)
    if (change === 'trust') await trust.revoke(key, 'agents')
    // The actual API changes the live overlay before queueing its index write. Await that write
    // only after the held FIFO releases; publication must see the change even before disk does.
    if (change === 'local') localWrite = externalWriter.runInAsyncScope(() =>
      f.store.updateLocalProjectSettings('project', { agents: { env: { REVIEW_PROFILE: 'changed' } } }))
    return result
  })
  const result = await f.service.resume(f.row.id, f.key, f.owner)
  if (localWrite) expect(await localWrite).toBe(true)
  externalWriter.emitDestroy()
  expect(f.journal.list()[0].manualResume?.[0].state).toBe('observed')
  if (change === 'none') {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    const joined = await f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })
    f.manager.write(null, joined.sessionId, 'printf "$REVIEW_PROFILE" > actual-profile.txt\r')
    await vi.waitFor(() => expect(fs.readFileSync(path.join(f.repo, 'actual-profile.txt'), 'utf8')).toBe('approved'))
  } else {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, outcome: 'uncertain' })
    expect(f.dispatch.manualSessionActive(f.key)).toBe(false)
    await expect(f.manager.createHeadless({ persistKey: f.key, cols: 80, rows: 24 })).rejects.toThrow('recovery-required')
  }
})
