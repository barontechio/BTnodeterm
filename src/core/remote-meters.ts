import { randomUUID } from 'node:crypto'
import type { AccountOwner } from './owner-lifetimes'
import type { ContextWindowUsage } from '../shared/types'
import type { RemoteMeterStart, RemoteMeterUpdate } from '../shared/remote-meters'
import { parseLatestUsage } from './context-tail'
import { codexContextParse } from './codex-session'
import { cachedWindowFor } from './model-window'

export const REMOTE_METER_TTL = 15_000
const POLL_MS = 2_000
const MAX_LEASES = 128
const MAX_OWNER_LEASES = 32
const MAX_READS = 4
export const REMOTE_METER_BYTES = 1024 * 1024

/** Private captured authority. `current` never refreshes/rebinds it. */
export interface RemoteMeterSource {
  key: string
  nodeId: string
  sessionId: string
  harness: 'claude' | 'codex'
  current(): boolean
  read(owner: AccountOwner, current: () => boolean, signal: AbortSignal): Promise<{ data: Buffer; start: number } | null>
}
interface Lease {
  id: string; owner: AccountOwner; source: RemoteMeterSource; group: Group
  expires: number; lastDelivery: number; unsubscribe(): void
  publish(update: RemoteMeterUpdate): void
}
interface Group {
  source: RemoteMeterSource; leases: Set<Lease>; pending: boolean; nextRead: number
  abort?: AbortController; usage: ContextWindowUsage | null
}

/** Complete bounded snapshots deliberately carry no parser state across truncation/rotation. */
export function parseRemoteMeter(source: Pick<RemoteMeterSource, 'nodeId' | 'sessionId' | 'harness'>,
  page: { data: Buffer; start: number }, now: number): ContextWindowUsage | null {
  if (page.data.length > REMOTE_METER_BYTES + 1) return null
  let first = 0
  if (page.start > 0) { first = page.data.indexOf(10) + 1; if (!first) return null }
  const end = page.data.lastIndexOf(10)
  if (end < first) return null
  // Decode only complete lines: a torn UTF-8 suffix cannot become a usage/model observation.
  const text = page.data.subarray(first, end).toString('utf8')
  const parsed = source.harness === 'codex' ? codexContextParse(text) : parseLatestUsage(text)
  if (!parsed || !Number.isFinite(parsed.used) || parsed.used <= 0) return null
  const model = typeof parsed.model === 'string' && parsed.model.length <= 256 ? parsed.model : null
  const window = source.harness === 'codex' ? ('window' in parsed ? parsed.window : null) : cachedWindowFor(model)
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null
  return { nodeId: source.nodeId, sessionId: source.sessionId, usedTokens: parsed.used, windowTokens: window,
    usedPercent: Math.min(100, 100 * parsed.used / window), model,
    ...('effort' in parsed && typeof parsed.effort === 'string' && parsed.effort.length <= 32 ? { effort: parsed.effort } : {}),
    windowSource: source.harness === 'codex' ? 'transcript' : 'estimate', updatedAt: now }
}

/** Bounded owner demand. Cancellation retains the pending read slot until actual settlement. */
export class RemoteMeters {
  private leases = new Map<string, Lease>()
  private groups = new Map<string, Group>()
  private pending = 0
  private timer?: ReturnType<typeof setInterval>
  private disposed = false
  constructor(private readonly now = () => Date.now()) {}

  start(owner: AccountOwner, source: RemoteMeterSource, publish: Lease['publish']): RemoteMeterStart {
    this.sweep()
    if (this.disposed || !owner.active() || !source.current()) return { status: 'unavailable' }
    if (this.leases.size >= MAX_LEASES || [...this.leases.values()].filter(l => l.owner === owner).length >= MAX_OWNER_LEASES ||
      (!this.groups.has(source.key) && this.groups.size >= MAX_LEASES)) return { status: 'capacity' }
    let group = this.groups.get(source.key)
    if (group && !group.leases.size && group.pending) return { status: 'capacity' }
    if (!group) {
      group = { source, leases: new Set(), pending: false, nextRead: 0, usage: null }
      this.groups.set(source.key, group)
    }
    const lease: Lease = { id: randomUUID(), owner, source, group, expires: this.now() + REMOTE_METER_TTL,
      lastDelivery: -Infinity, unsubscribe: () => {}, publish }
    this.leases.set(lease.id, lease); group.leases.add(lease)
    lease.unsubscribe = owner.onDeparture(() => this.remove(lease))
    if (!this.timer) { this.timer = setInterval(() => this.tick(), 500); this.timer.unref?.() }
    this.tick()
    return { status: 'started', leaseId: lease.id, ttlMs: REMOTE_METER_TTL }
  }

  renew(owner: AccountOwner, id: string): boolean {
    const lease = this.leases.get(id)
    if (!lease || lease.owner !== owner) return false
    if (!this.current(lease)) { this.remove(lease); return false }
    lease.expires = this.now() + REMOTE_METER_TTL
    // Consumption-driven publication: at most one small update per renewal interval. No push backlog.
    if (this.now() - lease.lastDelivery >= POLL_MS) {
      lease.lastDelivery = this.now()
      if (!this.current(lease)) { this.remove(lease); return false }
      lease.publish({ leaseId: id, nodeId: lease.source.nodeId, sessionId: lease.source.sessionId,
        status: lease.group.usage ? 'ready' : 'unknown', usage: lease.group.usage, quota: 'unavailable' })
    }
    return true
  }

  release(owner: AccountOwner, id: string): void {
    const lease = this.leases.get(id)
    if (lease?.owner === owner) this.remove(lease)
  }
  private current(l: Lease): boolean {
    try { return !this.disposed && this.leases.get(l.id) === l && l.owner.active() &&
      this.now() < l.expires && l.source.current() } catch { return false }
  }
  private remove(l: Lease): void {
    if (!this.leases.delete(l.id)) return
    l.unsubscribe(); l.group.leases.delete(l)
    if (l.owner.active()) l.publish({ leaseId: l.id, nodeId: l.source.nodeId, sessionId: l.source.sessionId,
      status: 'invalidated', usage: null, quota: 'unavailable' })
    if (!l.group.leases.size) {
      l.group.abort?.abort()
      // Keep tombstone + global capacity through late completion. A new demand cannot reuse it.
      if (!l.group.pending) this.groups.delete(l.source.key)
    }
    if (!this.leases.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
  }
  private sweep(): void { for (const l of this.leases.values()) if (!this.current(l)) this.remove(l) }
  private tick(): void {
    this.sweep()
    for (const group of this.groups.values()) {
      if (this.pending >= MAX_READS) break
      if (!group.leases.size || group.pending || this.now() < group.nextRead) continue
      const lease = [...group.leases][0]
      if (!this.current(lease)) continue
      group.pending = true; this.pending++
      const abort = new AbortController(); group.abort = abort
      const current = () => !abort.signal.aborted && this.current(lease)
      // The reader's own deadline + queued-dispatch check apply too. No timeout frees this slot.
      void Promise.resolve().then(() => current() ? group.source.read(lease.owner, current, abort.signal) : null).then(page => {
        group.usage = current() && page ? parseRemoteMeter(group.source, page, this.now()) : null
      }).catch(() => { group.usage = null }).finally(() => {
        group.pending = false; this.pending--; group.abort = undefined; group.nextRead = this.now() + POLL_MS
        if (!group.leases.size) this.groups.delete(group.source.key)
      })
    }
  }
  dispose(): void {
    this.disposed = true
    for (const l of [...this.leases.values()]) this.remove(l)
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
