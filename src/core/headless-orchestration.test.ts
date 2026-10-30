import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import { HeadlessNodeFactory, type HeadlessNodeFactoryDeps } from './headless-node-factory'
import { FakeHeadlessPty } from './test-headless-pty'
import { DEFAULT_SETTINGS, type CanvasMutation, type CanvasNodeState } from '../shared/types'
import type { AgentState } from '../shared/agents/normalize'
import { isWaitRope } from '../shared/canvas-lineage'
import { accountConfigDir } from './claude-accounts-core'
import { WebPreviews } from './web-previews'

describe('host team execution without a renderer', () => {
  let store: WorkspaceStore
  let factory: HeadlessNodeFactory
  let pty: FakeHeadlessPty
  let deps: HeadlessNodeFactoryDeps
  let dir: string
  let states: Record<string, AgentState>
  let ops: CanvasMutation[]
  const read = async () => (await store.load()).projects[0]
  const source: CanvasNodeState = { id: 'src', kind: 'terminal', agentId: 'claude', title: 'Director',
    color: '#0a84ff', group: null, position: { x: 200, y: 100 }, size: { width: 640, height: 440 } }

  beforeEach(async () => {
    dir = testTmpDir('core-orchestration-'); fs.mkdirSync(path.join(dir, 'data'))
    resetPlatformForTests(); initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') }))
    store = new WorkspaceStore(); pty = new FakeHeadlessPty(); states = { src: 'working' }; ops = []
    await store.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Team', color: '#0a84ff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [source] }] })
    deps = { workspaceStore: store, ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS, snapToGrid: false }),
      stateOf: (id) => states[id], stateVerified: () => true, contextShimPath: () => '/context.sh',
      cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }), codexCaps: async () => ({ approvalValues: null }),
      codexSharedIdentity: async () => false, launchTiming: { quietMs: 0, capMs: 0 },
      publishMutation: (_id, op) => ops.push(op) }
    factory = new HeadlessNodeFactory(deps)
  })
  afterEach(() => { factory.stop(); vi.restoreAllMocks(); resetPlatformForTests() })

  it('saves the complete frame and members before starting any of them', async () => {
    pty.beforeCreate = async () => {
      const p = await read()
      expect(p.nodes).toHaveLength(4)
      expect(p.nodes.filter((n) => n.id !== 'src' && n.kind === 'terminal').every((n) => n.pendingLaunch?.attempted)).toBe(true)
      expect(p.ropes).toHaveLength(2)
    }
    const reply = await factory.orchestrate('spawn-team', 'src', { label: 'Build', team: JSON.stringify([
      { title: 'UI', agent: 'claude', prompt: 'Build UI' }, { title: 'API', agent: 'gemini', prompt: 'Build API' }
    ]) }, true)
    expect(reply.ok).toBe(true)
    const p = await read()
    const group = p.nodes.find((n) => n.kind === 'group')!
    const members = p.nodes.filter((n) => n.parentId === group.id)
    expect(group.title).toBe('Build'); expect(members.map((n) => n.title)).toEqual(['UI', 'API'])
    expect(members.every((n) => !n.pendingLaunch && n.openedBy === 'src')).toBe(true)
    expect(p.nodes.find((n) => n.id === 'src')).toEqual(source)
    expect(pty.sends).toHaveLength(2)
    expect(ops.some((op) => op.op === 'edge-upsert')).toBe(true)
    expect(factory.openerOf(group.id)?.sourceNodeId).toBe('src')
  })

  it('opens reviewers behind the actual target and releases the verdict only after real reviewer turns', async () => {
    const reply = await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness,security' }, true)
    expect(reply.ok).toBe(true)
    expect(pty.sends).toEqual([])
    const result = reply.result as { reviewerIds: string[]; judgeId: string }
    const sendEvent = async (id: string, state: AgentState) => { states[id] = state; await factory.refreshArmed({ nodeId: id, state }) }
    await sendEvent('src', 'done')
    expect(pty.sends.map((s) => s.nodeId).sort()).toEqual([...result.reviewerIds].sort())
    for (const id of result.reviewerIds) await sendEvent(id, 'done')
    expect(pty.sends).toHaveLength(2)
    for (const id of result.reviewerIds) { await sendEvent(id, 'working'); await sendEvent(id, 'done') }
    expect(pty.sends.map((s) => s.nodeId)).toContain(result.judgeId)
    const p = await read()
    expect(p.nodes.find((n) => n.id === result.judgeId)?.pendingLaunch).toBeUndefined()
    expect(p.ropes!.filter(isWaitRope)).toHaveLength(4)
  })

  it('dry-runs and malformed teams create no nodes, prompt spills or sessions', async () => {
    const before = await store.load()
    expect(await factory.orchestrate('spawn-team', 'src', { team: '[{"prompt":"hello"}]', 'dry-run': '' }, true)).toMatchObject({ ok: true, result: { dryRun: true } })
    expect(await factory.orchestrate('spawn-team', 'src', { team: '[{"title":"missing brief"}]' }, true)).toMatchObject({ ok: false })
    expect(await factory.orchestrate('spawn-team', 'src', { team: '[{"prompt":"hello","agent":"unknown"}]' }, true)).toMatchObject({ ok: false })
    expect(await factory.orchestrate('verify', 'src', { node: 'src' }, false)).toMatchObject({ ok: false })
    expect(await store.load()).toEqual(before); expect(pty.creates).toEqual([]); expect(ops).toEqual([])
    expect(fs.existsSync(path.join(dir, 'data', 'launch-prompts'))).toBe(false)
  })

  it('does not restart persisted holds or create sessions after the owning process stops', async () => {
    await factory.orchestrate('verify', 'src', { node: 'src', synthesis: 'off' }, true)
    factory.stop()
    const count = pty.creates.length
    factory = new HeadlessNodeFactory(deps)
    states.src = 'done'
    await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    expect(pty.sends).toEqual([]); expect(pty.creates).toHaveLength(count)
  })

  it('spills long briefs into owner-only files and holds a missing brief for explicit recovery', async () => {
    const reply = await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'security', synthesis: 'off', focus: 'detail '.repeat(250) }, true)
    expect(reply.ok).toBe(true)
    const reviewer = (await read()).nodes.find((n) => n.agentId && n.id !== 'src')!
    const file = reviewer.pendingLaunch!.promptFile!
    expect(fs.readFileSync(file, 'utf8')).toContain('detail detail')
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    fs.unlinkSync(file)
    states.src = 'done'; await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    expect(pty.sends).toEqual([])
    expect((await read()).nodes.find((n) => n.id === reviewer.id)!.pendingLaunch).toMatchObject({ manualOnly: true })
    expect(await factory.runFromOwner(reviewer.id, reviewer.pendingLaunch!.command)).toMatchObject({ started: false })
    expect(pty.sends).toEqual([])
  })

  it('serializes an owner retry behind automatic delivery and never types the same launch twice', async () => {
    const reply = await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness', synthesis: 'off' }, true)
    expect(reply.ok).toBe(true)
    const reviewer = (await read()).nodes.find((n) => n.id !== 'src' && n.kind === 'terminal')!
    const command = reviewer.pendingLaunch!.command
    states.src = 'done'
    const automatic = factory.refreshArmed({ nodeId: 'src', state: 'done' })
    const manual = factory.runFromOwner(reviewer.id, command)
    await automatic
    expect(await manual).toMatchObject({ ok: true, started: true })
    expect(pty.sends.filter((s) => s.nodeId === reviewer.id)).toHaveLength(1)
    expect(await factory.runFromOwner(reviewer.id, command)).toMatchObject({ started: true })
    expect(pty.sends).toHaveLength(1)
  })

  it('refuses a stale owner command and does not release on an unverified idle blip', async () => {
    let verified = false
    factory = new HeadlessNodeFactory({ ...deps, stateVerified: () => verified })
    states.src = 'done'
    await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness', synthesis: 'off' }, true)
    const reviewer = (await read()).nodes.find((n) => n.id !== 'src' && n.kind === 'terminal')!
    expect(await factory.runFromOwner(reviewer.id, 'different command')).toMatchObject({ ok: false, started: false })
    await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    verified = true
    await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    expect(pty.sends).toEqual([])
    states.src = 'working'; await factory.refreshArmed({ nodeId: 'src', state: 'working' })
    states.src = 'done'; await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    expect(pty.sends).toHaveLength(1)
  })

  it('does not start a member deleted while its persisted project was being published', async () => {
    let deleted = false
    factory = new HeadlessNodeFactory({ ...deps, publishProject: (project) => {
      if (deleted) return
      deleted = true
      const id = project.nodes.find((n) => n.kind === 'terminal' && n.id !== 'src')!.id
      void store.updateWorkspace((fresh) => { fresh.projects[0].nodes = fresh.projects[0].nodes.filter((n) => n.id !== id); return fresh })
    } })
    const reply = await factory.orchestrate('spawn-team', 'src', { team: '[{"prompt":"hello"}]' }, true)
    expect(reply.ok).toBe(false)
    expect(pty.sends).toEqual([])
  })

  it.each(['cwd', 'command'] as const)('holds an automatically armed launch whose %s changed', async (field) => {
    await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness', synthesis: 'off' }, true)
    const reviewer = (await read()).nodes.find((n) => n.id !== 'src' && n.kind === 'terminal')!
    await store.updateWorkspace((fresh) => {
      const node = fresh.projects[0].nodes.find((n) => n.id === reviewer.id)!
      if (field === 'cwd') node.cwd = '/different-checkout'
      else node.pendingLaunch!.command = 'different command'
      return fresh
    })
    states.src = 'done'; await factory.refreshArmed({ nodeId: 'src', state: 'done' })
    expect(pty.sends).toEqual([])
    expect((await read()).nodes.find((n) => n.id === reviewer.id)!.pendingLaunch).toMatchObject({ manualOnly: true })
  })

  it('does not acknowledge an old completed command over a newly queued task', async () => {
    await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness', synthesis: 'off' }, true)
    const reviewer = (await read()).nodes.find((n) => n.id !== 'src' && n.kind === 'terminal')!
    const command = reviewer.pendingLaunch!.command
    expect(await factory.runFromOwner(reviewer.id, command)).toMatchObject({ started: true })
    await store.updateWorkspace((fresh) => {
      fresh.projects[0].nodes.find((n) => n.id === reviewer.id)!.pendingLaunch = {
        command: 'next task', executor: 'server', after: [], manualOnly: true, attempted: false
      }
      return fresh
    })
    expect(await factory.runFromOwner(reviewer.id, command)).toMatchObject({ ok: false, started: false })
    expect((await read()).nodes.find((n) => n.id === reviewer.id)!.pendingLaunch!.command).toBe('next task')
    expect(pty.sends).toHaveLength(1)
  })

  it('does not launch anything when persistence fails after the batch was reflected', async () => {
    vi.spyOn(store, 'updateWorkspace').mockImplementationOnce(async (edit, beforeSave) => {
      const current = await store.load(); const next = edit(structuredClone(current)); beforeSave?.(current, next)
      throw new Error('disk full')
    })
    expect(await factory.orchestrate('spawn-team', 'src', { team: '[{"prompt":"hello"}]' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('save-uncertain') })
    expect(ops).not.toEqual([]); expect(pty.creates).toEqual([])
  })

  it('keeps the selected account on a held node and refuses recovery after that account is removed', async () => {
    let accounts = [{ id: 'acc', label: 'Managed', createdAt: 1 }]
    deps.settings = () => ({ ...DEFAULT_SETTINGS, claudeAccounts: accounts })
    fs.mkdirSync(accountConfigDir(path.join(dir, 'data'), 'acc'), { recursive: true })
    await store.updateWorkspace((fresh) => { fresh.projects[0].nodes[0].accountId = 'acc'; return fresh })
    await factory.orchestrate('verify', 'src', { node: 'src', lenses: 'correctness', synthesis: 'off' }, true)
    const reviewer = (await read()).nodes.find((n) => n.id !== 'src' && n.kind === 'terminal')!
    expect(reviewer.accountId).toBe('acc')
    accounts = []
    expect(await factory.runFromOwner(reviewer.id, reviewer.pendingLaunch!.command)).toMatchObject({
      started: false, message: expect.stringContaining('restore or choose its local account')
    })
    expect(pty.sends).toEqual([])
  })

  it('releases the Desktop synthetic client while leaving the persistent backend running', async () => {
    factory = new HeadlessNodeFactory({ ...deps, releaseHeadlessAfterWork: true })
    const reply = await factory.orchestrate('spawn-team', 'src', { team: '[{"prompt":"hello"}]' }, true)
    expect(reply.ok).toBe(true)
    const id = (reply.result as { memberIds: string[] }).memberIds[0]
    expect(pty.released).toContain(id)
    expect(await pty.sessionExists(id)).toBe(true)
    expect(pty.sends).toHaveLength(1)
  })

  it('creates a streaming media node for a large local file without binary RPC or terminal work', async () => {
    const file = path.join(dir, 'clip.mp4')
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]))
    fs.truncateSync(file, 32 * 1024 * 1024)
    const reply = await factory.showVideo('src', { path: file }, true)
    expect(reply).toMatchObject({ ok: true })
    expect((await read()).nodes.find((n) => n.kind === 'video')).toMatchObject({ filePath: file, openedBy: 'src' })
    expect(pty.creates).toEqual([])
    fs.writeFileSync(file, '<script>not media</script>')
    expect(await factory.showVideo('src', { path: file }, true)).toMatchObject({ ok: false, error: expect.stringContaining('type-refused') })
    expect(await factory.showVideo('src', { path: file }, false)).toMatchObject({ ok: false })
    expect((await read()).nodes.filter((n) => n.kind === 'video')).toHaveLength(1)
  })

  it('creates external web previews and requires the configured isolation service for local HTML', async () => {
    expect(await factory.showWeb('src', { url: 'https://example.com/page' }, true)).toMatchObject({ ok: true })
    expect(await factory.showWeb('src', { html: '<h1>Local</h1>' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('isolation-required') })
    expect(await factory.showWeb('src', { url: 'http://localhost:3000' }, true)).toMatchObject({ ok: false })
    const previews = new WebPreviews('https://preview.example.test', 'https://term.example.test', store, path.join(dir, 'data'))
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps, webPreviews: previews })
    try {
      const reply = await factory.showWeb('src', { html: '<h1>Local</h1>' }, true)
      expect(reply).toMatchObject({ ok: true })
      const node = (await read()).nodes.find((n) => n.id === (reply.result as { id: string }).id)!
      expect(node).toMatchObject({ kind: 'web', title: 'HTML preview', openedBy: 'src' })
      expect(fs.readFileSync(node.filePath!, 'utf8')).toBe('<h1>Local</h1>')
      expect(pty.creates).toEqual([])
    } finally { previews.dispose() }
  })
})
