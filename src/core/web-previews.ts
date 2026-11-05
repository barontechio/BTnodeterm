import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { MediaScope } from '../shared/media'
import { WEB_PREVIEW_MAX_BYTES } from '../shared/web-preview'
import type { WorkspaceStore } from './workspace-store'

interface Preview {
  scope: MediaScope
  file: string
  bytes: Buffer
  clientId: number
  expiresAt: number
}

/** Immutable, self-contained HTML snapshots. The shell serves them only on its isolated origin. */
export class WebPreviews {
  private entries = new Map<string, Preview>()
  private bytes = 0
  private stopped = false
  private issuing = 0
  private reading = 0
  private queuedWrites = 0
  private writes: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval>

  constructor(readonly origin: string, readonly appOrigin: string, private readonly workspace: WorkspaceStore,
    private readonly userDataDir: string) {
    const preview = new URL(origin); const app = new URL(appOrigin)
    if (preview.protocol !== 'https:' || app.protocol !== 'https:' || preview.hostname === app.hostname ||
      preview.origin !== origin || app.origin !== appOrigin) throw new Error('HTML previews require distinct normalized HTTPS origins and hostnames')
    this.timer = setInterval(() => this.sweep(), 15_000); this.timer.unref()
  }

  private remove(token: string): void {
    const entry = this.entries.get(token)
    if (entry) this.bytes -= entry.bytes.length
    this.entries.delete(token)
  }
  private sweep(): void { for (const [token, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.remove(token) }
  private async savedFile(scope: MediaScope): Promise<string | null> {
    const current = await this.workspace.load({ sideline: false })
    const matches = current.projects.flatMap((project) => project.nodes.filter((node) => node.id === scope.nodeId).map((node) => ({ project, node })))
    if (matches.length !== 1) return null
    const { project, node } = matches[0]
    return project.id === scope.projectId && !project.ssh && !project.unavailable && !node.sshFs && !node.ssh &&
      !node.sshRemoteTmux && node.kind === 'web' && node.filePath && path.isAbsolute(node.filePath) ? node.filePath : null
  }

  /** Bounded read from a checked regular descriptor; never read an entire growing file. */
  async readHtml(file: string): Promise<Buffer> {
    if (!['.html', '.htm'].includes(path.extname(file).toLowerCase())) throw new Error('preview requires an HTML file')
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > WEB_PREVIEW_MAX_BYTES) throw new Error('HTML preview exceeds the 1 MiB limit or is not a regular file')
      const bytes = Buffer.alloc(WEB_PREVIEW_MAX_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!part.bytesRead) break
        offset += part.bytesRead
      }
      if (offset > WEB_PREVIEW_MAX_BYTES) throw new Error('HTML preview exceeds the 1 MiB limit')
      return Buffer.from(bytes.subarray(0, offset))
    } finally { await handle.close() }
  }

  /** Content-addressed files survive restart; unused staging files age out on the next write. */
  writeHtml(html: string): Promise<string> {
    if (typeof html !== 'string' || Buffer.byteLength(html) > WEB_PREVIEW_MAX_BYTES || this.stopped || this.queuedWrites >= 16) return Promise.reject(new Error('HTML preview is unavailable, busy or exceeds the 1 MiB limit'))
    this.queuedWrites++
    const task = this.writes.then(async () => {
      if (this.stopped) throw new Error('preview service stopped')
      const root = path.join(this.userDataDir, 'web-previews')
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      const used = new Set((await this.workspace.load({ sideline: false })).projects.flatMap((p) => p.nodes.map((n) => n.filePath)))
      let count = 0
      for (const name of await fs.readdir(root)) {
        if (!/^[a-f0-9]{64}\.html$/.test(name)) continue
        const file = path.join(root, name)
        const stat = await fs.lstat(file)
        if (!used.has(file) && Date.now() - stat.mtimeMs > 10 * 60_000) await fs.unlink(file)
        else count++
      }
      const file = path.join(root, `${createHash('sha256').update(html).digest('hex')}.html`)
      if (this.stopped) throw new Error('preview service stopped')
      try {
        if (count >= 256) { await fs.access(file); return file }
        await fs.writeFile(file, html, { flag: 'wx', mode: 0o600 })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      return file
    })
    this.writes = task.catch(() => {})
    return task.finally(() => { this.queuedWrites-- })
  }

  async issue(clientId: number, scope: MediaScope): Promise<string> {
    if (this.stopped || this.issuing >= 16) throw new Error('preview unavailable or busy')
    this.issuing++
    try {
      const file = await this.savedFile(scope)
      if (!file) throw new Error('preview requires a saved local web node')
      const bytes = await this.readHtml(file)
      if (this.stopped || await this.savedFile(scope) !== file) throw new Error('preview access changed')
      if (this.stopped) throw new Error('preview service stopped')
      this.sweep()
      while (this.entries.size >= 64 || this.bytes + bytes.length > 16 * WEB_PREVIEW_MAX_BYTES) this.remove(this.entries.keys().next().value!)
      const token = randomBytes(24).toString('base64url')
      this.entries.set(token, { scope: { ...scope }, file, bytes, clientId, expiresAt: Date.now() + 5 * 60_000 })
      this.bytes += bytes.length
      return `${this.origin}/web-preview?ref=${token}`
    } finally { this.issuing-- }
  }

  async renew(clientId: number, token: string): Promise<boolean> {
    this.sweep()
    const entry = this.entries.get(token)
    if (this.stopped || !entry || entry.clientId !== clientId) return false
    if (await this.savedFile(entry.scope) !== entry.file) { this.remove(token); return false }
    if (this.stopped || this.entries.get(token) !== entry) return false
    entry.expiresAt = Date.now() + 5 * 60_000
    return true
  }

  release(clientId: number, token: string): void { if (this.entries.get(token)?.clientId === clientId) this.remove(token) }
  forgetClient(clientId: number): void { for (const [token, entry] of this.entries) if (entry.clientId === clientId) this.remove(token) }

  async open(token: string): Promise<{ bytes: Buffer; release(): void } | null> {
    this.sweep()
    const entry = this.entries.get(token)
    if (this.stopped || !entry || this.reading >= 16) return null
    this.reading++
    let returned = false
    try {
      if (await this.savedFile(entry.scope) !== entry.file) { this.remove(token); return null }
      if (this.stopped || this.entries.get(token) !== entry) return null
      returned = true
      let released = false
      return { bytes: entry.bytes, release: () => { if (!released) { released = true; this.reading-- } } }
    } finally { if (!returned) this.reading-- }
  }

  dispose(): void { this.stopped = true; clearInterval(this.timer); this.entries.clear(); this.bytes = 0 }
}
