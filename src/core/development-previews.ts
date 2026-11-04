import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

/** Host-only proof, never accepted from a renderer. Identity includes listener birth/socket,
 * execution generation and (for SSH) the actual transport generation. */
export interface DevelopmentTarget {
  projectId: string
  nodeId: string
  generation: string
  processIdentity: string
  hostIdentity: string
  address: '127.0.0.1' | '::1'
  port: number
}
export interface DevelopmentPreviewAuthority {
  /** Fresh ownership discovery plus operator/owner approval; null also means unsupported. */
  resolve(owner: string, recordId: string): Promise<DevelopmentTarget | null>
}
interface Grant {
  owner: string
  recordId: string
  target: Readonly<DevelopmentTarget>
  expires: number
  connections: Set<() => void>
}
const same = (a: DevelopmentTarget, b: DevelopmentTarget): boolean =>
  (Object.keys(a) as (keyof DevelopmentTarget)[]).every(k => a[k] === b[k])

/** Disabled hosts do not construct this service. No scanner/forward is started here.
 * A fresh random hostname per grant gives every service lifetime its own storage origin. */
export class DevelopmentPreviews {
  private grants = new Map<string, Grant>()
  private stopped = false
  private pending = 0
  private issues = new Set<{ owner: string; cancelled: boolean }>()
  private timer: ReturnType<typeof setInterval>
  private readonly base: URL
  constructor(baseOrigin: string, readonly appOrigin: string,
    private authority: DevelopmentPreviewAuthority, private now = Date.now) {
    this.base = new URL(baseOrigin)
    const app = new URL(appOrigin)
    const hostname = this.base.hostname
    // URL.hostname silently ignores assignments such as '<token>.127.0.0.1'. Only
    // DNS labels can carry a grant subdomain; reserve 49 bytes for its random label.
    const dnsBase = !isIP(hostname.replace(/^\[|\]$/g, '')) && hostname.length <= 204 &&
      hostname.split('.').length >= 2 && hostname.split('.').every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    if (!dnsBase || this.base.origin !== baseOrigin || app.origin !== appOrigin ||
      this.base.protocol !== 'https:' || app.protocol !== 'https:' ||
      this.base.hostname === app.hostname || this.base.hostname.endsWith(`.${app.hostname}`) ||
      app.hostname.endsWith(`.${this.base.hostname}`)) throw new Error('preview origins must be separate HTTPS hostnames')
    this.timer = setInterval(() => this.sweep(), 1000)
    this.timer.unref()
  }
  private remove(host: string): void {
    const grant = this.grants.get(host)
    this.grants.delete(host)
    for (const close of grant?.connections ?? []) close()
  }
  private sweep(): void {
    for (const [host, grant] of this.grants) if (grant.expires <= this.now()) this.remove(host)
  }
  async issue(owner: string, recordId: string): Promise<string> {
    if (this.stopped || this.pending >= 8 || this.grants.size >= 32) throw new Error('preview unavailable or busy')
    this.pending++
    const issue = { owner, cancelled: false }
    this.issues.add(issue)
    try {
      const target = await this.authority.resolve(owner, recordId)
      if (!target || !target.generation || !target.processIdentity || !target.hostIdentity ||
        !['127.0.0.1', '::1'].includes(target.address) || !Number.isInteger(target.port) ||
        target.port < 1024 || target.port > 65535 || issue.cancelled || this.stopped || this.grants.size >= 32) throw new Error('preview target refused')
      const url = new URL(this.base)
      const hostname = `${randomBytes(24).toString('hex')}.${this.base.hostname}`
      url.hostname = hostname
      // Refuse even an astronomically unlikely collision: replacing a live entry
      // would orphan its connections and make an old reference address a new grant.
      if (url.hostname !== hostname || this.grants.has(url.host)) throw new Error('preview hostname unavailable')
      this.grants.set(url.host, { owner, recordId, target: Object.freeze({ ...target }), expires: this.now() + 300_000, connections: new Set() })
      return url.origin
    } finally { this.pending--; this.issues.delete(issue) }
  }
  /** Exact Host only; forwarded host headers are never authority. Reserve the entire vhost
   * suffix in the HTTP router so unknown/expired grants never fall through to app routes. */
  ownsHost(host: string): boolean {
    try {
      const url = new URL(`https://${host}`)
      return url.host === host && url.port === this.base.port && url.hostname.endsWith(`.${this.base.hostname}`)
    } catch { return false }
  }
  async acquire(host: string, close: () => void): Promise<Readonly<DevelopmentTarget> | null> {
    this.sweep()
    const grant = this.grants.get(host)
    if (this.stopped || !grant || this.pending >= 8 || grant.connections.size >= 32) return null
    this.pending++
    try {
      const fresh = await this.authority.resolve(grant.owner, grant.recordId)
      if (!fresh || !same(grant.target, fresh)) { this.remove(host); return null }
      if (this.stopped || this.grants.get(host) !== grant || grant.expires <= this.now() || grant.connections.size >= 32) return null
      grant.connections.add(close)
      return grant.target
    } catch { this.remove(host); return null } finally { this.pending-- }
  }
  release(host: string, close: () => void): void { this.grants.get(host)?.connections.delete(close) }
  revoke(owner: string, origin: string): void {
    try { const host = new URL(origin).host; if (this.grants.get(host)?.owner === owner) this.remove(host) } catch { /* invalid reference */ }
  }
  forgetOwner(owner: string): void {
    for (const issue of this.issues) if (issue.owner === owner) issue.cancelled = true
    for (const [host, grant] of this.grants) if (grant.owner === owner) this.remove(host)
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); for (const host of this.grants.keys()) this.remove(host) }
}
