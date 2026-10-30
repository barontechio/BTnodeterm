import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { SshStore } from './ssh-store'
import { testTmpDir } from '../core/test-tmp'

async function tmpFile(): Promise<string> {
  const dir = testTmpDir('ssh-store-')
  return path.join(dir, 'ssh-servers.json')
}

describe('SshStore', () => {
  it('is empty before any save', async () => {
    const store = new SshStore(await tmpFile())
    expect(store.list()).toEqual([])
  })

  it('save adds, save with same id updates, remove deletes', async () => {
    const store = new SshStore(await tmpFile())
    await store.save({ id: 'a', label: 'A', host: 'h1', user: 'u1' })
    expect(store.list().length).toBe(1)
    await store.save({ id: 'a', label: 'A2', host: 'h1', user: 'u1', port: 2200 })
    expect(store.list().length).toBe(1)
    expect(store.list()[0].label).toBe('A2')
    expect(store.list()[0].port).toBe(2200)
    await store.remove('a')
    expect(store.list()).toEqual([])
  })

  it('persists to disk and reloads', async () => {
    const file = await tmpFile()
    const s1 = new SshStore(file)
    await s1.save({ id: 'x', label: 'X', host: 'h', user: 'u' })
    const s2 = new SshStore(file)
    expect(s2.list().length).toBe(1)
    expect(s2.list()[0].id).toBe('x')
  })
})
