import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mediaMime, type MediaScope } from '../shared/media'

interface MediaReference {
  clientId: number
  scope: MediaScope
  path: string
  realPath: string
  dev: number
  ino: number
  mime: string
  expiresAt: number
  streams: Set<() => void>
}

/** Signature check prevents serving arbitrary text/active content under a media extension. */
export function matchesMediaSignature(mime: string, bytes: Buffer): boolean {
  const text = (at: number, value: string) => bytes.subarray(at, at + value.length).toString('ascii') === value
  switch (mime) {
    case 'video/mp4': case 'audio/mp4': return text(4, 'ftyp')
    case 'video/quicktime': return ['ftyp', 'moov', 'mdat', 'wide'].some((tag) => text(4, tag))
    case 'video/webm': case 'audio/webm': case 'video/x-matroska':
      return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3
    case 'audio/ogg': case 'video/ogg': return text(0, 'OggS')
    case 'audio/flac': return text(0, 'fLaC')
    case 'audio/wav': return text(0, 'RIFF') && text(8, 'WAVE')
    case 'video/x-msvideo': return text(0, 'RIFF') && text(8, 'AVI ')
    case 'audio/aiff': return text(0, 'FORM') && (text(8, 'AIFF') || text(8, 'AIFC'))
    case 'audio/mpeg': return text(0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    case 'audio/aac': return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0
    default: return false
  }
}

/** Reusable, expiring references. HTTP authorization remains a separate, mandatory gate. */
export class MediaReferences {
  private entries = new Map<string, MediaReference>()
  private timer: ReturnType<typeof setInterval>
  private stopped = false
  private active = 0
  private opening = 0
  private issuing = 0
  private ttl: number
  private now: () => number

  constructor(private readonly deps: {
    authorize(scope: MediaScope, file: string): Promise<boolean>
    ttlMs?: number
    now?: () => number
  }) {
    this.ttl = deps.ttlMs ?? 5 * 60_000
    this.now = deps.now ?? Date.now
    this.timer = setInterval(() => this.sweep(), Math.min(this.ttl, 15_000))
    this.timer.unref()
  }

  private valid(token: string): MediaReference | null {
    const entry = this.entries.get(token)
    if (!entry) return null
    if (this.stopped || entry.expiresAt <= this.now()) { this.revoke(token); return null }
    return entry
  }

  private revoke(token: string): void {
    const entry = this.entries.get(token)
    this.entries.delete(token)
    for (const abort of [...(entry?.streams ?? [])]) { try { abort() } catch { /* continue revoking other streams */ } }
  }

  private sweep(): void { for (const token of this.entries.keys()) this.valid(token) }

  async issue(clientId: number, scope: MediaScope, file: string): Promise<string> {
    if (this.issuing >= 32) throw new Error('media-busy: too many pending reference requests')
    this.issuing++
    try { return await this.issueChecked(clientId, scope, file) } finally { this.issuing-- }
  }

  private async issueChecked(clientId: number, scope: MediaScope, file: string): Promise<string> {
    this.sweep()
    const mime = mediaMime(file)
    if (!mime || this.stopped || !(await this.deps.authorize(scope, file))) throw new Error('media-refused: unavailable local media node')
    const link = await fs.promises.lstat(file)
    if (!link.isFile() || link.isSymbolicLink()) throw new Error('media-refused: requires a regular media file')
    const realPath = await fs.promises.realpath(file)
    const handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      const bytes = Buffer.alloc(32)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (!stat.isFile() || stat.dev !== link.dev || stat.ino !== link.ino || !Number.isSafeInteger(stat.size) || !matchesMediaSignature(mime, bytes.subarray(0, bytesRead))) {
        throw new Error('media-refused: file format does not match its media type')
      }
      // Recheck after I/O: a removed node must not acquire a new reference.
      if (this.stopped || !(await this.deps.authorize(scope, file))) throw new Error('media-refused: node access changed')
      if (this.stopped) throw new Error('media-refused: service stopped')
      while (this.entries.size >= 256) this.revoke(this.entries.keys().next().value!)
      const owned = [...this.entries].filter(([, entry]) => entry.clientId === clientId)
      while (owned.length >= 64) this.revoke(owned.shift()![0])
      const token = randomBytes(24).toString('base64url')
      this.entries.set(token, { clientId, scope: { ...scope }, path: file, realPath, dev: stat.dev, ino: stat.ino,
        mime, expiresAt: this.now() + this.ttl, streams: new Set() })
      return token
    } finally { await handle.close() }
  }

  async renew(clientId: number, token: string): Promise<boolean> {
    const entry = this.valid(token)
    if (!entry || entry.clientId !== clientId) return false
    if (!(await this.deps.authorize(entry.scope, entry.path))) { this.revoke(token); return false }
    if (this.valid(token) !== entry) return false
    entry.expiresAt = this.now() + this.ttl
    return true
  }

  release(clientId: number, token: string): void {
    if (this.entries.get(token)?.clientId === clientId) this.revoke(token)
  }

  forgetClient(clientId: number): void {
    for (const [token, entry] of this.entries) if (entry.clientId === clientId) this.revoke(token)
  }

  async open(token: string): Promise<{
    handle: FileHandle; size: number; mime: string
    attach(abort: () => void): (() => void) | null
  } | null> {
    const entry = this.valid(token)
    if (!entry || this.active + this.opening >= 64) return null
    this.opening++
    let handle: FileHandle | undefined
    try {
      if (!(await this.deps.authorize(entry.scope, entry.path)) || await fs.promises.realpath(entry.path) !== entry.realPath) {
        this.revoke(token); return null
      }
      handle = await fs.promises.open(entry.realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || this.valid(token) !== entry) {
        await handle.close(); this.revoke(token); return null
      }
      return { handle, size: stat.size, mime: entry.mime, attach: (abort) => {
        if (this.valid(token) !== entry || this.active >= 64 || entry.streams.size >= 8) return null
        this.active++; entry.streams.add(abort)
        let released = false
        return () => { if (released) return; released = true; this.active--; entry.streams.delete(abort) }
      } }
    } catch { await handle?.close().catch(() => {}); this.revoke(token); return null }
    finally { this.opening-- }
  }

  dispose(): void {
    this.stopped = true; clearInterval(this.timer)
    for (const token of [...this.entries.keys()]) this.revoke(token)
  }
}
