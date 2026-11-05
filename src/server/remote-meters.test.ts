import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerRemoteMeters } from './remote-meters'
import { createServerRemoteTranscripts } from './remote-transcripts'
import { fakePlatform } from '../core/platform-fake'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import { IPC } from '../shared/ipc'
import { sshHostKey } from '../shared/ssh'
import { isHostOnlyChannel } from '../shared/host-control'

const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
const raw = JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 123 } } }) + '\n'
const result = { code: 0, stdout: JSON.stringify({ start: 0, size: Buffer.byteLength(raw), data: Buffer.from(raw).toString('base64') }) }
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
function fixture(enabled = true) {
  vi.useFakeTimers()
  const platform = fakePlatform({ isOwnerClient: id => id === 1 || id === 2 }); platform.clients.push(1, 2, 3)
  const conn = { host: 'fixture', user: 'fixture', port: 2222 }
  const node = { id: 'node', kind: 'terminal', agentId: 'claude', agentSessionId: sid, accountId: 'a', cwd: '/repo' } as CanvasNodeState
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.claudeAccounts = [{ id: 'a', label: 'A', host: sshHostKey(conn), createdAt: 1 }]
  let runtime: object | undefined = {}, generation = 'g1', session = sid, home = '/fixture', ids = ['p'], remote = true
  let beforeDispatch = () => {}
  const run = vi.fn(async () => result)
  const transcripts = createServerRemoteTranscripts({ platform, enabled, settings: () => settings,
    runtimeIdentity: () => runtime, sessionOf: () => session,
    pty: { sshRemoteForNode: () => undefined }, workspace: { projectIdsForNode: () => ids, getNodeForHostAction: () => node,
      relayNodePlacements: () => [], sshProjectIdForNode: () => remote ? 'p' : undefined,
      projectTargetInfo: () => ({ name: 'Fixture', ...(remote ? { ssh: { server: conn, remoteCwd: '/repo' } } : {}) }) },
    ssh: { refForProject: () => ({ conn, controlPath: '/cp', remoteCwd: '/repo' }),
      manager: { connectionKeyFor: () => generation, remoteHomeForControlPath: () => home, sshRun: run },
      withQueuedExecutionCheck: async (current, work) => { beforeDispatch(); if (!current()) throw Error('revoked'); return work() } } })
  const service = createServerRemoteMeters(platform, transcripts.captureMeter)
  const call = (client: number, method: string, ...args: unknown[]) => platform.handlers[method](client, ...args)
  const start = () => (call(1, IPC.contextRemoteStart, 'node') as { leaseId: string }).leaseId
  const updates = () => platform.sent.filter(e => e.channel === IPC.contextRemoteUpdate).map(e => e.args[0])
  const mutations: Record<string, () => void> = {
    runtime: () => { runtime = {} }, missingRuntime: () => { runtime = undefined }, connection: () => { generation = 'g2' },
    session: () => { session = 'new-session' }, savedSession: () => { node.agentSessionId = 'saved-new' },
    model: () => { node.agentModel = 'other' }, account: () => { node.accountId = undefined },
    effectiveAccount: () => { settings.claudeAccounts[0].configDir = '/linked' }, accountRemoved: () => { settings.claudeAccounts = [] },
    home: () => { home = '/other' }, endpoint: () => { conn.port++ }, harness: () => { node.agentId = 'codex' },
    ambiguity: () => { ids = ['p', 'p2'] }, local: () => { remote = false }, cwd: () => { node.cwd = '/other' }
  }
  return { platform, transcripts, service, call, start, updates, run, node, mutations,
    beforeDispatch: (fn: () => void) => { beforeDispatch = fn }, dispose: () => { service.dispose(); transcripts.dispose() } }
}
afterEach(() => vi.useRealTimers())
describe('owner SSH meter adapter', () => {
  it('refuses relay/viewer identity, disabled hosts, unsupported harnesses and absent runtime', async () => {
    const f = fixture()
    expect(f.call(3, IPC.contextRemoteStart, 'node')).toEqual({ status: 'unavailable' })
    expect([IPC.contextRemoteStart, IPC.contextRemoteRenew, IPC.contextRemoteRelease, IPC.contextRemoteUpdate].every(isHostOnlyChannel)).toBe(true)
    f.node.agentId = 'gemini'; expect(f.call(1, IPC.contextRemoteStart, 'node')).toEqual({ status: 'unavailable' })
    f.node.agentId = 'claude'; f.mutations.missingRuntime(); expect(f.call(1, IPC.contextRemoteStart, 'node')).toEqual({ status: 'unavailable' })
    expect(f.run).not.toHaveBeenCalled(); f.dispose()
    const disabled = fixture(false); expect(disabled.call(1, IPC.contextRemoteStart, 'node')).toEqual({ status: 'unavailable' }); disabled.dispose()
  })
  it.each(['runtime', 'missingRuntime', 'connection', 'session', 'savedSession', 'model', 'account', 'effectiveAccount',
    'accountRemoved', 'home', 'endpoint', 'harness', 'ambiguity', 'local', 'cwd'])('invalidates original %s proof before publication and renewal', async change => {
    const f = fixture(), id = f.start(); await flush(); expect(f.run).toHaveBeenCalledOnce()
    f.mutations[change]()
    expect(f.call(1, IPC.contextRemoteRenew, id)).toBe(false)
    expect(f.updates().every(e => e.usage === null)).toBe(true); f.dispose()
  })
  it('retains the original proof through a queued dispatch and late completion', async () => {
    const f = fixture(), id = f.start(); f.beforeDispatch(f.mutations.model); await flush()
    expect(f.run).not.toHaveBeenCalled(); expect(f.call(1, IPC.contextRemoteRenew, id)).toBe(false); f.dispose()
    const g = fixture(); let finish!: (r: typeof result) => void
    g.run.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const token = g.start(); await flush(); g.mutations.connection(); finish(result); await flush()
    expect(g.call(1, IPC.contextRemoteRenew, token)).toBe(false)
    expect(g.updates().every(e => e.usage === null)).toBe(true); g.dispose()
  })
  it('owner departure/reuse cannot read, renew, release or publish another owner lease', async () => {
    const f = fixture(), id = f.start(); await flush()
    expect(f.call(2, IPC.contextRemoteRenew, id)).toBe(false)
    f.call(2, IPC.contextRemoteRelease, id)
    expect(f.call(1, IPC.contextRemoteRenew, id)).toBe(true)
    expect(f.platform.sent.filter(e => e.channel === IPC.contextRemoteUpdate).every(e => e.to === 1)).toBe(true)
    f.service.forgetClient(1)
    expect(f.call(1, IPC.contextRemoteRenew, id)).toBe(false); f.dispose()
  })
  it('does not give owner demand to agent linked context or fallback to local files', async () => {
    const f = fixture(), id = f.start(); await flush(); f.call(1, IPC.contextRemoteRenew, id)
    expect(f.updates().at(-1)).toMatchObject({ status: 'ready', quota: 'unavailable', usage: { nodeId: 'node', usedTokens: 123 } })
    expect(await f.transcripts.readLinkedTranscript({ id: 'node', title: 'Node', agentId: 'claude', sessionId: sid },
      { callerId: 'agent', current: () => true, verified: () => true, retainAuthorization: () => true })).toBeNull()
    f.mutations.local(); expect(f.call(1, IPC.contextRemoteRenew, id)).toBe(false)
    expect(f.call(1, IPC.contextRemoteStart, 'node')).toEqual({ status: 'local' }); f.dispose()
  })
})
