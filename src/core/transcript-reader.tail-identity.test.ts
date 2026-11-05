import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCappedTail, readSmallTail } from './transcript-reader'

describe('transcript tails retain the measured file identity', () => {
  let directory: string
  let file: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-tail-identity-'))
    file = path.join(directory, 'transcript.jsonl')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  for (const [name, read] of [['capped', readCappedTail], ['small', readSmallTail]] as const) {
    for (const large of [false, true]) {
      it(`${name} reads the original ${large ? 'large' : 'small'} file after pathname replacement`, async () => {
        const original = large ? 'old header\noriginal tail\n' : 'original\n'
        fs.writeFileSync(file, original)
        const open = fs.promises.open.bind(fs.promises)
        let close: ReturnType<typeof vi.spyOn> | undefined
        vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args)
          close = vi.spyOn(handle, 'close')
          const stat = handle.stat.bind(handle)
          vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
            const measured = await stat()
            fs.renameSync(file, `${file}.original`)
            fs.writeFileSync(file, 'replacement contents must never be read\n')
            return measured
          })
          return handle
        })
        expect(await read(file, 15)).toBe(large ? 'original tail\n' : original)
        expect(close).toHaveBeenCalledOnce()
        expect(fs.readFileSync(file, 'utf8')).toBe('replacement contents must never be read\n')
      })
    }

    it(`${name} returns no bytes from a tail truncated after measurement`, async () => {
      fs.writeFileSync(file, 'old header\noriginal tail\n')
      const open = fs.promises.open.bind(fs.promises)
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          const measured = await stat()
          fs.truncateSync(file, 0)
          return measured
        })
        return handle
      })
      expect(await read(file, 15)).toBe('')
    })
  }
})
