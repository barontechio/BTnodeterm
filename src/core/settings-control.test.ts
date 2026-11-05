import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { SettingsStore } from './settings-store'
import { WorkspaceStore } from './workspace-store'
import { OwnerConfirmationBroker } from './owner-confirmation'
import { SettingsControl } from './settings-control'
import { IPC } from '../shared/ipc'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import * as atomic from './fs-atomic'

describe('individually confirmed host settings changes', () => {
  let platform: FakePlatform
  let settings: SettingsStore
  let workspace: WorkspaceStore
  let broker: OwnerConfirmationBroker
  let control: SettingsControl
  let session: string
  let stopped: boolean
  const published = vi.fn()
  const run = (key = 'gridSize', value = '40') => control.run('source', { set: key, value }, true)
  const request = async () => {
    await vi.waitFor(() => expect(platform.sent.some((m) => m.channel === IPC.ownerConfirmationRequest)).toBe(true))
    return platform.sent.filter((m) => m.channel === IPC.ownerConfirmationRequest).at(-1)!.args[0] as OwnerConfirmation
  }
  const decide = (message: OwnerConfirmation, answer: 'approve' | 'deny' = 'approve') => broker.decide(1, {
    id: message.id, token: message.token, proof: message.proof, answer
  })
  beforeEach(async () => {
    session = 'session-a'; stopped = false; published.mockClear()
    platform = fakePlatform({ isOwnerClient: (id) => id === 1 }); platform.clients.push(1)
    resetPlatformForTests(); initPlatform(platform)
    settings = new SettingsStore(); settings.init()
    workspace = new WorkspaceStore()
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Project', cwd: platform.userDataDir,
      color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'source', kind: 'terminal', agentId: 'claude', title: 'Builder',
        group: null, color: '#000', position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, cwd: platform.userDataDir }] }] })
    broker = new OwnerConfirmationBroker(platform)
    control = new SettingsControl({ workspace, settings, confirmations: broker, runtime: () => ({ agentId: 'claude', sessionId: session }),
      publish: published, stopped: () => stopped })
  })
  afterEach(() => { broker.dispose(); vi.restoreAllMocks(); resetPlatformForTests() })

  it('refuses absent owners, forbidden fields, unverified identity and cross-project targets without writes', async () => {
    const before = structuredClone(settings.get())
    expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining('owner-unavailable') })
    broker.connect(1)
    expect(await run('agentBrowserControl', 'true')).toMatchObject({ ok: false, error: expect.stringContaining('forbidden') })
    expect(await control.run('source', { set: 'gridSize', value: '40' }, false)).toMatchObject({ ok: false, error: expect.stringContaining('identity-refused') })
    expect(await control.run('source', { set: 'agentMessaging', value: 'true', project: 'another' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('project-target-refused') })
    expect(settings.get()).toEqual(before); expect(platform.sent).toEqual([])
  })

  it('waits without blocking either store and commits only the approved field', async () => {
    broker.connect(1)
    const pending = run(); const prompt = await request()
    expect(prompt.message).toContain('40'); expect(settings.get().gridSize).not.toBe(40)
    await settings.patch({ fontSize: 22 })
    await workspace.updateWorkspace((fresh) => { fresh.projects[0].nodes.push({ ...fresh.projects[0].nodes[0], id: 'another' }); return fresh })
    expect(decide(prompt)).toBe(true)
    expect(await pending).toMatchObject({ ok: true, result: { key: 'gridSize', value: 40 } })
    expect(settings.get()).toMatchObject({ gridSize: 40, fontSize: 22 })
    expect((await workspace.load()).projects[0].nodes).toHaveLength(2)
  })

  it('uses the shared capability setter and keeps consent out of the shared file', async () => {
    broker.connect(1)
    const pending = run('agentMessaging', 'true'); decide(await request())
    expect(await pending).toMatchObject({ ok: true })
    const saved = (await workspace.load()).projects[0]
    expect(saved).toMatchObject({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } })
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ capabilityAck: { agentMessaging: 'kept' } }))
    const shared = JSON.parse(await fs.readFile(path.join(platform.userDataDir, '.nodeterm/project.json'), 'utf8'))
    expect(shared.agentMessaging).toBe(true); expect(shared.capabilityAck).toBeUndefined()
  })

  it('never treats a waiver as consent, and a denial performs no effect', async () => {
    broker.connect(1)
    const pending = run(); const prompt = await request(); decide(prompt, 'deny')
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('denied') })
    expect(settings.get().gridSize).not.toBe(40)
  })

  it.each(['value', 'session', 'account', 'deleted', 'stopped', 'logout'])('refuses an approval after %s changes', async (change) => {
    broker.connect(1)
    const pending = run(); const prompt = await request()
    if (change === 'value') await settings.patch({ gridSize: 32 })
    if (change === 'session') session = 'session-b'
    if (change === 'account' || change === 'deleted') await workspace.updateWorkspace((fresh) => {
      if (change === 'deleted') fresh.projects[0].nodes = []
      else fresh.projects[0].nodes[0].accountId = 'another-account'
      return fresh
    })
    if (change === 'stopped') stopped = true
    if (change === 'logout') broker.forgetClient(1)
    decide(prompt)
    expect(await pending).toMatchObject({ ok: false })
    expect(settings.get().gridSize).not.toBe(40)
  })

  it('compares the approved value again inside the settings FIFO', async () => {
    broker.connect(1)
    const pending = run(); const prompt = await request()
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve })
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve })
    const update = settings.update.bind(settings)
    vi.spyOn(settings, 'update').mockImplementationOnce(async (edit) => { entered(); await gate; return update(edit) })
    decide(prompt); await started
    await settings.patch({ gridSize: 32 }); resume()
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('stale') })
    expect(settings.get().gridSize).toBe(32)
  })

  it('revokes consumed permission when its owner disconnects before a queued write', async () => {
    broker.connect(1)
    const pending = run(); const prompt = await request()
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve })
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve })
    const update = settings.update.bind(settings)
    vi.spyOn(settings, 'update').mockImplementationOnce(async (edit) => { entered(); await gate; return update(edit) })
    decide(prompt); await started
    broker.forgetClient(1); resume()
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('stale') })
    expect(settings.get().gridSize).not.toBe(40)
  })

  it('preserves durable values on failed persistence and reports uncertainty', async () => {
    broker.connect(1)
    const pending = run(); const prompt = await request()
    vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'))
    decide(prompt)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('inspect the current setting') })
    expect(settings.get().gridSize).not.toBe(40)
  })
})
