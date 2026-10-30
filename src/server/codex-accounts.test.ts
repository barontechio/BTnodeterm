import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerPlatform } from './platform-server'
import { registerServerCodexAccounts } from './codex-accounts'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { testTmpDir } from '../core/test-tmp'
import { codexAccountHome } from '../core/codex-accounts-core'
import { IPC } from '../shared/ipc'

const readThread = vi.hoisted(() => vi.fn())
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadAt: readThread, readCodexAccountAt: vi.fn(async () => ({ email: 'owner@example.invalid' }))
}))
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))

describe('Server managed Codex owner RPC with real rollout files', () => {
  let platform: ServerPlatform
  let accounts: ReturnType<typeof registerServerCodexAccounts>
  let first: number; let second: number; let guest: number
  let source: string; let target: string
  let oldHome: string | undefined
  let requestId: number
  const sink = { sendText: () => {}, sendBinary: () => {} }
  const call = (id: number, method: string, ...args: unknown[]) => platform.dispatch(id, { t: 'req', id: ++requestId, method, args })
  const prepare = () => call(first, IPC.codexAccountsSwitchThread, 'thread-one', '/project', 'source', 'target')
  const token = (reply: Awaited<ReturnType<typeof call>>) => {
    if (!reply.ok) throw new Error(JSON.stringify(reply))
    return (reply.result as { rollbackToken: string }).rollbackToken
  }
  beforeEach(() => {
    requestId = 0
    const root = testTmpDir('server-codex-accounts-')
    oldHome = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(root, 'system')
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true }); fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model="example"')
    platform = new ServerPlatform({ userDataDir: root, appVersion: 'test' }); resetPlatformForTests(); initPlatform(platform)
    first = platform.attach(sink, { owner: true }); second = platform.attach(sink, { owner: true }); guest = platform.attach(sink)
    source = path.join(codexAccountHome(root, 'source'), 'sessions', 'rollout-thread-one.jsonl')
    target = path.join(codexAccountHome(root, 'target'), 'sessions', 'rollout-thread-one.jsonl')
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(source, '{"id":"thread-one"}\n')
    readThread.mockReset().mockResolvedValue({ id: 'thread-one', path: source })
    accounts = registerServerCodexAccounts(platform)
  })
  afterEach(() => {
    accounts.dispose(); resetPlatformForTests(); vi.useRealTimers()
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
  })

  it('creates a private host account and refuses guests and unavailable SSH contexts', async () => {
    expect(await call(guest, IPC.codexAccountsAdd)).toMatchObject({ ok: false, error: { message: 'owner-required' } })
    const added = await call(first, IPC.codexAccountsAdd)
    expect(added.ok).toBe(true)
    if (!added.ok) throw new Error('owner add failed')
    const home = (added.result as { home: string }).home
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false)
    if (process.platform !== 'win32') expect(fs.statSync(home).mode & 0o777).toBe(0o700)
    expect(await call(first, IPC.codexAccountsAdd, { projectId: 'remote' })).toMatchObject({ ok: false, error: { message: 'SSH is not available in this build' } })
    expect(await call(first, IPC.codexAccountsSystemIdentity, { projectId: 'remote' })).toMatchObject({ ok: true, result: null })
  })

  it('binds preparation, commit and finish to one connection; removal cannot race a reservation', async () => {
    const ticket = token(await prepare())
    expect(await call(second, IPC.codexAccountsCommitSwitch, ticket)).toMatchObject({ ok: false })
    expect(await call(second, IPC.codexAccountsRemove, 'target')).toMatchObject({ ok: false, error: { message: expect.stringContaining('reserved') } })
    expect(fs.existsSync(target)).toBe(false)
    expect(await call(first, IPC.codexAccountsCommitSwitch, ticket)).toMatchObject({ ok: true })
    expect(fs.statSync(target).ino).toBe(fs.statSync(source).ino)
    expect(await call(second, IPC.codexAccountsFinishSwitch, ticket)).toMatchObject({ ok: false })
    expect(await call(first, IPC.codexAccountsFinishSwitch, ticket)).toMatchObject({ ok: true })
    expect(fs.readFileSync(source, 'utf8')).toContain('thread-one')
  })

  it('routes explicit remote accounts to SSH and discards a login result after owner departure', async () => {
    accounts.dispose()
    let answer!: (value: boolean) => void
    const remote = {
      remoteCodexAccountAdd: vi.fn(async () => ({ home: '/remote/isolated' })),
      remoteCodexAuthPresent: vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve })),
      remoteCodexAccountIdentity: vi.fn(async () => ({ email: 'remote@example.invalid' })),
      remoteCodexAccountRemove: vi.fn(async () => true), remoteCodexSwitchThread: vi.fn(async () => ({}))
    }
    accounts = registerServerCodexAccounts(platform, () => remote)
    expect(await call(first, IPC.codexAccountsAdd, { projectId: 'remote' })).toMatchObject({ ok: true, result: { home: '/remote/isolated' } })
    expect(remote.remoteCodexAccountAdd).toHaveBeenCalledWith('remote', expect.any(String))
    const waiting = call(first, IPC.codexAccountsWaitLogin, 'source', { projectId: 'remote' })
    accounts.forgetClient(first); platform.detach(first); answer(true)
    expect(await waiting).toMatchObject({ ok: true, result: null })
    expect(await call(second, IPC.codexAccountsAdd, {})).toMatchObject({ ok: false, error: { message: 'ssh-invalid-project' } })
  })

  it('releases reservations on departure and refuses a stale connection or replay', async () => {
    const ticket = token(await prepare())
    accounts.forgetClient(first); platform.detach(first)
    expect(await call(first, IPC.codexAccountsCommitSwitch, ticket)).toMatchObject({ ok: false })
    const replacement = platform.attach(sink, { owner: true })
    expect(await call(replacement, IPC.codexAccountsCommitSwitch, ticket)).toMatchObject({ ok: false })
    expect(await call(second, IPC.codexAccountsRemove, 'target')).toMatchObject({ ok: true })
    expect(fs.existsSync(source)).toBe(true)
  })

  it('checks the real deadline even when the timer callback has not run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ticket = token(await prepare())
    vi.setSystemTime(Date.now() + 61_000)
    expect(await call(first, IPC.codexAccountsCommitSwitch, ticket)).toMatchObject({ ok: false })
    expect(fs.existsSync(target)).toBe(false)
    expect(await call(second, IPC.codexAccountsRemove, 'target')).toMatchObject({ ok: true })
  })

  it('cancels login polling when its owning connection leaves', async () => {
    vi.useFakeTimers()
    const waiting = call(first, IPC.codexAccountsWaitLogin, 'source')
    await vi.advanceTimersByTimeAsync(0)
    accounts.forgetClient(first); platform.detach(first)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await waiting).toMatchObject({ ok: true, result: null })
    expect(fs.existsSync(target)).toBe(false)
  })
})
