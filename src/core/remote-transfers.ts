import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { AccountOwner } from './owner-lifetimes'
import type { BulkStreamOptions, BulkStreamResult } from './remote-ssh/ssh-bulk-stream'
import { transferFileCommand, transferCommitMarker, parseTransferStat, REMOTE_TRANSFER_MAX_BYTES, type TransferFileStat } from './remote-ssh/strict-file-transfer'
import type { RemoteTransferRequest, RemoteTransferPrepared, RemoteUploadOutcome } from '../shared/remote-transfers'
import { mediaMime } from '../shared/media'
import { matchesMediaSignature } from './media-references'

/** Opaque, host-only cookie-session principal. Never serialised or supplied by an RPC client. */
export interface TransferPrincipal { current(): boolean }
export interface TransferCaller { owner: AccountOwner; principal: TransferPrincipal }
export interface RemoteTransferSource {
  root: string
  relativePath: string
  path: string
  current(): boolean
  stream(command: string, options: BulkStreamOptions): Promise<BulkStreamResult>
}
interface Entry {
  reference: string; caller: TransferCaller; source: RemoteTransferSource
  kind: RemoteTransferRequest['kind']; bytes: number; expiresAt: number
  abort: AbortController; leave(): void; stat?: TransferFileStat
  consumed: boolean; active: number; outcome?: RemoteUploadOutcome
  mime?: string
}
export const TRANSFER_TTL_MS = 5 * 60_000
const MAX_REFERENCES = 64
const MAX_OWNER_REFERENCES = 16
const MAX_ACTIVE = 8
const MAX_OWNER_ACTIVE = 2

async function collect(output: Readable, cap: number): Promise<string> {
  let bytes = 0; const chunks: Buffer[] = []
  for await (const value of output) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > cap) throw new Error('remote-transfer-reply-limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Consumes only a bounded protocol header and preserves streaming/backpressure for the body. */
async function readHeader(output: Readable): Promise<{ header: unknown; body: Readable }> {
  const iterator = output[Symbol.asyncIterator]()
  let prefix = Buffer.alloc(0)
  for (;;) {
    const item = await iterator.next()
    if (item.done) throw new Error('remote-transfer-missing-header')
    const chunk = Buffer.from(item.value)
    const newline = chunk.indexOf(10)
    if (prefix.length + (newline < 0 ? chunk.length : newline) > 32768) throw new Error('remote-transfer-header-limit')
    if (newline < 0) { prefix = Buffer.concat([prefix, chunk]); continue }
    const header: unknown = JSON.parse(Buffer.concat([prefix, chunk.subarray(0, newline)]).toString())
    const remainder = chunk.subarray(newline + 1)
    const body = Readable.from((async function* () {
      try {
        if (remainder.length) yield remainder
        for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value }
      } finally { await iterator.return?.() }
    })(), { objectMode: false, highWaterMark: 64 * 1024 })
    return { header, body }
  }
}

/** References grant only captured remote IO, never connect, local filesystem or caller paths. */
export class RemoteTransfers {
  private entries = new Map<string, Entry>()
  private operations = new Set<Entry>()
  private active = 0
  private stopped = false
  private timer?: ReturnType<typeof setInterval>
  constructor(private capture: (request: RemoteTransferRequest) => RemoteTransferSource | null,
    private now: () => number = Date.now) {
    // No timer or SSH work until the first explicit request.
  }
  private current(entry: Entry): boolean {
    if (entry.abort.signal.aborted) return false
    try {
      if (!this.stopped && this.now() < entry.expiresAt && entry.caller.owner.active() &&
        entry.caller.principal.current() && entry.source.current()) return true
    } catch { /* A rejected authority cannot revive when fields later happen to match. */ }
    entry.abort.abort()
    return false
  }
  private sweep(): void { for (const entry of this.entries.values()) if (!this.current(entry)) this.drop(entry) }
  private drop(entry: Entry): void {
    entry.abort.abort(); entry.leave(); this.entries.delete(entry.reference)
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    // Active custody stays in operations until the actual transport closes.
  }
  private find(reference: string, principal: TransferPrincipal, owner?: AccountOwner): Entry | undefined {
    const entry = this.entries.get(reference)
    if (!entry || entry.caller.principal !== principal || owner && entry.caller.owner !== owner) return undefined
    if (!this.current(entry)) { this.drop(entry); return undefined }
    return entry
  }
  private async work<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
    const ownerActive = [...this.operations].filter(item => item.caller.owner === entry.caller.owner).reduce((n, item) => n + item.active, 0)
    if (!this.current(entry) || this.active >= MAX_ACTIVE || ownerActive >= MAX_OWNER_ACTIVE) throw new Error('remote-transfer-busy')
    this.active++; entry.active++; this.operations.add(entry)
    try { return await operation() }
    finally { this.active--; entry.active--; if (!entry.active) this.operations.delete(entry) }
  }
  private options(entry: Entry, consume: BulkStreamOptions['consume'], input?: Readable): BulkStreamOptions {
    return { current: () => this.current(entry), signal: entry.abort.signal, input,
      maxInputBytes: input ? entry.bytes : 0, maxOutputBytes: 32768,
      timeoutMs: Math.max(1, Math.min(120_000, entry.expiresAt - this.now())), consume }
  }
  private async metadata(entry: Entry): Promise<TransferFileStat> {
    let reply = ''
    const result = await entry.source.stream(transferFileCommand({root: entry.source.root, relativePath: entry.source.relativePath, operation: 'stat'}),
      this.options(entry, async output => { reply = await collect(output, 32768) }))
    if (result.code !== 0 || result.interrupted || !this.current(entry)) throw new Error('remote-transfer-unavailable')
    return parseTransferStat(reply)
  }
  private async mediaType(entry: Entry): Promise<string | undefined> {
    let bytes = Buffer.alloc(0)
    const length = Math.min(64, entry.stat!.size)
    const options = this.options(entry, async output => {
      const {header, body} = await readHeader(output)
      const h = header as {ok?: unknown; bytes?: unknown; identity?: unknown}
      if (h?.ok !== true || h.bytes !== length || JSON.stringify(h.identity) !== JSON.stringify(entry.stat!.identity)) {
        body.destroy(); throw new Error('remote-transfer-invalid-media')
      }
      const chunks: Buffer[] = []; let total = 0
      for await (const chunk of body) { total += chunk.length; if (total > 64) throw new Error('remote-transfer-invalid-media'); chunks.push(chunk) }
      bytes = Buffer.concat(chunks)
    })
    options.maxOutputBytes += 64
    const result = await entry.source.stream(transferFileCommand({root: entry.source.root, relativePath: entry.source.relativePath,
      operation: 'read', identity: entry.stat!.identity, offset: 0, length}), options)
    if (result.code !== 0 || result.interrupted || !this.current(entry)) return undefined
    const mime = mediaMime(entry.source.relativePath)
    if (mime) return matchesMediaSignature(mime, bytes) ? mime : undefined
    const ext = entry.source.relativePath.split('.').at(-1)?.toLowerCase()
    if (ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
    if (['jpg', 'jpeg'].includes(ext ?? '') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
    if (ext === 'gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (ext === 'webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
    return undefined
  }
  async prepare(caller: TransferCaller, request: RemoteTransferRequest): Promise<RemoteTransferPrepared> {
    this.sweep()
    if (!request || typeof request !== 'object' || !['upload', 'download', 'media'].includes(request.kind) ||
      typeof request.projectId !== 'string' || request.projectId.length > 256 || typeof request.relativePath !== 'string' ||
      request.relativePath.length > 4096 || (request.nodeId !== undefined && (typeof request.nodeId !== 'string' || request.nodeId.length > 256)) ||
      (request.kind === 'upload' && (!Number.isSafeInteger(request.bytes) || request.bytes! < 0 || request.bytes! > REMOTE_TRANSFER_MAX_BYTES))) return {status: 'unavailable'}
    if (this.entries.size >= MAX_REFERENCES || [...this.entries.values()].filter(e => e.caller.owner === caller.owner).length >= MAX_OWNER_REFERENCES) return {status: 'busy'}
    let source: RemoteTransferSource | null
    try { source = this.capture({...request}) } catch { return {status: 'unavailable'} }
    if (!source) return {status: 'unavailable'}
    const entry: Entry = {reference: randomBytes(16).toString('hex'), caller, source, kind: request.kind,
      bytes: request.bytes ?? 0, expiresAt: this.now() + TRANSFER_TTL_MS, abort: new AbortController(),
      leave: () => {}, consumed: false, active: 0}
    if (!this.current(entry)) return {status: 'unavailable'}
    this.entries.set(entry.reference, entry)
    if (!this.timer) { this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref?.() }
    entry.leave = caller.owner.onDeparture(() => this.drop(entry))
    try {
      entry.stat = await this.work(entry, () => this.metadata(entry))
      if (entry.kind === 'upload' ? entry.stat.identity.file !== null : entry.stat.identity.file === null) {
        this.drop(entry); return {status: entry.kind === 'upload' ? 'conflict' : 'unavailable'}
      }
      if (!this.current(entry)) throw new Error('remote-transfer-expired')
      if (entry.kind !== 'upload') entry.bytes = entry.stat.size
      if (entry.kind === 'media') {
        entry.mime = await this.work(entry, () => this.mediaType(entry))
        if (!entry.mime || !this.current(entry)) throw new Error('remote-transfer-invalid-media')
      }
      return {status: 'ready', reference: entry.reference, url: '/ssh-transfer?ref=' + entry.reference, bytes: entry.bytes, expiresAt: entry.expiresAt}
    } catch { this.drop(entry); return {status: 'unavailable'} }
  }
  info(reference: string, principal: TransferPrincipal): {kind: Entry['kind']; bytes: number; name: string; mime?: string} | null {
    const entry = this.find(reference, principal)
    return entry?.stat && !(entry.kind === 'download' && entry.consumed) ? {kind: entry.kind, bytes: entry.bytes, name: entry.source.relativePath.split('/').at(-1)!, mime: entry.mime} : null
  }
  async download(reference: string, principal: TransferPrincipal, offset: number, length: number,
    consume: (body: Readable, current: () => boolean) => Promise<void>, signal: AbortSignal): Promise<boolean> {
    const entry = this.find(reference, principal)
    if (!entry?.stat || entry.kind === 'upload' || entry.consumed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > entry.bytes) return false
    if (entry.kind === 'download') entry.consumed = true
    try {
      return await this.work(entry, async () => {
        let published = false
        const options = this.options(entry, async output => {
          const {header, body} = await readHeader(output)
          const h = header as {ok?: unknown; bytes?: unknown; identity?: unknown}
          if (!this.current(entry) || h?.ok !== true || h.bytes !== length || JSON.stringify(h.identity) !== JSON.stringify(entry.stat!.identity)) {
            this.drop(entry); body.destroy(); throw new Error('remote-transfer-stale-read')
          }
          published = true
          await consume(body, () => this.current(entry))
        })
        options.signal = AbortSignal.any([signal, options.signal]); options.maxOutputBytes = length + 32768
        const result = await entry.source.stream(transferFileCommand({root: entry.source.root, relativePath: entry.source.relativePath,
          operation: 'read', identity: entry.stat!.identity, offset, length}), options)
        const ok = published && result.code === 0 && !result.interrupted && this.current(entry)
        // A failed read proof/protocol needs fresh preparation. Only a caller's ordinary
        // cancellation may keep a media reference; it cannot undo a latched source failure.
        if (!ok && !signal.aborted) this.drop(entry)
        return ok
      })
    } catch { return false }
    finally { if (entry.kind === 'download') this.drop(entry) }
  }
  private outcome(entry: Entry, reply: string): RemoteUploadOutcome {
    if (reply.length > 4096) return {outcome: 'unknown'}
    try {
      const value = JSON.parse(reply)
      if (value.outcome === 'committed' && value.bytes === entry.bytes && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256))
        return {outcome: 'committed', bytes: entry.bytes, sha256: value.sha256, path: entry.source.path}
      if (['conflict', 'not-written', 'unavailable', 'unknown'].includes(value.outcome)) return {outcome: value.outcome}
    } catch { /* transport interruption is not evidence of no write */ }
    return {outcome: 'unknown'}
  }
  async upload(reference: string, principal: TransferPrincipal, input: Readable, signal: AbortSignal): Promise<RemoteUploadOutcome> {
    const entry = this.find(reference, principal)
    if (!entry?.stat || entry.kind !== 'upload' || entry.consumed) return {outcome: 'unavailable'}
    entry.consumed = true; entry.outcome = {outcome: 'unknown'}
    try {
      return await this.work(entry, async () => {
        let reply = ''
        const marker = transferCommitMarker(entry.reference)
        const current = () => this.current(entry) && !signal.aborted
        const committedInput = Readable.from((async function* () {
          for await (const chunk of input) yield chunk
          if (!current()) throw new Error('remote-transfer-expired-before-commit')
          yield marker
        })(), {objectMode: false, highWaterMark: 64 * 1024})
        const options = this.options(entry, async output => { reply = await collect(output, 4096) }, committedInput)
        options.maxInputBytes = entry.bytes + marker.length
        options.signal = AbortSignal.any([options.signal, signal])
        const result = await entry.source.stream(transferFileCommand({root: entry.source.root, relativePath: entry.source.relativePath,
          operation: 'create', bytes: entry.bytes, identity: entry.stat!.identity, nonce: entry.reference}), options)
        const outcome = result.code === 0 && !result.interrupted ? this.outcome(entry, reply) :
          {outcome: result.dispatched ? 'unknown' : 'not-written'} as RemoteUploadOutcome
        entry.outcome = outcome
        return this.current(entry) ? outcome : {outcome: 'unknown'}
      })
    } catch { return {outcome: 'unknown'} }
  }
  async status(caller: TransferCaller, reference: string): Promise<RemoteUploadOutcome> {
    const entry = this.find(reference, caller.principal, caller.owner)
    if (!entry?.stat || entry.kind !== 'upload' || !entry.consumed || entry.active) return {outcome: 'unknown'}
    if (entry.outcome?.outcome !== 'unknown') return entry.outcome ?? {outcome: 'unknown'}
    try {
      return await this.work(entry, async () => {
        let reply = ''
        const result = await entry.source.stream(transferFileCommand({root: entry.source.root, relativePath: entry.source.relativePath,
          operation: 'receipt', identity: entry.stat!.identity, nonce: entry.reference}), this.options(entry, async output => { reply = await collect(output, 4096) }))
        if (result.code === 0 && !result.interrupted && this.current(entry)) entry.outcome = this.outcome(entry, reply)
        return this.current(entry) ? entry.outcome ?? {outcome: 'unknown'} : {outcome: 'unknown'}
      })
    } catch { return {outcome: 'unknown'} }
  }
  release(caller: TransferCaller, reference: string): void { const entry = this.find(reference, caller.principal, caller.owner); if (entry) this.drop(entry) }
  renew(caller: TransferCaller, reference: string): boolean {
    const entry = this.find(reference, caller.principal, caller.owner)
    if (!entry || entry.kind !== 'media') return false
    entry.expiresAt = this.now() + TRANSFER_TTL_MS
    return true
  }
  dispose(): void { this.stopped = true; clearInterval(this.timer); for (const entry of [...this.entries.values()]) this.drop(entry) }
}
