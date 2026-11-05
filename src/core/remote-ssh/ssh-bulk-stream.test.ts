import { describe, it, expect, vi } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { streamSshCommand, type BulkChannel, type BulkStreamOptions } from './ssh-bulk-stream'
import { SshChildGate } from './ssh-child-gate'
import { childArgs } from './control-master'

const args = childArgs({ host: 'fixture.invalid', user: 'fixture' }, '/fixture/mux', 'cat')
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const options = (overrides: Partial<BulkStreamOptions> = {}): BulkStreamOptions => ({
  signal: new AbortController().signal, current: () => true, maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024, timeoutMs: 5000,
  consume: async output => { for await (const _ of output) { /* drain */ } }, ...overrides
})
function fakeChannel(autoClose = true) {
  const stdin = new PassThrough({ highWaterMark: 64 * 1024 })
  const stdout = new PassThrough({ highWaterMark: 64 * 1024 })
  const stderr = new PassThrough()
  const closed = deferred<number>()
  stdin.on('error', () => {}); stdout.on('error', () => {})
  stdin.pipe(stdout)
  stdin.on('end', () => { if (autoClose) { stderr.end(); closed.resolve(0) } })
  const cancel = vi.fn(() => {
    stdin.destroy(); stdout.destroy(); stderr.destroy()
    if (autoClose) closed.resolve(255)
  })
  return { stdin, stdout, stderr, closed: closed.promise, cancel, finish: closed.resolve }
}

describe('bounded SSH bulk transport custody', () => {
  it('streams exact bytes with backpressure without collecting the body', async () => {
    const gate = new SshChildGate(1)
    const chunk = Buffer.alloc(65536, 0xa7)
    const expected = createHash('sha256'); for (let i = 0; i < 32; i++) expected.update(chunk)
    const received = createHash('sha256')
    let largestBuffered = 0
    const channel = fakeChannel()
    const result = await streamSshCommand(gate, args, options({
      input: Readable.from((function* () { for (let i = 0; i < 32; i++) yield chunk })()),
      consume: async output => {
        for await (const data of output) {
          received.update(data)
          largestBuffered = Math.max(largestBuffered, channel.stdout.readableLength)
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    }), () => channel)
    expect(received.digest('hex')).toBe(expected.digest('hex'))
    expect(result).toEqual({ code: 0, dispatched: true, interrupted: false, inputBytes: 2 * 1024 * 1024, outputBytes: 2 * 1024 * 1024 })
    expect(largestBuffered).toBeLessThanOrEqual(128 * 1024)
    expect(gate.inFlight('/fixture/mux')).toBe(0)
  })

  it('keeps a cancelled pending open and late close in the common gate', async () => {
    const gate = new SshChildGate(1), abort = new AbortController()
    const opening = deferred<BulkChannel>(), channel = fakeChannel(false)
    let entered = false
    const first = streamSshCommand(gate, args, options({ signal: abort.signal }), async () => { entered = true; return opening.promise })
    await vi.waitFor(() => expect(entered).toBe(true))
    abort.abort()
    const secondOpen = vi.fn(() => fakeChannel())
    const second = streamSshCommand(gate, args, options(), secondOpen)
    await vi.waitFor(() => expect(gate.queued('/fixture/mux')).toBe(1))
    expect(gate.inFlight('/fixture/mux')).toBe(1)
    opening.resolve(channel)
    await vi.waitFor(() => expect(channel.cancel).toHaveBeenCalled())
    expect(secondOpen).not.toHaveBeenCalled()
    channel.finish(255)
    expect((await first).interrupted).toBe(true)
    expect((await second).code).toBe(0)
    expect(gate.inFlight('/fixture/mux')).toBe(0)
  })

  it('does not dispatch a queued command after its target expires', async () => {
    const gate = new SshChildGate(1), held = deferred<void>()
    const occupying = gate.run(args, () => held.promise)
    let active = true
    const open = vi.fn(() => fakeChannel())
    const pending = streamSshCommand(gate, args, options({ current: () => active }), open)
    await vi.waitFor(() => expect(gate.queued('/fixture/mux')).toBe(1))
    active = false; held.resolve(); await occupying
    const result = await pending
    expect(result.dispatched).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['input', 'output'] as const)('cancels a stream exceeding its %s byte limit', async direction => {
    const channel = fakeChannel()
    const result = await streamSshCommand(new SshChildGate(1), args, options({
      input: Readable.from([Buffer.alloc(128)]),
      ...(direction === 'input' ? { maxInputBytes: 64 } : { maxOutputBytes: 64 })
    }), () => channel)
    expect(result.interrupted).toBe(true)
    expect(channel.cancel).toHaveBeenCalled()
  })
})
