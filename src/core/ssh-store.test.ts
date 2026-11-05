import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SshStore } from './ssh-store'
import { testTmpDir } from './test-tmp'
import * as atomic from './fs-atomic'

describe('durable SSH inventory', () => {
  it('orders concurrent save/remove operations against the latest durable inventory', async () => {
    const file = path.join(testTmpDir('ssh-inventory-'), 'ssh-servers.json'); const store = new SshStore(file)
    await Promise.all([store.save({ id: 'a', label: 'A', host: 'a', user: 'u' }),
      store.save({ id: 'b', label: 'B', host: 'b', user: 'u' }), store.remove('a')])
    expect(store.list().map((server) => server.id)).toEqual(['b'])
    expect(new SshStore(file).list()).toEqual(store.list())
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    const copy = store.list(); copy[0].host = 'mutated'
    expect(store.list()[0].host).toBe('b')
  })
  it('retains the durable cache after a failed save, and the next edit recovers', async () => {
    const file = path.join(testTmpDir('ssh-inventory-'), 'ssh-servers.json'); const store = new SshStore(file)
    await store.save({ id: 'a', label: 'A', host: 'original', user: 'u' })
    const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'))
    try {
      await expect(store.save({ id: 'a', label: 'A', host: 'failed', user: 'u' })).rejects.toThrow('disk full')
      expect(store.list()[0].host).toBe('original'); expect(new SshStore(file).list()).toEqual(store.list())
      await store.save({ id: 'b', label: 'B', host: 'b', user: 'u' })
      expect(store.list().map((server) => server.host)).toEqual(['original', 'b'])
    } finally { write.mockRestore() }
  })
})
