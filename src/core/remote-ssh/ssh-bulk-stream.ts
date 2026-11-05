import { spawn } from 'node:child_process'
import { Readable, Writable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { channelExit, type NativeMux } from './native/native-mux'
import { parseSshArgv } from './native/ssh-argv'
import { controlPathOf, isMuxControlCommand, type SshChildGate } from './ssh-child-gate'

/** Unlike the legacy setup pseudo-child, closed includes a pending native channel open. */
export interface BulkChannel {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  closed: Promise<number>
  cancel(): void
}
export interface BulkStreamOptions {
  current(): boolean
  signal: AbortSignal
  input?: Readable
  maxInputBytes: number
  maxOutputBytes: number
  timeoutMs: number
  /** Must consume incrementally; no result buffering is performed by the transport. */
  consume(output: Readable): Promise<void>
}
export interface BulkStreamResult {
  code: number
  dispatched: boolean
  interrupted: boolean
  inputBytes: number
  outputBytes: number
}
export type BulkStreamRunner = (args: string[], options: BulkStreamOptions) => Promise<BulkStreamResult>

/** Bulk commands use only the captured mux. Never silently authenticate a fallback connection. */
export function bulkCommandArgs(args: readonly string[]): string[] {
  if (!controlPathOf(args) || isMuxControlCommand(args)) throw new Error('ssh-stream-invalid-command')
  const parsed = parseSshArgv([...args])
  if (parsed.kind !== 'exec' || !parsed.command) throw new Error('ssh-stream-invalid-command')
  return args.map(arg => arg === 'ControlMaster=auto' ? 'ControlMaster=no' : arg)
}

export function openOpenSshBulk(ssh: string, args: readonly string[], env: NodeJS.ProcessEnv): BulkChannel {
  // A working mux bypasses ProxyCommand; absent mux cannot fall back to a new TCP login.
  const child = spawn(ssh, ['-o', 'ProxyCommand=false', ...bulkCommandArgs(args)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env
  })
  let failed = false
  child.on('error', () => { failed = true })
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  const closed = new Promise<number>(resolve => child.once('close', code => resolve(failed ? 255 : code ?? 255)))
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, closed,
    cancel: () => { child.kill('SIGKILL') } }
}

export async function openNativeBulk(mux: NativeMux, args: readonly string[], current: () => boolean): Promise<BulkChannel> {
  const parsed = parseSshArgv(bulkCommandArgs(args))
  if (parsed.kind !== 'exec') throw new Error('ssh-stream-invalid-command')
  const channel = await mux.channel(parsed, undefined, { current, existingOnly: true })
  // mux records close/exit inside ssh2's callback, before this await can miss either event.
  const closed = new Promise<number>(resolve => {
    const finish = () => resolve(channelExit(channel).code ?? 255)
    channel.once('close', finish)
    if (channelExit(channel).closed) finish()
  })
  channel.on('error', () => {})
  channel.stderr.on('error', () => {})
  const result = { stdin: channel, stdout: channel, stderr: channel.stderr, closed,
    cancel: () => {
      channel.close()
      // ssh2 emits close only after buffered stdout reaches end. A failed pipeline
      // unpipes/pauses its source; drain discarded bytes so physical close can settle.
      channel.resume(); channel.stderr.resume()
    } }
  if (!current()) result.cancel()
  return result
}

/** One common permit from enqueue until physical close, including late native open callbacks.
 * Caller cancellation is prompt at the HTTP layer; this promise deliberately retains custody. */
export async function streamSshCommand(
  gate: SshChildGate,
  args: readonly string[],
  options: BulkStreamOptions,
  open: (args: string[], current: () => boolean) => Promise<BulkChannel> | BulkChannel
): Promise<BulkStreamResult> {
  args = bulkCommandArgs(args)
  if (![options.maxInputBytes, options.maxOutputBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 512 * 1024 * 1024) ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error('ssh-stream-invalid-limits')
  const result: BulkStreamResult = { code: 255, dispatched: false, interrupted: false, inputBytes: 0, outputBytes: 0 }
  const abort = new AbortController()
  let channel: BulkChannel | undefined
  let inputLimit: Transform | undefined, outputLimit: Transform | undefined
  let closed = false
  const current = () => { try { return !abort.signal.aborted && options.current() } catch { return false } }
  const cancel = () => {
    result.interrupted = true
    abort.abort()
    if (!closed) channel?.cancel()
    options.input?.destroy(new Error('ssh-stream-cancelled'))
    inputLimit?.destroy(new Error('ssh-stream-cancelled'))
    outputLimit?.destroy(new Error('ssh-stream-cancelled'))
  }
  // Install handlers before cancellation can destroy a caller stream.
  options.input?.on('error', cancel)
  const onAbort = () => cancel()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(cancel, options.timeoutMs); timer.unref?.()
  const validity = setInterval(() => { if (!current()) cancel() }, 250); validity.unref?.()
  if (options.signal.aborted || !current()) cancel()
  const limit = (field: 'inputBytes' | 'outputBytes', max: number) => new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, done) {
      if (!current() || result[field] + chunk.length > max) return done(new Error('ssh-stream-limit'))
      result[field] += chunk.length
      done(null, chunk)
    }
  })
  try {
    await gate.run(args, async () => {
      if (!current()) { cancel(); return }
      result.dispatched = true // conservatively includes an exec whose open acknowledgement is lost
      channel = await open([...args], current)
      const physicalClose = channel.closed.then(code => { closed = true; result.code = code })
      // Pending opens retain the permit even when cancellation arrived before a channel existed.
      if (!current()) { channel.cancel(); await physicalClose; return }
      inputLimit = limit('inputBytes', options.maxInputBytes)
      outputLimit = limit('outputBytes', options.maxOutputBytes)
      inputLimit.on('error', cancel); outputLimit.on('error', cancel)
      channel.stdout.on('error', cancel); channel.stdin.on('error', cancel)
      let stderrBytes = 0
      channel.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) cancel() })
      channel.stderr.on('error', cancel)
      const tasks: Promise<unknown>[] = []
      if (options.input) tasks.push(pipeline(options.input, inputLimit, channel.stdin))
      else channel.stdin.end()
      tasks.push(pipeline(channel.stdout, outputLimit))
      tasks.push(Promise.resolve().then(() => options.consume(outputLimit!)))
      // Attach all rejection handlers immediately; failures cancel pipes but never release custody.
      const io = tasks.map(task => task.catch(() => { cancel() }))
      await Promise.all([physicalClose, ...io])
      if (!current()) result.interrupted = true
    }, abort.signal)
  } catch { result.interrupted = true; if (channel && !closed) { channel.cancel(); await channel.closed } }
  finally {
    clearTimeout(timer); clearInterval(validity)
    options.signal.removeEventListener('abort', onAbort)
    options.input?.removeListener('error', cancel)
  }
  return result
}
