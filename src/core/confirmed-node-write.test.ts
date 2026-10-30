import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import type { AgentId } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import type { EmptyPromptResult } from '../shared/text-delivery'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import { ConfirmedNodeWrite } from './confirmed-node-write'
import { NodeExecutionCoordinator } from './node-execution'
import { OwnerConfirmationBroker } from './owner-confirmation'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'

const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, agentId: 'claude', color: '#000',
  group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } })
const foreground: PaneOwner = { panePid: 41, paneId: '%1', tty: '/dev/pts/1', command: 'claude', argv: ['claude'], pids: [42] }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

describe('confirmed host node write', () => {
  let host: FakePlatform; let workspace: WorkspaceStore; let broker: OwnerConfirmationBroker
  let control: ConfirmedNodeWrite; let execution: NodeExecutionCoordinator
  let sourceSession: string; let targetSession: string; let state: 'done' | 'working'
  let physical: object; let owns: boolean; let stopped: boolean; let owner: PaneOwner
  let handedOver: boolean
  let paneOwner: ReturnType<typeof vi.fn<() => Promise<PaneOwner | null>>>
  let send: ReturnType<typeof vi.fn<(id: string, text: string, agentId: AgentId) => Promise<EmptyPromptResult>>>
  const run = () => control.run('source', { node: 'target', text: 'Review the implementation\nKeep my files.' }, true)
  const approve = (prompt: OwnerConfirmation) => broker.decide(1, { id: prompt.id, token: prompt.token, proof: prompt.proof, answer: 'approve' })
  async function prompt(): Promise<OwnerConfirmation> {
    const before = host.sent.filter((entry) => entry.channel === IPC.ownerConfirmationRequest)
    if (!before.length) await vi.waitFor(() => expect(host.sent.some((entry) => entry.channel === IPC.ownerConfirmationRequest)).toBe(true))
    return host.sent.filter((entry) => entry.channel === IPC.ownerConfirmationRequest).at(-1)!.args[0]
  }
  async function change(edit: (target: CanvasNodeState) => void) {
    await workspace.updateWorkspace((current) => { edit(current.projects[0].nodes[1]); return current })
  }
  beforeEach(async () => {
    host = fakePlatform({ isOwnerClient: (id) => id === 1 }); host.clients.push(1)
    initPlatform(host); workspace = new WorkspaceStore()
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Project', color: '#000',
      cwd: host.userDataDir, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('source'), node('target')] }] })
    sourceSession = 'source-session'; targetSession = 'target-session'; state = 'done'
    physical = {}; owns = true; stopped = false; owner = structuredClone(foreground)
    handedOver = false
    execution = new NodeExecutionCoordinator(); broker = new OwnerConfirmationBroker(host)
    paneOwner = vi.fn(async () => owner)
    send = vi.fn(async (_id: string, _text: string, _agentId: AgentId): Promise<EmptyPromptResult> => ({ sent: true }))
    control = new ConfirmedNodeWrite({ workspace, confirmations: broker, settings: () => DEFAULT_SETTINGS,
      runtime: (id) => ({ agentId: 'claude', sessionId: id === 'source' ? sourceSession : targetSession,
        state: id === 'target' ? state : 'working', verified: true }), scope: () => 'creator',
      ownsSpawn: () => owns, stopped: () => stopped,
      handedOver: () => handedOver,
      onInputDispatched: () => { expect(execution.isBusy('target')).toBe(true); handedOver = true },
      pty: { nodeExecutionIdentity: () => physical, paneOwner,
        runNodeAction: (...args) => execution.run(...args),
        sendToEmptyPrompt: async (id, text, agentId) => { execution.assertAllowed(id); return send(id, text, agentId) } } })
  })
  afterEach(() => { broker.dispose(); execution.dispose(); resetPlatformForTests() })

  it('refuses identity, unsupported flags, creator scope and absent owner without input', async () => {
    expect(await control.run('source', { node: 'target', text: 'hello' }, false)).toMatchObject({ ok: false })
    expect(await control.run('source', { node: 'target', text: 'hello', force: 'yes' }, true)).toMatchObject({ ok: false })
    owns = false; expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('created') })
    owns = true; expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('owner-unavailable') })
    expect(send).not.toHaveBeenCalled(); expect(host.sent).toEqual([])
  })

  it('shows the exact text, waits outside store queues, and consumes one approval for one dispatch', async () => {
    broker.connect(1); const pending = run(); const request = await prompt()
    expect(request).toMatchObject({ action: 'write', details: 'Review the implementation\nKeep my files.' })
    expect(send).not.toHaveBeenCalled()
    await change((target) => { target.position.x = 70 })
    expect(approve(request)).toBe(true)
    expect(await pending).toMatchObject({ ok: true, result: { outcome: 'submitted', typedAt: expect.any(Number) } })
    expect(approve(request)).toBe(false); expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('target', request.details, 'claude')
    host.sent.length = 0
    expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('handed-over') })
    expect(host.sent).toEqual([]); expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects saved cwd, account, session, physical generation and working-state replacements', async () => {
    broker.connect(1)
    for (const replace of [() => change((target) => { target.cwd = '/changed' }),
      () => change((target) => { target.accountId = 'missing-account' }),
      async () => { targetSession = 'new-session' }, async () => { physical = {} }, async () => { state = 'working' }]) {
      host.sent.length = 0; targetSession = 'target-session'; state = 'done'
      await change((target) => { delete target.cwd; delete target.accountId })
      const pending = run(); const request = await prompt(); await replace(); approve(request)
      expect(await pending).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses an agent process replacement even when its argv is unchanged', async () => {
    broker.connect(1); const pending = run(); const request = await prompt()
    owner = { ...foreground, pids: [43] }; approve(request)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('foreground') })
    expect(send).not.toHaveBeenCalled(); expect(execution.isBusy('target')).toBe(false)
  })

  it('does not turn a denial, SSH target or ambiguous project membership into terminal input', async () => {
    broker.connect(1); const pending = run(); const request = await prompt()
    broker.decide(1, { id: request.id, token: request.token, proof: request.proof, answer: 'deny' })
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('denied') })
    host.sent.length = 0
    await change((target) => { target.ssh = { host: 'remote.invalid', user: 'fixture' }; target.sshRemoteTmux = true })
    expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('SSH') })
    await change((target) => { delete target.ssh; delete target.sshRemoteTmux })
    await workspace.updateWorkspace((current) => {
      current.projects.push({ ...current.projects[0], id: 'other', nodes: [node('target')] })
      return current
    })
    expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('exactly one') })
    expect(host.sent).toEqual([]); expect(send).not.toHaveBeenCalled()
  })

  it('does not wait for or reuse approval across a competing host action', async () => {
    broker.connect(1); const hold = deferred()
    const action = execution.run('target', 'branch', { current: () => true }, () => hold.promise)
    const pending = run(); approve(await prompt())
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('busy') })
    hold.resolve(); await action; expect(send).not.toHaveBeenCalled()
  })

  it('keeps drafts untouched and makes a possibly pasted result explicit without retrying', async () => {
    broker.connect(1)
    for (const reason of ['draft', 'failed', 'not-submitted'] as const) {
      host.sent.length = 0; handedOver = false; send.mockResolvedValueOnce({ sent: false, reason })
      const pending = run(); approve(await prompt())
      expect(await pending).toMatchObject({ ok: false, result: { outcome: reason === 'draft' ? 'refused' : 'uncertain' } })
      expect(handedOver).toBe(reason !== 'draft')
    }
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('cancels a departed owner before dispatch, while retaining an in-flight exclusion', async () => {
    broker.connect(1); const hold = deferred()
    paneOwner.mockImplementationOnce(async () => owner).mockImplementationOnce(async () => { await hold.promise; return owner })
    const pending = run(); approve(await prompt())
    await vi.waitFor(() => expect(paneOwner).toHaveBeenCalledTimes(2))
    broker.forgetClient(1); expect(execution.isBusy('target')).toBe(true)
    hold.resolve(); expect(await pending).toMatchObject({ ok: false, result: { outcome: 'refused' } })
    expect(send).not.toHaveBeenCalled(); expect(execution.isBusy('target')).toBe(false)
  })

  it('reports uncertainty after owner departure during a dispatch and accepts a normal hook state transition', async () => {
    broker.connect(1); const hold = deferred()
    send.mockImplementationOnce(async () => { await hold.promise; return { sent: true } })
    const pending = run(); approve(await prompt()); await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    broker.forgetClient(1); hold.resolve()
    expect(await pending).toMatchObject({ ok: false, result: { outcome: 'uncertain' } })
    host.sent.length = 0; handedOver = false; broker.connect(1)
    send.mockImplementationOnce(async () => { state = 'working'; return { sent: true } })
    const second = run(); approve(await prompt())
    expect(await second).toMatchObject({ ok: true, result: { outcome: 'submitted' } })
    expect(send).toHaveBeenCalledTimes(2)
  })
})
