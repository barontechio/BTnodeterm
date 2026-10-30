import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClaudeAccountsApi,
  buildCodexAccountsApi,
  buildControlApi,
  buildMediaApi,
  buildWebPreviewApi,
  buildOwnerConfirmationApi,
  buildTranscriptSearchApi,
  buildBoardCommentDeliveryApi,
  buildFilesApi,
  buildRealApi,
  buildSessionMemoryApi,
  buildWatchLinkApi
} from './ws-bridge'
import { buildStubApi } from './stubs'
import { E_UNSUPPORTED } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { boardCommentOutcomeText } from '../../shared/board-comment'

function fakeClient() {
  const calls: Array<{ kind: string; method: string; args: unknown[] }> = []
  return {
    calls,
    request: (method: string, ...args: unknown[]) => {
      calls.push({ kind: 'request', method, args })
      return Promise.resolve('R')
    },
    cast: (method: string, ...args: unknown[]) => calls.push({ kind: 'cast', method, args }),
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      calls.push({ kind: 'subscribe', method: channel, args: [] })
      return () => {}
    }
  }
}

describe('Server media protocol', () => {
  it('uses scoped references and renews/releases the opaque token without passing URL paths', async () => {
    const c = fakeClient()
    const media = buildMediaApi(c as never).media
    await media.allow('/clip.mp4', { projectId: 'p', nodeId: 'v' })
    await media.renew!('/media?ref=opaque')
    await media.release!('/media?ref=opaque')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.mediaAllowScoped, args: ['/clip.mp4', { projectId: 'p', nodeId: 'v' }] },
      { kind: 'request', method: IPC.mediaRenew, args: ['opaque'] },
      { kind: 'request', method: IPC.mediaRelease, args: ['opaque'] }
    ])
  })
})

describe('owner settings synchronization', () => {
  it('negotiates legacy saves only for a missing patch handler', async () => {
    const c = fakeClient(); const request = vi.spyOn(c, 'request')
    const api = buildRealApi(c as never).settings
    request.mockRejectedValueOnce({ code: 'E_NO_HANDLER' })
    expect(await api.patch!({ gridSize: 24 })).toBeNull()
    request.mockRejectedValueOnce({ code: 'E_DISCONNECTED' })
    await expect(api.patch!({ gridSize: 32 })).rejects.toMatchObject({ code: 'E_DISCONNECTED' })
    expect(c.calls.some((call) => call.method === IPC.settingsSave)).toBe(false)
    api.onChanged!(() => {})
    expect(c.calls).toContainEqual({ kind: 'subscribe', method: IPC.settingsChanged, args: [] })
  })
})

describe('managed Codex account protocol', () => {
  it('sends all lifecycle phases through the same owner connection, without credential fields', async () => {
    const c = fakeClient(); const api = buildCodexAccountsApi(c as never).codexAccounts
    await api.add(); await api.waitLogin('account'); await api.identity('account')
    await api.switchThread('thread', '/project', 'source', 'target')
    await api.commitSwitch('ticket'); await api.finishSwitch('ticket'); await api.rollbackSwitch('ticket')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.codexAccountsAdd, args: [undefined] },
      { kind: 'request', method: IPC.codexAccountsWaitLogin, args: ['account', undefined] },
      { kind: 'request', method: IPC.codexAccountsIdentity, args: ['account', undefined] },
      { kind: 'request', method: IPC.codexAccountsSwitchThread, args: ['thread', '/project', 'source', 'target'] },
      { kind: 'request', method: IPC.codexAccountsCommitSwitch, args: ['ticket'] },
      { kind: 'request', method: IPC.codexAccountsFinishSwitch, args: ['ticket'] },
      { kind: 'request', method: IPC.codexAccountsRollbackSwitch, args: ['ticket'] }
    ])
  })
})

describe('isolated web preview protocol', () => {
  it('issues by saved-node scope and passes only the opaque token when renewing or releasing', async () => {
    const c = fakeClient(); const api = buildWebPreviewApi(c as never).webPreview!
    await api.allow({ projectId: 'p', nodeId: 'web' })
    await api.renew('https://preview.example.test/web-preview?ref=one')
    await api.release('https://preview.example.test/web-preview?ref=one')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.webPreviewAllow, args: [{ projectId: 'p', nodeId: 'web' }] },
      { kind: 'request', method: IPC.webPreviewRenew, args: ['one'] },
      { kind: 'request', method: IPC.webPreviewRelease, args: ['one'] }
    ])
  })
})

describe('owner confirmation protocol', () => {
  it('binds connection lifetime and exact one-use decisions to owner RPC', async () => {
    const c = fakeClient(); const api = buildOwnerConfirmationApi(c as never).ownerConfirmation!
    await api.connect()
    await api.decide({ id: 'one', token: 'token', proof: 'proof', answer: 'approve' })
    await api.disconnect('epoch')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.ownerConfirmationConnect, args: [] },
      { kind: 'request', method: IPC.ownerConfirmationDecide, args: [{ id: 'one', token: 'token', proof: 'proof', answer: 'approve' }] },
      { kind: 'request', method: IPC.ownerConfirmationDisconnect, args: ['epoch'] }
    ])
  })
})

describe('transcript search protocol', () => {
  it('uses an additive channel so an old host cannot silently ignore account scope', async () => {
    const c = fakeClient()
    const api = buildTranscriptSearchApi(c as never)
    await api.transcripts.search('needle')
    await api.transcripts.search('needle', { accountId: 'a', limit: 10 })
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.transcriptSearch, args: ['needle'] },
      { kind: 'request', method: IPC.transcriptSearchScoped, args: ['needle', { accountId: 'a', limit: 10 }] }
    ])
    const old = { request: () => Promise.reject(new Error('no scoped handler')) }
    await expect(buildTranscriptSearchApi(old as never).transcripts.search('needle', { accountId: 'a' })).rejects.toThrow('no scoped handler')
  })
})

describe('Server board comment delivery', () => {
  it('requests delivery and surfaces an uncertain connection outcome without retrying', async () => {
    const c = fakeClient()
    const api = buildBoardCommentDeliveryApi(c as never, buildStubApi().agentMessage)
    const request = { projectId: 'p', commentId: 'c', author: 'Owner', text: 'hello', targetNodeId: 'a' }
    await api.agentMessage.deliverBoardComment(request)
    expect(c.calls).toEqual([{ kind: 'request', method: IPC.agentBoardCommentDeliver, args: [request] }])
    const lost = { request: () => Promise.reject(new Error('socket closed')) }
    const reply = await buildBoardCommentDeliveryApi(lost as never, buildStubApi().agentMessage).agentMessage.deliverBoardComment(request)
    expect(reply).toMatchObject({ ok: false, result: { kind: 'deliveryUnknown' } })
    expect(boardCommentOutcomeText('deliveryUnknown')).toMatchObject({ tone: 'warn', text: expect.stringContaining('inspect the session') })
  })
})

describe('buildControlApi', () => {
  it('negotiates host-owned launch recovery and never falls back after a lost reply', async () => {
    const request = vi.fn(async (method: string) => method === IPC.controlCapabilities ? { hostLaunches: true } : { ok: true, started: true })
    const api = buildControlApi({ request } as never)
    expect(await api.control!.runLaunch!('node', 'task')).toMatchObject({ started: true })
    expect(request).toHaveBeenCalledWith(IPC.controlRunLaunch, 'node', 'task')
    const lost = { request: async (method: string) => {
      if (method === IPC.controlCapabilities) return { hostLaunches: true }
      throw new Error('connection closed after submission')
    } }
    expect(await buildControlApi(lost as never).control!.runLaunch!('node', 'task')).toMatchObject({ ok: false, started: false })
    const old = { request: async () => { throw Object.assign(new Error('no handler'), { code: 'E_NO_HANDLER' }) } }
    expect(await buildControlApi(old as never).control!.runLaunch!('node', 'task')).toBeNull()
  })
  it('reads the host report and reports unknown on an older or unreachable host', async () => {
    const c = fakeClient()
    expect(await buildControlApi(c as never).control!.capabilities()).toBe('R')
    expect(c.calls).toEqual([{ kind: 'request', method: IPC.controlCapabilities, args: [] }])
    const old = { request: () => Promise.reject(new Error('no handler')) }
    expect(await buildControlApi(old as never).control!.capabilities()).toBeNull()
    expect(await buildStubApi().control!.capabilities()).toBeNull()
  })
})

describe('buildFilesApi', () => {
  it('fs/git/files members are request-shaped with the right channels', async () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    await api.fs.read('/x')
    await api.git.status('/repo')
    await api.git.showFile('/repo', 'HEAD', 'a.txt')
    await api.files.quickOpen('/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.fsRead, args: ['/x'] },
      { kind: 'request', method: IPC.gitStatus, args: ['/repo'] },
      { kind: 'request', method: IPC.gitShowFile, args: ['/repo', 'HEAD', 'a.txt'] },
      { kind: 'request', method: IPC.filesQuickOpen, args: ['/repo'] }
    ])
  })
  it('context.ensure is a cast; context.onUpdate/git.onCloneProgress subscribe', () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    // nodeId + agentId ride the same cast: the Server Edition resolves per agent, and the desktop
    // additionally needs the node id to tell an SSH-project session from a local one (issue #813).
    api.context.ensure('sid', '/cwd', undefined, 'n1', 'codex')
    const un = api.context.onUpdate(() => {})
    const un2 = api.git.onCloneProgress(() => {})
    expect(c.calls[0]).toEqual({ kind: 'cast', method: IPC.contextEnsure, args: ['sid', '/cwd', undefined, 'n1', 'codex'] })
    expect(c.calls[1]).toEqual({ kind: 'subscribe', method: IPC.contextUpdate, args: [] })
    expect(c.calls[2]).toEqual({ kind: 'subscribe', method: IPC.gitCloneProgress, args: [] })
    expect(typeof un).toBe('function')
    expect(typeof un2).toBe('function')
  })
})

describe('buildRealApi: workspace', () => {
  // The server DOES serve workspace:probe-folder (WorkspaceStore.registerIpc, src/core). Stubbing
  // it to `null` in the browser told "Open folder…" that a repo carrying a committed
  // .nodeterm/project.json had no project in it — so addProjectFromFolder created an empty one and
  // the next writeDisk() overwrote the team's shared canvas. It must hit the real channel.
  it('probeFolder requests the real server channel (never a null stub)', async () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    await api.workspace.probeFolder('/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.workspaceProbeFolder, args: ['/repo'] }
    ])
  })

  it('onMigrated subscribes to the channel core actually broadcasts', () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    const un = api.workspace.onMigrated(() => {})
    expect(c.calls[0]).toEqual({ kind: 'subscribe', method: IPC.workspaceMigrated, args: [] })
    expect(typeof un).toBe('function')
  })

  it('onCorruptRecovered subscribes to the channel core actually broadcasts', () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    const un = api.workspace.onCorruptRecovered(() => {})
    expect(c.calls[0]).toEqual({ kind: 'subscribe', method: IPC.workspaceCorruptRecovered, args: [] })
    expect(typeof un).toBe('function')
  })
})

describe('buildRealApi: pty naming', () => {
  // ✦ Name with AI used to resolve a hard-coded "not available in the server edition yet" here,
  // long after the naming module moved to core. The server registers the same handlers as the
  // desktop (core/naming-ipc.ts), so both members must reach them with every argument.
  it('generateName / generateGroupName request the real server channels', async () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    await api.pty.generateName('n1', '/repo', 'acct-1')
    await api.pty.generateGroupName(['n1', 'n2'], '/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.ptyGenerateName, args: ['n1', '/repo', 'acct-1'] },
      { kind: 'request', method: IPC.ptyGenerateGroupName, args: [['n1', 'n2'], '/repo'] }
    ])
  })

  it('answers a dropped socket or a relay refusal as a failed naming, never a rejection', async () => {
    const c = { ...fakeClient(), request: () => Promise.reject(new Error('refused')) }
    const api = buildRealApi(c as never)
    await expect(api.pty.generateName('n1', '/repo')).resolves.toEqual({ ok: false, message: 'refused' })
    await expect(api.pty.generateGroupName(['n1'], '/repo')).resolves.toEqual({ ok: false, message: 'refused' })
  })
})

describe('buildRealApi: host platform', () => {
  it('keeps a failed host read unknown instead of inventing Linux from the browser bridge', async () => {
    const c = fakeClient()
    c.request = (method: string, ...args: unknown[]) => {
      c.calls.push({ kind: 'request', method, args })
      return Promise.reject(new Error('server unavailable'))
    }
    const api = buildRealApi(c as never)

    await expect(api.pty.tmuxStatus()).resolves.toEqual({
      available: false,
      installCommand: null,
      installLabel: null,
      platform: null,
      persistence: null
    })
  })
})

// #925: the Server Edition starts nodes through its own HeadlessNodeFactory, so the browser build
// has nothing to call. It must REFUSE with the coded error and never reach the wire — a relay tab
// spreads this same `pty`, so a request here would ask the HOST's core to spawn a session.
describe('buildRealApi: pty.launchHeadless', () => {
  it('rejects E_UNSUPPORTED without a request', async () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    await expect(
      api.pty.launchHeadless({ ptyOptions: { persistKey: 'n1', cols: 80, rows: 24 }, command: 'x' })
    ).rejects.toMatchObject({ code: E_UNSUPPORTED })
    expect(c.calls).toEqual([])
  })
})

describe('buildRealApi: sessionMemory', () => {
  // A real WS namespace, not a stub: the same core service (`startSessionMemoryService`) registers
  // both channels in the server shell, so the browser gets a genuine per-session breakdown of the
  // machine it is served from.
  it('read/host hit the real channels', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    await api.sessionMemory.read()
    await api.sessionMemory.host()
    expect(c.calls.map((x) => ({ kind: x.kind, method: x.method }))).toEqual([
      { kind: 'request', method: IPC.sessionMemory },
      { kind: 'request', method: IPC.sessionMemoryHost }
    ])
  })

  // The query is the ONLY thing that decides which machine answers: `projectId` names the scope and
  // `remote` is the renderer's own "this scope is an SSH host" claim, which the service ORs with its
  // own `isRemoteProject`. A layer that drops or rewrites either one turns a remote query into a
  // LOCAL sweep, and the panel publishes this machine's sessions under the host's name. So the
  // query must arrive at the RPC call byte-identical, on BOTH channels.
  it('passes projectId and the remote flag through unmodified', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    const q = { projectId: 'p1', remote: true }
    await api.sessionMemory.read(q)
    await api.sessionMemory.host(q)
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.sessionMemory, args: [{ projectId: 'p1', remote: true }] },
      { kind: 'request', method: IPC.sessionMemoryHost, args: [{ projectId: 'p1', remote: true }] }
    ])
  })

  // `remote: false` is a claim too ("the renderer says this is NOT an SSH scope"), and it must not
  // be normalized away into `undefined` — the shell's own predicate still gets to say otherwise,
  // but the renderer's answer has to reach it as written.
  it('keeps an explicit remote:false', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    await api.sessionMemory.read({ projectId: 'p2', remote: false })
    expect(c.calls[0].args).toEqual([{ projectId: 'p2', remote: false }])
  })

  // The builder above is dead code unless it is actually spread into the assembled api. It cannot
  // be caught by the compiler: `buildStubApi()` already supplies a `sessionMemory`, so dropping the
  // spread leaves `NodeTerminalApi` satisfied and the STUB silently wins in every live browser
  // session. installWsBridge needs a socket + DOM to run, so the wiring is pinned by source text.
  it('is spread into the assembled window.nodeTerminal', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).toContain('...buildSessionMemoryApi(client)')
  })
})

/**
 * Issue #313: the managed-Claude-account lifecycle moved into src/core, so the server registers
 * the same four channels the desktop does. Before that every member rejected E_UNSUPPORTED from
 * the stub — a browser deployment could SELECT a managed account but never create or remove one.
 */
describe('buildClaudeAccountsApi', () => {
  it('all four members request the real channels, ctx included', async () => {
    const c = fakeClient()
    const { claudeAccounts } = buildClaudeAccountsApi(c as never)
    await claudeAccounts.add()
    await claudeAccounts.add({ projectId: 'p1' })
    await claudeAccounts.waitLogin('a1')
    await claudeAccounts.waitLogin('a1', { projectId: 'p1' })
    await claudeAccounts.cancelWaitLogin('a1')
    await claudeAccounts.remove('a1', { projectId: 'p1' })
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.claudeAccountsAdd, args: [undefined] },
      { kind: 'request', method: IPC.claudeAccountsAdd, args: [{ projectId: 'p1' }] },
      { kind: 'request', method: IPC.claudeAccountsWaitLogin, args: ['a1', undefined] },
      { kind: 'request', method: IPC.claudeAccountsWaitLogin, args: ['a1', { projectId: 'p1' }] },
      { kind: 'request', method: IPC.claudeAccountsCancelWait, args: ['a1'] },
      { kind: 'request', method: IPC.claudeAccountsRemove, args: ['a1', { projectId: 'p1' }] }
    ])
  })

  // Same trap as buildSessionMemoryApi's: buildStubApi() already satisfies `claudeAccounts`, so a
  // dropped spread compiles and the stub silently wins in every browser session.
  it('is spread into the assembled window.nodeTerminal', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).toContain('...buildClaudeAccountsApi(client)')
  })

  // The Codex half is deliberately NOT ported: its switch verbs authorize the owning window by
  // Electron WebContents id, which has no meaning over a WS connection. It must keep REFUSING with
  // the coded error rather than silently no-opping — that code is what the Settings section reads
  // to say "manage them from the desktop app" instead of a generic failure.
  it('codexAccounts stays an E_UNSUPPORTED stub', async () => {
    const s = buildStubApi()
    await expect(s.codexAccounts.add()).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.codexAccounts.waitLogin('a1')).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.codexAccounts.cancelWaitLogin('a1')).rejects.toMatchObject({
      code: E_UNSUPPORTED
    })
    await expect(s.codexAccounts.remove('a1')).rejects.toMatchObject({ code: E_UNSUPPORTED })
  })
})

/**
 * The hosted team verbs belong to a RELAY tab joined by a hosted team's code, never to a Server
 * Edition browser tab: a browser never joins a relay host (its `relayHosted` stub answers no
 * bookmarks), and the server it is served from does not answer `relay:hosted:*` to its own browser
 * (hosted-service intercepts them for relay peers only). So installWsBridge must not spread
 * `buildHostedApi` — its api has no `hosted` key, and every `api.hosted` check in the renderer takes
 * its old path there. installWsBridge needs a socket + DOM to run, so this is pinned by source text.
 */
describe('buildHostedApi and the Server Edition', () => {
  it('is never spread into the browser\'s window.nodeTerminal', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).not.toContain('buildHostedApi')
    expect(install).not.toMatch(/\bhosted\s*:/)
  })
})

// Live links in the Server Edition: a REAL bridge over the owner-only `watchLink:*` channels (the
// service answers create `unsupported` there until that edition has a license layer — R43).
describe('buildWatchLinkApi', () => {
  it('every member rides its own watchLink channel, with its arguments', async () => {
    const c = fakeClient()
    const api = buildWatchLinkApi(c as never).watchLink
    const req = { nodeId: 'n1', role: 'viewer' as const, ttlSeconds: 3600 as const, label: 'Ada', title: 't' }
    await api.create(req)
    await api.list()
    await api.revoke('L1')
    await api.revokeAll()
    await api.kick('L1', 'v-1')
    await api.sendChat('L1', 'hi')
    await api.chatHistory('L1')
    api.onState(() => {})
    api.onChat(() => {})
    api.onNotice(() => {})
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.watchLinkCreate, args: [req] },
      { kind: 'request', method: IPC.watchLinkList, args: [] },
      { kind: 'request', method: IPC.watchLinkRevoke, args: ['L1'] },
      { kind: 'request', method: IPC.watchLinkRevokeAll, args: [] },
      { kind: 'request', method: IPC.watchLinkKick, args: ['L1', 'v-1'] },
      { kind: 'request', method: IPC.watchLinkChatSend, args: ['L1', 'hi'] },
      { kind: 'request', method: IPC.watchLinkChatHistory, args: ['L1'] },
      { kind: 'subscribe', method: IPC.watchLinkState, args: [] },
      { kind: 'subscribe', method: IPC.watchLinkChat, args: [] },
      { kind: 'subscribe', method: IPC.watchLinkNotice, args: [] }
    ])
  })

  it('a dropped socket: create answers network and the reads answer empty, never an unhandled rejection', async () => {
    const down = { request: () => Promise.reject(new Error('E_DISCONNECTED')), subscribe: () => () => {} }
    const api = buildWatchLinkApi(down as never).watchLink
    await expect(api.create({ nodeId: 'n1', role: 'viewer', ttlSeconds: 3600, label: 'A', title: 't' })).resolves.toEqual({
      ok: false,
      error: 'network'
    })
    await expect(api.list()).resolves.toEqual([])
    await expect(api.kick('L', 'v')).resolves.toBe(false)
    await expect(api.sendChat('L', 'x')).resolves.toBeNull()
    await expect(api.chatHistory('L')).resolves.toEqual([])
    // A stop that did not reach the server must be visible to the UI.
    await expect(api.revoke('L')).rejects.toThrow()
    await expect(api.revokeAll()).rejects.toThrow()
  })

  it('is spread into the Server Edition api, and into no builder a relay tab shares', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8').replace(/\r\n/g, '\n')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).toContain('...buildWatchLinkApi(client)')
    const relay = readFileSync(join(__dirname, 'relay-api.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(relay).not.toContain('buildWatchLinkApi')
  })
})
