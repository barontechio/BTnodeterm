import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { MediaReferences, matchesMediaSignature } from './media-references'

describe('bounded media reference lifecycle', () => {
  let refs: MediaReferences
  let file: string
  let now: number
  let permitted: boolean
  const scope = { projectId: 'p', nodeId: 'v' }
  beforeEach(() => {
    file = path.join(testTmpDir('media-refs-'), 'clip.mp4')
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]))
    now = 0; permitted = true
    refs = new MediaReferences({ authorize: async () => permitted, ttlMs: 1000, now: () => now })
  })
  afterEach(() => refs.dispose())

  it('supports repeated reads and owner renewal while refusing foreign renewal/release', async () => {
    const token = await refs.issue(1, scope, file)
    expect(token).not.toContain(file)
    for (let i = 0; i < 2; i++) { const opened = await refs.open(token); expect(opened?.mime).toBe('video/mp4'); await opened?.handle.close() }
    expect(await refs.renew(2, token)).toBe(false)
    refs.release(2, token)
    now = 900; expect(await refs.renew(1, token)).toBe(true)
    now = 1200; const opened = await refs.open(token); expect(opened).not.toBeNull(); await opened?.handle.close()
    now = 1900; expect(await refs.open(token)).toBeNull()
  })

  it('refuses active HTML disguised as media and final symlinks', async () => {
    fs.writeFileSync(file, '<script>alert(1)</script>')
    await expect(refs.issue(1, scope, file)).rejects.toThrow('format')
    const linked = path.join(path.dirname(file), 'link.mp4'); fs.symlinkSync(file, linked)
    await expect(refs.issue(1, scope, linked)).rejects.toThrow('regular')
    expect(matchesMediaSignature('video/mp4', Buffer.from('ftyp'))).toBe(false)
  })

  it('pins the real file identity and refuses a replaced file or redirected parent', async () => {
    const token = await refs.issue(1, scope, file)
    fs.renameSync(file, `${file}.old`)
    fs.copyFileSync(`${file}.old`, file)
    expect(await refs.open(token)).toBeNull()
    const parent = path.join(path.dirname(file), 'parent'); fs.mkdirSync(parent)
    const inside = path.join(parent, 'clip.mp4'); fs.copyFileSync(file, inside)
    const next = await refs.issue(1, scope, inside)
    fs.renameSync(parent, `${parent}.old`); fs.symlinkSync(`${parent}.old`, parent)
    // Even a redirect to the same inode is no longer the canonical path that was approved.
    expect(await refs.open(next)).toBeNull()
  })

  it('revokes access and active streams when the node is removed, a client leaves or the service stops', async () => {
    const token = await refs.issue(1, scope, file)
    const opened = (await refs.open(token))!
    const abort = vi.fn(); const release = opened.attach(abort)!
    permitted = false; expect(await refs.renew(1, token)).toBe(false)
    expect(abort).toHaveBeenCalledOnce(); release(); release(); await opened.handle.close()
    permitted = true
    const next = await refs.issue(1, scope, file); refs.forgetClient(1)
    expect(await refs.open(next)).toBeNull()
    const last = await refs.issue(1, scope, file); refs.dispose()
    expect(await refs.open(last)).toBeNull()
    await expect(refs.issue(1, scope, file)).rejects.toThrow('refused')
  })

  it('bounds owner references and simultaneous streams', async () => {
    const first = await refs.issue(1, scope, file)
    for (let i = 0; i < 64; i++) await refs.issue(1, scope, file)
    expect(await refs.open(first)).toBeNull()
    const token = await refs.issue(1, scope, file)
    const opened = (await refs.open(token))!
    const releases = Array.from({ length: 8 }, () => opened.attach(() => {}))
    expect(releases.every(Boolean)).toBe(true)
    expect(opened.attach(() => {})).toBeNull()
    releases[0]!(); expect(opened.attach(() => {})).not.toBeNull()
    releases.slice(1).forEach((release) => release!())
    await opened.handle.close()
  })

  it('bounds issuance before filesystem work and refuses late results after shutdown', async () => {
    let resolve!: (allowed: boolean) => void
    const gate = new Promise<boolean>((done) => { resolve = done })
    refs.dispose(); refs = new MediaReferences({ authorize: () => gate })
    const requests = Array.from({ length: 32 }, () => refs.issue(1, scope, file))
    await expect(refs.issue(1, scope, file)).rejects.toThrow('media-busy')
    refs.dispose(); resolve(true)
    const results = await Promise.allSettled(requests)
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
  })
})
