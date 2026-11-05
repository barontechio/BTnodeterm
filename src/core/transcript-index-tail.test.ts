import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants, promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { fakePlatform } from './platform-fake'

const CAP = 5 * 1024 * 1024
const SID = '0123abcd-0000-4000-8000-00000000000a'
const row = (text: string) => JSON.stringify({ type: 'user', cwd: '/c', message: { role: 'user', content: text } }) + '\n'
let dir: string
let file: string
let cfg: string
let mod: typeof import('./transcript-index')
let core: typeof import('./platform')
let extract: ReturnType<typeof vi.spyOn>
const realOpen = fs.open.bind(fs)
const realStat = fs.stat.bind(fs)

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  dir = await fs.mkdtemp(join(tmpdir(), 'nt-index-tail-'))
  cfg = join(dir, 'config')
  await fs.mkdir(join(cfg, 'projects', '-project'), { recursive: true })
  file = join(cfg, 'projects', '-project', `${SID}.jsonl`)
  await fs.writeFile(file, row('original'))
  core = await import('./platform')
  core.initPlatform(fakePlatform())
  extract = vi.spyOn(await import('./transcript-index-core'), 'extractEntryFields')
  mod = await import('./transcript-index')
})
afterEach(async () => {
  await mod.stopTranscriptIndex()
  vi.restoreAllMocks()
  vi.useRealTimers()
  core.resetPlatformForTests()
  await fs.rm(dir, { recursive: true, force: true })
})
async function refresh() {
  mod.initTranscriptIndex(() => [{ id: 'linked', label: 'L', createdAt: 1, configDir: cfg }])
  await mod.refreshTranscriptIndex()
  return extract.mock.calls.at(-1)?.[0] as string
}
function onOpen(hook: (fh: FileHandle) => Promise<void>) {
  return vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
    const fh = await realOpen(p, flags, mode)
    if (String(p) === file) await hook(fh)
    return fh
  })
}
function afterScan(hook: () => Promise<void>) {
  let done = false
  vi.spyOn(fs, 'stat').mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
    const st = await realStat(...args)
    if (String(args[0]) === file && !done) { done = true; await hook() }
    return st
  }) as typeof fs.stat)
}

describe('descriptor-bound transcript index tail', () => {
  it.each(['grow', 'replace'])('bounds a small scanned file that becomes large before open: %s', async (kind) => {
    const large = row('excluded-head') + 'x'.repeat(CAP) + '\n' + row('retained-tail')
    afterScan(async () => {
      if (kind === 'replace') await fs.rename(file, join(dir, 'old'))
      await fs.writeFile(file, large)
    })
    const readFile = vi.spyOn(fs, 'readFile')
    const text = await refresh()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CAP)
    expect(text).toBe(row('retained-tail'))
    expect(readFile.mock.calls.some(([p]) => String(p) === file)).toBe(false)
    expect(mod.searchTranscripts('retained-tail', { accountId: 'linked' })).toHaveLength(1)
    expect(mod.searchTranscripts('excluded-head')).toEqual([])
  })

  it.each(['grow', 'replace'])('keeps the small-file bound when %s happens immediately before reading', async (kind) => {
    const mutate = async () => {
      if (kind === 'replace') await fs.rename(file, join(dir, 'old'))
      await fs.writeFile(file, row('original') + 'x'.repeat(CAP * 2))
    }
    // Exercise the old readFile branch as well as the descriptor branch at the same boundary.
    const readFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation((async (p: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (String(p) === file) await mutate()
      return (readFile as (...a: unknown[]) => Promise<unknown>)(p, ...args)
    }) as typeof fs.readFile)
    onOpen(async (fh) => {
      const read = fh.read.bind(fh)
      vi.spyOn(fh, 'read').mockImplementationOnce((async (opts: { buffer: Buffer; offset?: number; length: number; position: number }) => {
        await mutate()
        return read(opts)
      }) as typeof fh.read)
    })
    const text = await refresh()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CAP)
    expect(text).toBe(row('original'))
  })

  it('does not follow a large pathname replacement after opening', async () => {
    await fs.writeFile(file, 'x'.repeat(CAP + 13) + '\n' + row('captured'))
    let allocated = 0
    let readBytes = 0
    onOpen(async (fh) => {
      const read = fh.read.bind(fh)
      vi.spyOn(fh, 'read').mockImplementation((async (opts: { buffer: Buffer; offset?: number; length: number; position: number }) => {
        allocated = Math.max(allocated, opts.buffer.length)
        const result = await read(opts)
        readBytes += result.bytesRead
        return result
      }) as typeof fh.read)
      await fs.rename(file, join(dir, 'captured'))
      await fs.writeFile(file, row('replacement'))
    })
    expect(await refresh()).toBe(row('captured'))
    expect(allocated).toBe(CAP)
    expect(readBytes).toBe(CAP)
    expect(mod.searchTranscripts('replacement')).toEqual([])
  })

  it('derives the tail offset from the opened file when replacement occurs before open', async () => {
    await fs.writeFile(file, 'x'.repeat(CAP + 99))
    afterScan(async () => {
      await fs.rename(file, join(dir, 'old'))
      await fs.writeFile(file, row('new-small'))
    })
    expect(await refresh()).toBe(row('new-small'))
  })

  it('bounds growth after descriptor stat to the captured window', async () => {
    let grew = false
    onOpen(async (fh) => {
      const stat = fh.stat.bind(fh)
      vi.spyOn(fh, 'stat').mockImplementation((async () => {
        const st = await stat()
        await fs.appendFile(file, 'x'.repeat(CAP * 2))
        grew = true
        return st
      }) as typeof fh.stat)
    })
    expect(await refresh()).toBe(row('original'))
    expect(grew).toBe(true)
  })

  it('handles truncation and short reads without zero padding, and closes', async () => {
    await fs.writeFile(file, 'x'.repeat(CAP) + '\n' + row('old-tail'))
    let close: ReturnType<typeof vi.spyOn> | undefined
    onOpen(async (fh) => {
      close = vi.spyOn(fh, 'close')
      const stat = fh.stat.bind(fh)
      vi.spyOn(fh, 'stat').mockImplementation((async () => {
        const st = await stat()
        const start = st.size - CAP
        await fs.writeFile(file, 'x'.repeat(start) + '\n' + row('short'))
        return st
      }) as typeof fh.stat)
      const read = fh.read.bind(fh)
      vi.spyOn(fh, 'read').mockImplementation((async (opts: { buffer: Buffer; offset?: number; length: number; position: number }) => {
        return read({ ...opts, length: Math.min(opts.length, 17) })
      }) as typeof fh.read)
    })
    const text = await refresh()
    expect(text.includes('\0')).toBe(false)
    expect(text).toBe(row('short'))
    expect(close).toHaveBeenCalledOnce()
  })

  it.each(['stat', 'read'] as const)('returns no text and closes on descriptor %s error', async (operation) => {
    let close: ReturnType<typeof vi.spyOn> | undefined
    onOpen(async (fh) => {
      close = vi.spyOn(fh, 'close')
      if (operation === 'stat') vi.spyOn(fh, 'stat').mockRejectedValue(new Error('injected stat failure'))
      else vi.spyOn(fh, 'read').mockRejectedValue(new Error('injected read failure'))
    })
    expect(await refresh()).toBe('')
    expect(close).toHaveBeenCalledOnce()
    expect(mod.searchTranscripts('original')).toEqual([])
  })

  it('rejects directories without reading them and closes the handle if opened', async () => {
    await fs.unlink(file)
    await fs.mkdir(file)
    let read: ReturnType<typeof vi.spyOn> | undefined
    let close: ReturnType<typeof vi.spyOn> | undefined
    onOpen(async (fh) => { read = vi.spyOn(fh, 'read'); close = vi.spyOn(fh, 'close') })
    expect(await refresh()).toBe('')
    if (close) { expect(close).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled() }
  })

  it.skipIf(!constants.O_NOFOLLOW)('refuses a final symlink swapped in after scanning', async () => {
    const target = join(dir, 'target')
    await fs.writeFile(target, row('symlink-content'))
    afterScan(async () => { await fs.unlink(file); await fs.symlink(target, file) })
    expect(await refresh()).toBe('')
    expect(mod.searchTranscripts('symlink-content')).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || !constants.O_NONBLOCK)('opens a FIFO nonblocking, rejects it and closes', async () => {
    await fs.unlink(file)
    execFileSync('mkfifo', [file])
    // Refuse unsafe flags in the seam so a regression cannot hang the suite on FIFO open.
    const readFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(((p: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (String(p) === file) return Promise.reject(new Error('unsafe FIFO readFile'))
      return (readFile as (...args: unknown[]) => Promise<unknown>)(p, ...args)
    }) as typeof fs.readFile)
    let close: ReturnType<typeof vi.spyOn> | undefined
    const open = vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
      if (String(p) === file && (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK))) {
        throw new Error('unsafe blocking FIFO open')
      }
      const fh = await realOpen(p, flags, mode)
      if (String(p) === file) close = vi.spyOn(fh, 'close')
      return fh
    })
    expect(await refresh()).toBe('')
    expect(close).toHaveBeenCalledOnce()
    const calls = open.mock.calls.filter(([p]) => String(p) === file)
    expect(calls).toHaveLength(1)
    expect(Number(calls[0][1]) & constants.O_NONBLOCK).not.toBe(0)
  })

  it('awaits and closes an in-flight descriptor read on shutdown without publishing it', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reading = new Promise<void>((resolve) => { entered = resolve })
    let close: ReturnType<typeof vi.spyOn> | undefined
    onOpen(async (fh) => {
      close = vi.spyOn(fh, 'close')
      const read = fh.read.bind(fh)
      vi.spyOn(fh, 'read').mockImplementationOnce((async (opts: { buffer: Buffer; length: number; position: number }) => {
        entered()
        await gate
        return read(opts)
      }) as typeof fh.read)
    })
    const pending = refresh()
    await reading
    let stopped = false
    const stopping = mod.stopTranscriptIndex().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await Promise.all([pending, stopping])
    expect(close).toHaveBeenCalledOnce()
    expect(mod.searchTranscripts('original')).toEqual([])
    expect(mod.loadPersistedIndex(join(core.platform().userDataDir, 'transcript-index.json'))).toEqual([])
  })

  it('parses small transcripts and skips unchanged entries', async () => {
    expect(await refresh()).toBe(row('original'))
    expect(mod.searchTranscripts('original', { accountId: 'linked', cwd: '/c' })).toHaveLength(1)
    extract.mockClear()
    await mod.refreshTranscriptIndex()
    expect(extract).not.toHaveBeenCalled()
  })
})
