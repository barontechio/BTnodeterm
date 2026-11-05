import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import type { ClaudeAccount, Settings } from '../shared/types'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'

const naming = vi.hoisted(() => ({
  terminal: vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'Term' })),
  group: vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'Group' }))
}))
vi.mock('./commit-message', async (importActual) => ({
  ...(await importActual<typeof import('./commit-message')>()),
  generateTerminalName: naming.terminal,
  generateGroupName: naming.group
}))

import { registerNamingIpc } from './naming-ipc'

describe('registerNamingIpc (both shells)', () => {
  let fake: FakePlatform
  let accounts: ClaudeAccount[]
  const remote = new Set<string>()
  const settings = (): Settings => ({ claudeAccounts: accounts }) as unknown as Settings

  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
    accounts = []
    remote.clear()
    naming.terminal.mockClear()
    naming.group.mockClear()
    registerNamingIpc({
      captureSession: async (k) => `output of ${k}`,
      sshRemoteForNode: (k) => (remote.has(k) ? {} : undefined),
      getSettings: settings
    })
  })

  afterEach(() => resetPlatformForTests())

  const name = (...args: unknown[]) => fake.handlers[IPC.ptyGenerateName](...args)
  const groupName = (...args: unknown[]) => fake.handlers[IPC.ptyGenerateGroupName](...args)

  it('names a local node from its captured output, in its own cwd, under the system login', async () => {
    await expect(name('n1', '/repo')).resolves.toEqual({ ok: true, message: 'Term' })
    expect(naming.terminal).toHaveBeenCalledWith('output of n1', '/repo', settings(), undefined)
  })

  it('drops the cwd of an SSH-project node (a remote path does not exist here)', async () => {
    remote.add('n1')
    await name('n1', '/remote/repo')
    expect(naming.terminal.mock.calls[0][1]).toBe('')
  })

  it("runs under the node's managed Claude account when its dir exists", async () => {
    accounts = [{ id: 'acct1' } as ClaudeAccount]
    const dir = join(fake.userDataDir, 'claude-accounts', 'acct1')
    mkdirSync(dir, { recursive: true })
    await name('n1', '/repo', 'acct1')
    expect(naming.terminal.mock.calls[0][3]).toMatchObject({ CLAUDE_CONFIG_DIR: dir })
  })

  it('falls back to the system login for an unknown, pending, remote or missing account', async () => {
    accounts = [
      { id: 'pend', pending: true } as ClaudeAccount,
      { id: 'ssh', host: 'box' } as unknown as ClaudeAccount,
      { id: 'gone' } as ClaudeAccount
    ]
    for (const id of ['pend', 'ssh', 'gone', 'unknown']) {
      mkdirSync(join(fake.userDataDir, 'claude-accounts', id === 'gone' ? 'other' : id), { recursive: true })
      await name('n1', '/repo', id)
    }
    expect(naming.terminal.mock.calls.map((c) => c[3])).toEqual([undefined, undefined, undefined, undefined])
  })

  it('names a group from every member, dropping the cwd if any member is remote', async () => {
    await groupName(['a', 'b'], '/repo')
    expect(naming.group).toHaveBeenLastCalledWith(['output of a', 'output of b'], '/repo', settings())
    remote.add('b')
    await groupName(['a', 'b'], '/repo')
    expect(naming.group.mock.calls[1][1]).toBe('')
  })
})
