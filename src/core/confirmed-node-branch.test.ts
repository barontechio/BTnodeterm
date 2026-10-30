import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmedNodeBranch } from './confirmed-node-branch'
import { FakeHeadlessPty } from './test-headless-pty'
import { HeadlessNodeFactory, createHeadlessNodeOwnership } from './headless-node-factory'
import { OwnerConfirmationBroker } from './owner-confirmation'
import { WorkspaceStore } from './workspace-store'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import { IPC } from '../shared/ipc'

const originalId = 'c7e85670-0899-4094-abfb-261243f1fe37'
const newId = 'a341740a-a387-4b90-9acb-ec8a5a2ac33f'
const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', agentId: 'claude', title: id, color: '#000',
  group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, ...(id === 'target' ? { agentSessionId: originalId } : {}) })
const foreground = { panePid: 41, paneId: '%1', tty: '/dev/pts/1', command: 'claude', argv: ['claude'], pids: [42] }

describe('confirmed host Claude branch and real original-resume transaction', () => {
  let host: FakePlatform; let store: WorkspaceStore; let broker: OwnerConfirmationBroker
  let factory: HeadlessNodeFactory; let pty: FakeHeadlessPty; let branch: ConfirmedNodeBranch
  let runtimeId: string; let frame: string; let handed: boolean
  let deps: ConstructorParameters<typeof ConfirmedNodeBranch>[0]
  let submit: ReturnType<typeof vi.fn<(id: string, notice: () => void) => Promise<{ sent: true } | { sent: false; reason: 'draft' | 'failed' }>>>
  const prompt = async () => {
    await vi.waitFor(() => expect(host.sent.some((event) => event.channel === IPC.ownerConfirmationRequest)).toBe(true))
    return host.sent.filter((event) => event.channel === IPC.ownerConfirmationRequest).at(-1)!.args[0] as OwnerConfirmation
  }
  const approve = (request: OwnerConfirmation) => broker.decide(1, { id: request.id, token: request.token, proof: request.proof, answer: 'approve' })
  const run = () => branch.run('source', { node: 'target' }, true)
  beforeEach(async () => {
    host = fakePlatform({ isOwnerClient: (id) => id === 1 }); host.clients.push(1)
    initPlatform(host); store = new WorkspaceStore(); broker = new OwnerConfirmationBroker(host); broker.connect(1)
    await store.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Fixture', cwd: host.userDataDir,
      color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('source'), node('target')] }] })
    runtimeId = originalId; frame = 'Claude ready'; handed = false; pty = new FakeHeadlessPty()
    await pty.createHeadless({ cols: 80, rows: 24, persistKey: 'target' })
    const settings = { ...structuredClone(DEFAULT_SETTINGS), claudePermissionMode: 'manual' as const }
    const ownership = createHeadlessNodeOwnership(); ownership.record('target', { sourceNodeId: 'source', projectId: 'p' })
    factory = new HeadlessNodeFactory({ workspaceStore: store, ptyManager: pty, settings: () => settings, ownership,
      stateOf: () => 'done', sessionOf: (id) => id === 'target' ? runtimeId : undefined,
      cliCaps: async () => ({ version: null, autoPermissionMode: false, sessionIdFlag: false, fullscreenTui: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }), codexCaps: async () => ({ approvalValues: null }),
      codexSharedIdentity: async () => false, launchTiming: { quietMs: 0, capMs: 0 } })
    submit = vi.fn(async (_id, notice) => {
      await expect(pty.runNodeAction('target', 'write', { current: () => true }, () => {})).rejects.toThrow('busy')
      notice(); runtimeId = newId
      frame = `Branched conversation. You are now in the new branch (session ${newId}). Use /resume ${originalId} to return.`
      await store.updateWorkspace((workspace) => { workspace.projects[0].nodes[1].agentSessionId = newId; return workspace })
      return { sent: true }
    })
    deps = { workspace: store, settings: () => settings, scope: () => 'creator', stopped: () => false,
      ownsSpawn: (source, target) => factory.ownsSpawn(source, target), handedOver: () => handed,
      runtime: (id) => ({ agentId: 'claude', verified: true, sessionId: id === 'target' ? runtimeId : 'caller', state: 'done' }),
      confirmations: broker, originalAvailable: vi.fn(async () => true),
      onInputDispatched: vi.fn(() => { handed = true }), resumeOriginal: (...args) => factory.resumeClaudeOriginal(...args),
      pty: { runNodeAction: (...args) => pty.runNodeAction(...args), nodeExecutionIdentity: (id) => pty.nodeExecutionIdentity(id),
        paneOwner: vi.fn(async () => foreground), canBranchClaude: vi.fn(() => true),
        captureSession: vi.fn(async () => frame), branchClaudeInEmptyPrompt: submit } }
    branch = new ConfirmedNodeBranch(deps)
  })
  afterEach(() => { broker.dispose(); factory.stop(); resetPlatformForTests() })

  it('waits for individual owner consent, proves the new session and opens the original under the same coordinator', async () => {
    const pending = run(); const request = await prompt()
    expect(request.action).toBe('branch'); expect(submit).not.toHaveBeenCalled()
    await approve(request)
    const reply = await pending
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { outcome: 'branched', originalId, sessionId: newId } })
    const nodes = (await store.load()).projects[0].nodes
    const copy = nodes.find((candidate) => candidate.title.endsWith('(original)'))!
    expect(copy.agentSessionId).toBe(originalId)
    expect(pty.sends.find((send) => send.nodeId === copy.id)?.text).toContain(`--resume ${originalId}`)
    expect(deps.onInputDispatched).toHaveBeenCalledTimes(1)
  })

  it('refuses caller/flag/backend/transcript problems before prompting or typing', async () => {
    expect(await branch.run('source', { node: 'target' }, false)).toMatchObject({ ok: false })
    expect(await branch.run('source', { node: 'source' }, true)).toMatchObject({ ok: false })
    expect(await branch.run('source', { node: 'target', force: 'yes' }, true)).toMatchObject({ ok: false })
    vi.mocked(deps.pty.canBranchClaude).mockReturnValue(false)
    expect(await run()).toMatchObject({ ok: false })
    vi.mocked(deps.pty.canBranchClaude).mockReturnValue(true)
    vi.mocked(deps.originalAvailable).mockResolvedValue(false)
    expect(await run()).toMatchObject({ ok: false })
    expect(host.sent.filter((event) => event.channel === IPC.ownerConfirmationRequest)).toEqual([])
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects changed saved routing after the owner sees the request', async () => {
    const pending = run(); const request = await prompt()
    await store.updateWorkspace((workspace) => { workspace.projects[0].nodes[1].cwd = '/changed'; return workspace })
    await approve(request)
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(submit).not.toHaveBeenCalled(); expect((await store.load()).projects[0].nodes).toHaveLength(2)
  })

  it('refuses a second pending branch before opening another owner dialog', async () => {
    const first = run(); const request = await prompt()
    expect(await run()).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(host.sent.filter((event) => event.channel === IPC.ownerConfirmationRequest)).toHaveLength(1)
    await broker.decide(1, { id: request.id, token: request.token, proof: request.proof, answer: 'deny' })
    expect(await first).toMatchObject({ ok: false }); expect(submit).not.toHaveBeenCalled()
  })

  it('rechecks original transcript availability when consuming the owner approval', async () => {
    const pending = run(); const request = await prompt()
    vi.mocked(deps.originalAvailable).mockResolvedValue(false)
    await approve(request)
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(submit).not.toHaveBeenCalled()
  })

  it('preserves a draft and never marks a pre-send refusal as handed over', async () => {
    submit.mockResolvedValueOnce({ sent: false, reason: 'draft' })
    const pending = run(); await approve(await prompt())
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(deps.onInputDispatched).not.toHaveBeenCalled(); expect((await store.load()).projects[0].nodes).toHaveLength(2)
  })

  it('keeps failed delivery uncertain and prevents an immediate second branch', async () => {
    submit.mockResolvedValueOnce({ sent: false, reason: 'failed' })
    const pending = run(); await approve(await prompt())
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'uncertain' } })
    expect(await run()).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(submit).toHaveBeenCalledTimes(1); expect(deps.onInputDispatched).toHaveBeenCalledTimes(1)
    expect((await store.load()).projects[0].nodes).toHaveLength(2)
  })

  it('retains the target fence after owner departure until dispatched work settles', async () => {
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve })
    submit.mockImplementationOnce(async (_id, notice) => { notice(); await hold; return { sent: true } })
    const pending = run(); await approve(await prompt()); await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    broker.forgetClient(1)
    await expect(pty.runNodeAction('target', 'write', { current: () => true }, () => {})).rejects.toThrow('busy')
    release(); expect(await pending).toMatchObject({ ok: false, result: { outcome: 'uncertain' } })
    expect((await store.load()).projects[0].nodes).toHaveLength(2)
  })

  it('does not accept a session transition without the host submit-dispatch notice', async () => {
    submit.mockImplementationOnce(async () => { runtimeId = newId; return { sent: true } })
    const pending = run(); await approve(await prompt())
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'uncertain' } })
    expect((await store.load()).projects[0].nodes).toHaveLength(2)
  })

  it('refuses a changed foreground before input, and preserves a confirmed branch if the copy fails', async () => {
    vi.mocked(deps.pty.paneOwner).mockResolvedValueOnce(foreground).mockResolvedValueOnce({ ...foreground, pids: [99] })
    const first = run(); await approve(await prompt())
    expect(await first).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(submit).not.toHaveBeenCalled()
    host.sent.length = 0
    deps.resumeOriginal = vi.fn(async () => ({ ok: false, error: 'save refused', result: { id: 'recoverable-copy' } }))
    const second = run(); await approve(await prompt())
    expect(await second).toMatchObject({ ok: false, result: { outcome: 'branched', originalId, sessionId: newId,
      resume: { id: 'recoverable-copy' } } })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
