import type { Settings, SettingsApi } from '../../shared/types'

/** Coalesces explicit UI edits; host pushes never become edits to send back. */
export class SettingsWriteQueue {
  private pendingPatch: Partial<Settings> | null = null
  private pendingSnapshot: Settings | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = new Map<number, Partial<Settings>>()
  private nextId = 0
  private lastHostSnapshot: Settings | null = null
  private revisions = new Map<string, number>()
  private revision = 0
  private submissions = new Set<Promise<void>>()

  constructor(private readonly deps: {
    api(): SettingsApi
    current(): Settings
    apply(settings: Settings): void
    failed(): void
    delayMs?: number
  }) {}

  schedule(snapshot: Settings, patch: Partial<Settings>): void {
    for (const key of Object.keys(patch)) this.revisions.set(key, ++this.revision)
    this.pendingPatch = { ...this.pendingPatch, ...structuredClone(patch) }
    this.pendingSnapshot = snapshot
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.submit().catch(() => {}) }, this.deps.delayMs ?? 300)
  }

  receive(snapshot: Settings): void {
    this.lastHostSnapshot = snapshot
    this.applyHost()
  }

  private applyHost(): void {
    if (!this.lastHostSnapshot) return
    const explicit = Object.assign({}, ...this.inFlight.values(), this.pendingPatch ?? {}) as Partial<Settings>
    const next = { ...this.lastHostSnapshot, ...explicit }
    this.deps.apply(next)
    if (this.pendingSnapshot) this.pendingSnapshot = next
  }

  flushPending(): Promise<void> { return this.pendingPatch ? this.submit() : Promise.resolve() }

  async flush(): Promise<void> {
    // A flush before an account/session operation must include earlier unacknowledged edits,
    // including the retry patch retained by a failed submission.
    while (this.submissions.size) await Promise.allSettled([...this.submissions])
    await this.submit()
  }

  private submit(): Promise<void> {
    const run = this.write()
    this.submissions.add(run)
    void run.then(() => this.submissions.delete(run), () => this.submissions.delete(run))
    return run
  }

  private async write(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const patch = this.pendingPatch ?? {}
    const revisions = new Map(Object.keys(patch).map((key) => [key, this.revisions.get(key)]))
    const snapshot = this.pendingSnapshot ?? this.deps.current()
    this.pendingPatch = null; this.pendingSnapshot = null
    const id = ++this.nextId
    this.inFlight.set(id, patch)
    try {
      const api = this.deps.api()
      // The null reply is negotiated only for a missing handler on an older host. An uncertain
      // transport failure must never fall through to a stale full-snapshot write.
      const result = api.patch ? await api.patch(patch) : null
      if (result === null) await api.save(snapshot)
      else if (!api.onChanged) this.receive(result)
    } catch (error) {
      const retry = Object.fromEntries(Object.entries(patch).filter(([key]) => revisions.get(key) === this.revisions.get(key)))
      const pending = Object.assign({}, retry, this.pendingPatch ?? {}) as Partial<Settings>
      this.pendingPatch = Object.keys(pending).length ? pending : null
      this.pendingSnapshot = this.pendingPatch ? this.deps.current() : null
      this.deps.failed()
      throw error
    } finally { this.inFlight.delete(id); this.applyHost() }
  }
}
