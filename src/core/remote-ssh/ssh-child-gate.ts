// A per-ControlMaster ceiling on how many ssh EXEC children may be in flight at once.
//
// WHY (measured against a real sshd, 2026-09-14). Every non-pty ssh command an SSH project runs is
// an exec child multiplexed over that project's one ControlMaster, and a stock sshd allows
// `MaxSessions 10` channels on one connection. A connect fans out ~23 hook-install round trips plus
// four fire-and-forget chains, a Source Control refresh is 13 concurrent `git` children, and every
// live remote terminal is already holding one of those channels for its whole life. When the burst
// overruns the limit each excess child is told `Session open refused by peer`, falls back to
// becoming a master, cannot bind the socket the live master owns (`ControlSocket … already exists,
// disabling multiplexing`) and performs a FULL TCP+KEX+auth login.
//
// A flood of simultaneous logins then trips the host's `MaxStartups`, and sshd resets the losers —
// `kex_exchange_identification: read: Connection reset by peer`. That is the expensive outcome: a
// reset is not a slow command, it is a FAILED one, and in the app it becomes a dropped terminal and
// the reconnect backoff (1s, 2s, 4s, 8s, 15s).
//
// Lab: one switch to a 10-terminal project with a 20-probe burst, MaxSessions 10, 20 ms RTT.
//   ungated (4 runs): 4, 6, 6, 8 connections RESET; once a pane never painted at all (9/10)
//   gated at 6 (3 runs): 0, 0, 0 resets; every pane painted
// Wall time is a wash (0.62–1.71 s gated, 0.68–1.14 s ungated) — the gate paces logins rather than
// preventing them once the terminals alone fill the host's limit. What it removes is the resets.
//
// Two things it deliberately does NOT gate:
//  - **Mux CONTROL commands** (`ssh -O check/exit/forward/cancel`). They talk to the master's
//    control socket instead of opening a session channel, so they cost the host nothing and cannot
//    be refused for a channel limit — and queueing the 45 s watchdog's `-O check` behind six 5 MB
//    transcript reads would make the health probe report on a connection it never looked at.
//  - **The terminals themselves.** A pty is spawned through node-pty, not through this runner, so
//    a terminal never waits on a queue for a screen the user is looking at.
//
// The ceiling is per CONTROL PATH because that is what a `MaxSessions` limit is scoped to: one
// connection. Two SSH projects on the same host have two masters and two independent budgets.

/** Concurrent exec children allowed per ControlMaster. Deliberately below a stock `MaxSessions 10`
 *  while leaving room for the terminals, which hold their channels for life and are never queued. */
export const SSH_CHILD_CONCURRENCY = 6

/**
 * The `ControlPath` this argv addresses, or `undefined` when it names none.
 *
 * Every builder in `control-master.ts` emits it as the two tokens `-o` `ControlPath=<p>`; the
 * single-token `-oControlPath=<p>` spelling is accepted too, because ssh does and a future caller
 * may. Children with no control path share one bucket: they are not multiplexed, so they cannot
 * exhaust a master's channels, but they are still ssh logins and a burst of them is still a burst.
 */
export function controlPathOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-o' && i + 1 < args.length) {
      const v = args[i + 1]
      if (v.startsWith('ControlPath=')) return v.slice('ControlPath='.length)
    } else if (a.startsWith('-oControlPath=')) {
      return a.slice('-oControlPath='.length)
    }
  }
  return undefined
}

/**
 * Is this a mux CONTROL command (`-O check|exit|forward|cancel`) rather than a session channel?
 *
 * Matched on the flag alone: `-O` takes a command argument and ssh has no other use for it, so the
 * flag's presence is the whole test. These are never queued (see the header).
 */
export function isMuxControlCommand(args: readonly string[]): boolean {
  return args.includes('-O')
}

/**
 * Per-control-path concurrency limiter for ssh exec children.
 *
 * FIFO within a bucket, so a queued read cannot be starved by later arrivals. A slot is always
 * released, including when the work throws — the runner this wraps resolves rather than rejects,
 * but a limiter that can leak a permit is a limiter that eventually wedges a whole project.
 */
export class SshChildCancelledError extends Error {
  constructor() { super('ssh-queued-command-cancelled') }
}

export class SshChildGate {
  private active = new Map<string, number>()
  private waiting = new Map<string, Array<{ grant(): void }>>()

  constructor(private limit: number = SSH_CHILD_CONCURRENCY) {}

  /** Run `fn` under this argv's budget. Mux control commands bypass the queue entirely. */
  async run<T>(args: readonly string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new SshChildCancelledError()
    if (isMuxControlCommand(args)) return fn()
    const key = controlPathOf(args) ?? ''
    await this.acquire(key, signal)
    try {
      if (signal?.aborted) throw new SshChildCancelledError()
      return await fn()
    } finally {
      this.release(key)
    }
  }

  /** In-flight children for a control path — for tests and diagnostics. */
  inFlight(controlPath: string): number {
    return this.active.get(controlPath) ?? 0
  }

  /** Children queued behind the limit for a control path. */
  queued(controlPath: string): number {
    return this.waiting.get(controlPath)?.length ?? 0
  }

  private acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new SshChildCancelledError())
    const n = this.active.get(key) ?? 0
    if (n < this.limit) {
      this.active.set(key, n + 1)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let waiting = true
      const entry = { grant: () => {
        waiting = false; signal?.removeEventListener('abort', cancel); resolve()
      } }
      const cancel = () => {
        if (!waiting) return
        waiting = false
        const queue = this.waiting.get(key)
        const index = queue?.indexOf(entry) ?? -1
        if (queue && index >= 0) queue.splice(index, 1)
        if (queue?.length === 0) this.waiting.delete(key)
        signal?.removeEventListener('abort', cancel)
        reject(new SshChildCancelledError())
      }
      const q = this.waiting.get(key)
      if (q) q.push(entry)
      else this.waiting.set(key, [entry])
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }

  private release(key: string): void {
    const q = this.waiting.get(key)
    const next = q?.shift()
    if (next) {
      if (q && q.length === 0) this.waiting.delete(key)
      // The permit is handed straight to the waiter — `active` never dips, so a burst cannot
      // slip past the limit in the gap between one child finishing and the next starting.
      next.grant()
      return
    }
    const n = (this.active.get(key) ?? 1) - 1
    if (n <= 0) this.active.delete(key)
    else this.active.set(key, n)
  }
}
