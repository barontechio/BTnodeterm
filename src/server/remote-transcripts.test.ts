import { describe, expect, it, vi } from 'vitest'
import { createServerRemoteTranscripts } from './remote-transcripts'
import { fakePlatform } from '../core/platform-fake'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import { sshHostKey } from '../shared/ssh'

const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
const q = { nodeId: 'node', sessionId: sid, accountId: 'managed', cwd: '/repo' }
const page = { before: null, maxBytes: 64 }
const result = { code: 0, stdout: JSON.stringify({ start: 0, size: 4, data: Buffer.from('data').toString('base64') }) }
function fixture() {
  const platform = fakePlatform({ isOwnerClient: (id) => id === 1 }); platform.clients.push(1, 2)
  const conn = { host: 'host', user: 'fixture' }
  const node: CanvasNodeState = { id: 'node', kind: 'terminal', agentId: 'claude', accountId: 'managed', agentSessionId: sid,
    cwd: '/repo', group: null, title: 'Node', color: '#000', position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.claudeAccounts = [{ id: 'managed', label: 'Account', host: sshHostKey(conn), createdAt: Date.now() }]
  let ids = ['p']; let remote = true; let connected = true; let generation = 'g1'
  const signals: AbortSignal[] = []
  const run = vi.fn(async () => result)
  const api = createServerRemoteTranscripts({ platform, enabled: true, settings: () => settings,
    sessionOf: () => sid, pty: { sshRemoteForNode: () => undefined }, workspace: {
      projectIdsForNode: () => ids, getNodeResolved: () => node,
      sshProjectIdForNode: () => remote ? 'p' : undefined,
      projectTargetInfo: () => ({ name: 'Project', cwd: '/repo', ...(remote ? { ssh: { server: conn, remoteCwd: '/repo' } } : {}) })
    }, ssh: { refForProject: () => connected ? { conn, controlPath: '/cp', remoteCwd: '/repo' } : undefined,
      manager: { connectionKeyFor: () => generation, remoteHomeForControlPath: () => '/home/fixture', sshRun: run },
      withQueuedExecutionCheck: async (current, work, options) => {
        if (options?.signal) signals.push(options.signal)
        if (!current() || options?.signal?.aborted) throw new Error('stale')
        return work()
      }
    } })
  return { api, platform, node, settings, run, signals, setIds: (value: string[]) => { ids = value },
    local: () => { remote = false }, disconnect: () => { connected = false }, reconnect: () => { connected = true; generation = 'g2' } }
}

describe('Server SSH transcript routing and caller lifetime', () => {
  it('reads only on an authenticated owner request and preserves local delegation for guests', async () => {
    const f = fixture()
    expect(await f.api.reader.readPage(q, page)).toMatchObject({ ok: false, reason: 'remote-reader-permission-required' })
    expect(await f.api.rpcScope(2, () => f.api.reader.readPage(q, page))).toMatchObject({ ok: false, reason: 'remote-reader-permission-required' })
    expect(f.run).not.toHaveBeenCalled()
    expect(await f.api.rpcScope(1, () => f.api.reader.readPage(q, page))).toEqual({ ok: true, start: 0, data: Buffer.from('data') })
    expect(f.run).toHaveBeenCalledTimes(1)
    f.local(); expect(await f.api.rpcScope(2, () => f.api.reader.readPage(q, page))).toBeNull()
    expect(f.run).toHaveBeenCalledTimes(1); f.api.dispose()
  })

  it('refuses unavailable or wrong-host accounts, unowned project bindings and disconnected targets without local lookup', async () => {
    const f = fixture()
    const originalHost = f.settings.claudeAccounts[0].host
    for (const change of [() => { f.settings.claudeAccounts[0].host = 'other@host' },
      () => { f.settings.claudeAccounts[0].pending = true }, () => { f.setIds(['p', 'other']) }, () => f.disconnect()]) {
      f.settings.claudeAccounts[0].host = originalHost; f.settings.claudeAccounts[0].pending = false; f.setIds(['p'])
      change()
      expect(await f.api.rpcScope(1, () => f.api.reader.readPage(q, page))).toEqual({ ok: false })
    }
    expect(f.run).not.toHaveBeenCalled(); f.api.dispose()
  })

  it('does not reactivate an old owner after its numeric client id is reused', async () => {
    const f = fixture(); let finish!: (value: typeof result) => void
    f.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const old = f.api.rpcScope(1, () => f.api.reader.readPage(q, page))
    expect(f.signals).toHaveLength(1); f.api.forgetClient(1)
    expect(f.signals[0].aborted).toBe(true)
    expect(await f.api.rpcScope(1, () => f.api.reader.readPage(q, page))).toMatchObject({ ok: true })
    finish(result); expect(await old).toEqual({ ok: false }); f.api.dispose()
  })

  it('keeps implementation support separate from connection readiness and refuses other harnesses', () => {
    const f = fixture()
    expect(f.api.supported('claude', 'node')).toBe(true)
    f.disconnect(); expect(f.api.supported('claude', 'node')).toBe(true)
    expect(f.api.supported('codex', 'node')).toBe(false)
    f.node.agentId = 'gemini'; expect(f.api.supported('gemini', 'node')).toBe(false)
    f.api.dispose()
  })

  it('refuses a detached continuation after its owner RPC has completed', async () => {
    const f = fixture(); let release!: () => void; let late!: Promise<unknown>
    const held = new Promise<void>((resolve) => { release = resolve })
    await f.api.rpcScope(1, async () => { late = held.then(() => f.api.reader.readPage(q, page)) })
    release()
    expect(await late).toMatchObject({ ok: false, reason: 'remote-reader-permission-required' })
    expect(f.run).not.toHaveBeenCalled(); f.api.dispose()
  })
})
