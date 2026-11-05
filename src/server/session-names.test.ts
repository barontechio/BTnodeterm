import { describe, expect, it, vi } from 'vitest'
import { ServerSessionNames, type SessionNameTarget } from './session-names'
import { IPC } from '../shared/ipc'
import { fakePlatform } from '../core/platform-fake'

const fixture = (): SessionNameTarget => ({ projectId: 'p', nodeId: 'node', sessionId: 'session', agentId: 'claude',
  accountId: 'account', remote: false, accountAvailable: true, cwd: '/repo' })

describe('Server node-bound session name reads', () => {
  it('infers the saved local account, forwards the harness and binds the owner RPC to a node', async () => {
    const read = vi.fn(async () => 'Session name')
    const names = new ServerSessionNames({ owner: (id) => id === 1, target: () => fixture(), read })
    const host = fakePlatform(); names.register(host)
    expect(await host.handlers[IPC.ptyReadSessionName](1, 'session', undefined, 'claude', 'node')).toBe('Session name')
    expect(read).toHaveBeenCalledWith('session', 'account', 'claude')
    expect(await host.handlers[IPC.ptyReadSessionName](1, 'session', null, null, 'node')).toBe('Session name')
    expect(await host.handlers[IPC.ptyReadSessionName](2, 'session', 'account', 'claude', 'node')).toBeNull()
    expect(await names.read('session', 'account', 'claude')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never falls through to local lookup for a remote, missing, stale or mismatched target', async () => {
    let target: SessionNameTarget | undefined = fixture()
    const read = vi.fn(async () => 'must not leak')
    const names = new ServerSessionNames({ owner: () => true, target: () => target, read })
    for (const patch of [{ remote: true }, { accountAvailable: false }, { sessionId: 'replacement' },
      { agentId: 'unknown' }, { nodeId: 'another' }]) {
      target = { ...fixture(), ...patch }
      expect(await names.read('session', 'account', 'claude', 'node')).toBeNull()
    }
    target = fixture()
    expect(await names.read('session', 'other-account', 'claude', 'node')).toBeNull()
    expect(await names.read('session', 'account', 'gemini', 'node')).toBeNull()
    target = undefined
    expect(await names.read('session', 'account', 'claude', 'node')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('drops a local result if routing, account, session or project changes during its read', async () => {
    for (const patch of [{ remote: true }, { accountId: 'other' }, { sessionId: 'replacement' },
      { projectId: 'other' }, { cwd: '/other' }, { accountConfigDir: '/relinked-account' }]) {
      let target = fixture(); let finish!: (name: string) => void
      const read = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
      const names = new ServerSessionNames({ owner: () => true, target: () => target, read })
      const pending = names.read('session', 'account', 'claude', 'node')
      target = { ...target, ...patch }; finish('old-context-name')
      expect(await pending).toBeNull(); expect(read).toHaveBeenCalledTimes(1)
    }
  })

  it('contains failed/malformed reads so a mounted node can poll again', async () => {
    const read = vi.fn(async () => { throw new Error('reader unavailable') })
    const names = new ServerSessionNames({ owner: () => true, target: () => fixture(), read })
    expect(await names.read('session', 'account', 'claude', 'node')).toBeNull()
    expect(await names.read('../x\0', 'account', 'claude', 'node')).toBeNull()
    expect(await names.read('session', {}, 'claude', 'node')).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
