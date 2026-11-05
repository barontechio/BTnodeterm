import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import webpush from 'web-push'
import { writeFileDurableAtomic } from './fs-atomic'
import { parseSubscription, type VapidKeys, type WebSubscription } from './web-push-transport'
import type { InboxEvent } from './agent-status-mirror'

export interface WebPushTarget { projectId: string; nodeId: string; sessionId: string }
interface Grant { id: string; owner: string; projectId: string; createdAt: number; expiresAt: number; subscription: WebSubscription }
interface Attempt { id: string; grantId: string; eventId: string; at: number; target: WebPushTarget }
interface State { v: 1; vapid: VapidKeys; grants: Grant[]; attempts: Attempt[] }
export interface WebPushDeps {
  file: string; providers: readonly string[]; ownerCurrent(owner: string): boolean;
  projectCurrent(projectId: string): boolean;
  target(nodeId: string): WebPushTarget | null;
  eventCurrent(event: InboxEvent): boolean;
  send(subscription: WebSubscription, payload: string, keys: VapidKeys, current: () => boolean, signal: AbortSignal): Promise<number>;
  now?: () => number
}
const GRANT_TTL = 30 * 24 * 60 * 60_000
const EVENT_TTL = 120_000
const NOTICE_TTL = 24 * 60 * 60_000
const MAX_GRANTS = 32
const MAX_ATTEMPTS = 1024
const OWNER = /^[a-f0-9]{64}$/
export const webPushId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)

/** This store belongs to authenticated cookie sessions, NOT WS/document lifetimes. A page going
 * away must retain consent; logout/expiry kills it. Write-ahead attempts trade possible loss on
 * crash for no automatic replay of an unknown network effect. One process owns the data dir. */
export class WebPushService {
  private state!: State
  private queue: Promise<unknown> = Promise.resolve()
  private queued = 0
  private stopped = false
  private faulted = false
  private inFlight = new Set<AbortController>()
  private jobs = new Set<Promise<unknown>>()
  private now: () => number
  constructor(private deps: WebPushDeps) { this.now = deps.now ?? Date.now }
  async init(): Promise<void> {
    try {
      const f = await fs.open(this.deps.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let raw: unknown
      try {
        const stat = await f.stat()
        if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077)) throw new Error('Unsafe Web Push store')
        raw = JSON.parse(await f.readFile('utf8'))
      } finally { await f.close() }
      const s = raw as State
      if (s.v !== 1 || !Array.isArray(s.grants) || s.grants.length > MAX_GRANTS || !Array.isArray(s.attempts) || s.attempts.length > MAX_ATTEMPTS) throw new Error('Invalid Web Push store')
      // Library validates the VAPID curve keys before any capability is advertised.
      webpush.getVapidHeaders('https://example.com', 'mailto:test@example.com', s.vapid.publicKey, s.vapid.privateKey, 'aes128gcm')
      const pub = Buffer.from(s.vapid.publicKey, 'base64url')
      const ecdh = (await import('node:crypto')).createECDH('prime256v1')
      ecdh.setPrivateKey(Buffer.from(s.vapid.privateKey, 'base64url'))
      if (!ecdh.getPublicKey().equals(pub)) throw new Error('Mismatched Web Push keys')
      for (const g of s.grants) {
        if (!webPushId(g.id) || !OWNER.test(g.owner) || !webPushId(g.projectId) || !Number.isFinite(g.createdAt) || !Number.isFinite(g.expiresAt) || g.expiresAt > g.createdAt + GRANT_TTL) throw new Error('Invalid grant')
        g.subscription = parseSubscription(g.subscription, this.deps.providers)
      }
      for (const a of s.attempts) if (!webPushId(a.id) || !webPushId(a.grantId) || typeof a.eventId !== 'string' || a.eventId.length > 200 || !Number.isFinite(a.at) || !webPushId(a.target?.projectId) || !webPushId(a.target?.nodeId) || !webPushId(a.target?.sessionId)) throw new Error('Invalid attempt')
      this.state = s
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.state = { v: 1, vapid: webpush.generateVAPIDKeys(), grants: [], attempts: [] }
      await this.persist(this.state)
    }
    await this.sweep()
  }
  get available(): boolean { return !this.stopped && !this.faulted }
  get publicKey(): string { return this.state.vapid.publicKey }
  private live(g: Grant): boolean { return !this.stopped && !this.faulted && g.expiresAt > this.now() && this.deps.ownerCurrent(g.owner) && this.deps.projectCurrent(g.projectId) }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped || this.faulted || this.queued >= 64) return Promise.reject(new Error('Web Push unavailable'))
    this.queued++
    const result = this.queue.then(fn)
    this.queue = result.catch(() => {})
    return result.finally(() => { this.queued-- })
  }
  private async persist(next: State, check?: () => void): Promise<void> {
    try {
      await writeFileDurableAtomic(this.deps.file, JSON.stringify(next), { mode: 0o600, assertDispatch: check })
      this.state = next
    } catch (e) {
      // A post-rename acknowledgement may fail. Never continue from an uncertain cache.
      this.faulted = true
      for (const c of this.inFlight) c.abort()
      throw e
    }
  }
  async subscribe(owner: string, projectId: string, raw: unknown, current: () => boolean): Promise<void> {
    if (!OWNER.test(owner) || !webPushId(projectId)) throw new Error('Invalid owner or scope')
    const subscription = parseSubscription(raw, this.deps.providers)
    await this.mutate(async () => {
      const check = (): void => { if (!current() || !this.deps.ownerCurrent(owner) || !this.deps.projectCurrent(projectId)) throw new Error('Consent revoked') }
      check()
      const grants = this.state.grants.filter(g => this.live(g))
      const existing = grants.find(g => g.subscription.endpoint === subscription.endpoint)
      if (existing && existing.owner !== owner) throw new Error('Subscription belongs to another session')
      const remaining = grants.filter(g => g !== existing)
      if (remaining.length >= MAX_GRANTS || remaining.filter(g => g.owner === owner).length >= 8) throw new Error('Too many subscriptions')
      const at = this.now()
      const grant: Grant = { id: randomUUID(), owner, projectId, createdAt: at, expiresAt: at + GRANT_TTL, subscription }
      await this.persist({ ...this.state, grants: [...remaining, grant] }, check)
      check()
    })
  }
  status(owner: string, endpoint: unknown): { enabled: boolean; projectId?: string; expiresAt?: number } {
    const g = this.state.grants.find(g => g.owner === owner && g.subscription.endpoint === endpoint && this.live(g))
    return g ? { enabled: true, projectId: g.projectId, expiresAt: g.expiresAt } : { enabled: false }
  }
  async unsubscribe(owner: string, endpoint: unknown): Promise<void> {
    for (const c of this.inFlight) c.abort()
    await this.mutate(async () => {
      await this.persist({ ...this.state, grants: this.state.grants.filter(g => g.owner !== owner || g.subscription.endpoint !== endpoint) })
    })
    // current() also checks the exact grant revision before any later dispatch.
  }
  async sweep(): Promise<void> {
    for (const c of this.inFlight) c.abort()
    await this.mutate(async () => {
      const grants = this.state.grants.filter(g => this.live(g))
      const attempts = this.state.attempts.filter(a => a.at > this.now() - NOTICE_TTL && grants.some(g => g.id === a.grantId))
      if (grants.length !== this.state.grants.length || attempts.length !== this.state.attempts.length) await this.persist({ ...this.state, grants, attempts })
    })
  }
  resolve(owner: string, noticeId: string): WebPushTarget | null {
    const a = this.state.attempts.find(a => a.id === noticeId)
    const g = a && this.state.grants.find(g => g.id === a.grantId && g.owner === owner && this.live(g))
    if (!a || !g || a.at < this.now() - NOTICE_TTL) return null
    const t = this.deps.target(a.target.nodeId)
    return t && t.projectId === a.target.projectId && t.sessionId === a.target.sessionId ? { ...t } : null
  }
  /** Called by the real mirror's post-normalization/post-dedup actionable event seam. */
  accept(event: InboxEvent): void {
    if (this.stopped || this.faulted || this.jobs.size >= 32 || event.interrupted || event.resolved || !event.sessionId || !webPushId(event.sessionId) || event.ts < this.now() - EVENT_TTL || event.ts > this.now() + 1000) return
    const job = this.dispatch({ ...event }).catch(() => {})
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job))
  }
  private async dispatch(event: InboxEvent): Promise<void> {
    const target = this.deps.target(event.nodeId)
    if (!target || target.sessionId !== event.sessionId) return
    // Bounded fanout, no queue behind the 4 actual network slots. Dropping is explicit best effort.
    for (const g of [...this.state.grants]) {
      if (this.inFlight.size >= 4) break
      if (!this.live(g) || g.projectId !== target.projectId) continue
      const current = (): boolean => this.live(g) && this.state.grants.includes(g) && this.deps.eventCurrent(event) &&
        event.ts >= this.now() - EVENT_TTL && JSON.stringify(this.deps.target(event.nodeId)) === JSON.stringify(target)
      const a = await this.mutate(async () => {
        if (!current()) return null
        const attempts = this.state.attempts.filter(a => a.at > this.now() - NOTICE_TTL)
        if (attempts.length >= MAX_ATTEMPTS || attempts.some(a => a.grantId === g.id && a.eventId === event.id)) return null
        const a: Attempt = { id: randomUUID(), eventId: event.id, grantId: g.id, at: this.now(), target }
        await this.persist({ ...this.state, attempts: [...attempts, a] })
        return a
      })
      if (!a || !current() || this.inFlight.size >= 4) continue
      const controller = new AbortController()
      this.inFlight.add(controller)
      try {
        const status = await this.deps.send(g.subscription, JSON.stringify({ v: 1, noticeId: a.id, kind: event.kind }), this.state.vapid, current, controller.signal)
        if ((status === 404 || status === 410) && this.state.grants.includes(g)) {
          await this.mutate(async () => {
            if (this.state.grants.includes(g)) await this.persist({ ...this.state, grants: this.state.grants.filter(row => row !== g) })
          })
        }
      } catch { /* No retry: a lost response can follow successful provider acceptance. */ }
      finally { this.inFlight.delete(controller) }
    }
  }
  async idle(): Promise<void> { await Promise.all([...this.jobs]); await this.queue }
  async close(): Promise<void> { this.stopped = true; for (const c of this.inFlight) c.abort(); await this.idle() }
}
