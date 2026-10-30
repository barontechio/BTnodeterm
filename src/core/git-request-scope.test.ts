import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from './git-service'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import { IPC } from '../shared/ipc'
import { resolveGitRemote, setGitRemoteResolver, withGitRemoteResolver, type GitRemoteRef } from './remote-ssh/remote-git'

const remote = vi.hoisted(() => vi.fn(async (_ref: unknown, _cwd: string, _args: string[]) => ({ ok: true, out: '', err: '' })))
vi.mock('./remote-ssh/remote-git', async (importOriginal) => ({
  ...await importOriginal<typeof import('./remote-ssh/remote-git')>(), runRemoteGit: remote
}))
const reference = (id: string): GitRemoteRef => ({ conn: { host: id, user: 'fixture' }, controlPath: `/socket/${id}` })
afterEach(() => { setGitRemoteResolver(null); resetPlatformForTests(); remote.mockClear() })

describe('request-local Git destination', () => {
  it('keeps concurrent request destinations after awaits and restores the native fallback afterwards', async () => {
    const native = reference('native'); setGitRemoteResolver(() => native)
    const a = reference('a'); const b = reference('b')
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve })
    const first = withGitRemoteResolver(() => a, async () => { await gate; return resolveGitRemote('/same/path') })
    const second = withGitRemoteResolver(() => b, async () => { await Promise.resolve(); return resolveGitRemote('/same/path') })
    expect(await second).toBe(b); resume(); expect(await first).toBe(a)
    expect(resolveGitRemote('/same/path')).toBe(native)
    expect(withGitRemoteResolver(() => undefined, () => resolveGitRemote('/same/path'))).toBeUndefined()
  })

  it('captures each RPC sender before starting a multi-step operation', async () => {
    const platform = fakePlatform(); initPlatform(platform)
    const targets = new Map([[1, reference('a')], [2, reference('b')]])
    const service = new GitService()
    service.registerIpc((sender, _channel, _args, operation) => {
      const destination = targets.get(sender)
      return withGitRemoteResolver(() => destination, operation)
    })
    const one = platform.handlers[IPC.gitSync](1, '/same/path')
    targets.set(1, reference('replacement'))
    const two = platform.handlers[IPC.gitSync](2, '/same/path')
    await Promise.all([one, two])
    expect(remote.mock.calls.map(([ref]) => (ref as GitRemoteRef).conn.host).sort()).toEqual(['a', 'a', 'b', 'b'])
  })

  it('lets an unavailable remote scope refuse before any local Git side effect', async () => {
    const directory = testTmpDir('git-scope-refusal-'); const service = new GitService()
    await expect(withGitRemoteResolver(() => { throw new Error('remote-unavailable') }, () => service.init(directory))).rejects.toThrow('remote-unavailable')
    expect(fs.existsSync(path.join(directory, '.git'))).toBe(false)
    expect(remote).not.toHaveBeenCalled()
    expect((await withGitRemoteResolver(() => undefined, () => service.init(directory))).ok).toBe(true)
    expect(fs.existsSync(path.join(directory, '.git'))).toBe(true)
  })
})
