import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import { registerTranscriptSearchIpc } from './transcript-search-ipc'
import { refreshTranscriptIndex, searchTranscripts } from './transcript-index'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'
import type { ClaudeAccount, TranscriptHit, TranscriptSearchScope } from '../shared/types'

describe('host-owner transcript search', () => {
  let platform: FakePlatform
  let accounts: ClaudeAccount[]
  let stop: () => Promise<void>
  let dir: string
  const sid = '0123abcd-0000-4000-8000-00000000000a'
  const search = (query: unknown, scope?: TranscriptSearchScope, sender = 1): Promise<TranscriptHit[]> =>
    Promise.resolve(platform.handlers[scope === undefined ? IPC.transcriptSearch : IPC.transcriptSearchScoped](sender, query, scope) as TranscriptHit[])

  beforeEach(async () => {
    dir = testTmpDir('transcript-search-')
    await fs.mkdir(path.join(dir, 'data'))
    accounts = []
    for (const id of ['a', 'b']) {
      const configDir = path.join(dir, id)
      const project = path.join(configDir, 'projects', '-project')
      await fs.mkdir(project, { recursive: true })
      await fs.writeFile(path.join(project, `${sid}.jsonl`), JSON.stringify({
        type: 'user', cwd: `/project-${id}`, message: { role: 'user', content: `needle from account ${id}` }
      }) + '\n')
      accounts.push({ id, label: id, createdAt: 1, configDir })
    }
    resetPlatformForTests()
    platform = fakePlatform({ userDataDir: path.join(dir, 'data'), isOwnerClient: (id) => id === 1 })
    initPlatform(platform)
    stop = registerTranscriptSearchIpc(platform, () => accounts, { lazy: true })
  })
  afterEach(async () => { await stop(); vi.restoreAllMocks(); resetPlatformForTests() })

  it('waits for the first scan and keeps same-id conversations in their respective accounts', async () => {
    const hits = await search('needle')
    expect(hits.map((h) => h.accountId).sort()).toEqual(['a', 'b'])
    expect(hits.find((h) => h.accountId === 'a')!.snippet).toContain('account a')
    expect(hits.find((h) => h.accountId === 'b')!.snippet).toContain('account b')
    await refreshTranscriptIndex()
    expect((await search('needle')).map((h) => h.accountId).sort()).toEqual(['a', 'b'])
    expect(await search('needle', { accountId: 'a', cwd: '/project-a', limit: 1 })).toMatchObject([{ accountId: 'a' }])
    expect(await search('needle', { accountId: 'a', cwd: '/project-b' })).toEqual([])
    expect(await search('needle', { accountId: 'unknown' })).toEqual([])
    expect(await search('needle', { accountId: null })).toEqual([])
  })

  it('immediately excludes removed and remote accounts without falling back to system identity', async () => {
    await search('needle')
    accounts = [accounts[0]]
    expect(searchTranscripts('needle').map((h) => h.accountId)).toEqual(['a'])
    accounts[0].host = 'remote'
    expect(searchTranscripts('needle')).toEqual([])
  })

  it('rejects non-owner and unbounded requests, and stops serving after shutdown', async () => {
    expect(isHostOnlyChannel(IPC.transcriptSearch)).toBe(true)
    expect(isHostOnlyChannel(IPC.transcriptSearchScoped)).toBe(true)
    await expect(search('needle', undefined, 2)).rejects.toThrow('owner-required')
    await expect(search({ query: 'needle' })).rejects.toThrow('invalid-query')
    await expect(search('x'.repeat(513))).rejects.toThrow('invalid-query')
    await expect(search('needle', { limit: 101 })).rejects.toThrow('invalid-scope')
    await expect(search('needle', { limit: -1 })).rejects.toThrow('invalid-scope')
    await expect(fs.stat(path.join(dir, 'data', 'transcript-index.json'))).rejects.toThrow()
    await search('needle')
    await stop()
    await expect(search('needle')).rejects.toThrow('owner-required')
    expect(searchTranscripts('needle')).toEqual([])
  })

  it('cancels a cold scan on shutdown without persisting or returning its results', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const scanning = new Promise<void>((resolve) => { entered = resolve })
    const readdir = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation((async (target: string, ...args: unknown[]) => {
      if (String(target) === path.join(dir, 'a', 'projects')) { entered(); await gate }
      return (readdir as (...values: unknown[]) => Promise<unknown>)(target, ...args)
    }) as unknown as typeof fs.readdir)
    const pending = search('needle')
    const refused = expect(pending).rejects.toThrow('owner-required')
    await scanning
    const stopping = stop()
    release()
    await Promise.all([stopping, refused])
    await expect(fs.stat(path.join(dir, 'data', 'transcript-index.json'))).rejects.toThrow()
  })
})
