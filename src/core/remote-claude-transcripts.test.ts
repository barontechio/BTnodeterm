import { describe, expect, it, vi } from 'vitest'
import { RemoteClaudeTranscripts, type RemoteClaudeTranscriptTarget } from './remote-claude-transcripts'
import type { TranscriptQuery } from './transcript-ipc'

const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
const q: TranscriptQuery = { nodeId: 'node', sessionId: sid, accountId: 'managed', cwd: '/repo' }
const page = { before: null, maxBytes: 64 }
const target = (): RemoteClaudeTranscriptTarget => ({ nodeId: 'node', projectId: 'project', sessionId: sid,
  accountId: 'managed', home: '/home/fixture', cwd: '/repo', conn: { host: 'host', user: 'fixture' },
  controlPath: '/control', connectionKey: 'generation-1' })
const reply = { code: 0, stdout: JSON.stringify({ start: 0, size: 4, data: Buffer.from('data').toString('base64') }) }
function fixture() {
  let current: RemoteClaudeTranscriptTarget | null | undefined = target()
  const run = vi.fn(async () => reply)
  const service = new RemoteClaudeTranscripts({ targetFor: () => current, run,
    withQueuedExecutionCheck: async (valid, work) => { if (!valid()) throw new Error('stale'); return work() } })
  return { service, run, set: (value: typeof current) => { current = value } }
}

describe('node-bound remote Claude transcript reads', () => {
  it('uses the authoritative host/account and returns exact bytes through every read facade', async () => {
    const f = fixture()
    expect(await f.service.readPage(q, page)).toEqual({ ok: true, start: 0, data: Buffer.from('data') })
    expect(await f.service.read(q)).toBe('data')
    // Presence reads use a one-byte bound plus lookbehind, so this response has two bytes.
    f.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ start: 2, size: 4, data: Buffer.from('ta').toString('base64') }) })
    expect(await f.service.exists(q)).toBe('present')
    expect(f.run).toHaveBeenCalledWith(target(), expect.stringContaining("'managed'"))
    f.service.dispose()
  })

  it('keeps local, disconnected, absent, unsupported-runtime and unsafe-target outcomes distinct', async () => {
    const f = fixture(); f.set(undefined)
    expect(await f.service.readPage(q, page)).toBeNull()
    expect(await f.service.readPage({ ...q, remoteOnly: true }, page)).toEqual({ ok: false })
    f.set(null); expect(await f.service.exists(q)).toBe('unknown')
    f.set(target())
    for (const code of [66, 67, 68, 69, 127]) {
      f.run.mockResolvedValueOnce({ code, stdout: '' })
      expect(await f.service.readPage(q, page)).toEqual(code === 66 ? { ok: false, absent: true } :
        code === 67 ? { ok: false, reason: 'remote-unsafe-transcript' } :
          code === 69 || code === 127 ? { ok: false, reason: 'remote-runtime-unavailable' } : { ok: false })
    }
    f.run.mockResolvedValueOnce({ code: 66, stdout: '' }); expect(await f.service.exists(q)).toBe('absent')
    f.service.dispose()
  })

  it('does not query a foreign session/account or use malformed data to prove absence', async () => {
    const f = fixture()
    expect(await f.service.readPage({ ...q, accountId: 'other' }, page)).toEqual({ ok: false })
    expect(await f.service.exists({ ...q, sessionId: 'different-session' })).toBe('unknown')
    expect(f.run).not.toHaveBeenCalled()
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'malformed' })
    expect(await f.service.exists(q)).toBe('unknown')
    f.service.dispose()
  })

  it('discards replies from a replaced account, host generation, project or conversation', async () => {
    for (const patch of [{ accountId: 'other' }, { connectionKey: 'generation-2' }, { projectId: 'other' }, { sessionId: 'new-session' }]) {
      const f = fixture(); let finish!: (result: typeof reply) => void
      f.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      const pending = f.service.readPage(q, page)
      f.set({ ...target(), ...patch }); finish(reply)
      expect(await pending).toEqual({ ok: false }); f.service.dispose()
    }
  })

  it('bounds in-flight requests and retains pending work until its backend settles on disposal', async () => {
    const f = fixture(); const finishes: Array<(result: typeof reply) => void> = []
    f.run.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve) }))
    const first = f.service.readPage(q, page); const second = f.service.readPage(q, page)
    expect(await f.service.readPage(q, page)).toEqual({ ok: false }); expect(f.run).toHaveBeenCalledTimes(2)
    f.service.dispose()
    expect(await f.service.readPage(q, page)).toEqual({ ok: false }); expect(f.run).toHaveBeenCalledTimes(2)
    for (const finish of finishes) finish(reply)
    expect(await Promise.all([first, second])).toEqual([{ ok: false }, { ok: false }])
  })

  it('captures query arguments before a queue wait', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(async () => reply)
    const service = new RemoteClaudeTranscripts({ targetFor: () => target(), run,
      withQueuedExecutionCheck: async (current, work) => { await hold; if (!current()) throw new Error('stale'); return work() } })
    const query = { ...q }; const window = { ...page }
    const pending = service.readPage(query, window)
    query.sessionId = 'changed'; window.maxBytes = 1
    release(); expect(await pending).toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith(target(), expect.stringContaining("'64'")); service.dispose()
  })
})
