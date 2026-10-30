import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccountOwner } from './owner-lifetimes'

export type NodeExecutionKind = 'write' | 'branch' | 'restart' | 'account' | 'worktree'
export interface NodeExecutionPermit {
  readonly nodeId: string
  readonly kind: NodeExecutionKind
  readonly signal: AbortSignal
  current(): boolean
  assertCurrent(): void
}
export interface NodeExecutionOptions {
  /** Physical backend generation and saved execution identity; never a renderer snapshot. */
  current(): boolean
  owner?: AccountOwner
  timeoutMs?: number
}
type Entry = {
  permit: NodeExecutionPermit
  cancel(): void
  cleanup(): void
}

export class NodeExecutionError extends Error {
  constructor(readonly code: 'busy' | 'expired' | 'stopped' | 'invalid' | 'capacity') {
    super(`node-execution-${code}`)
  }
}

/** Host-only exclusion. Cancellation fences a node until dispatched work actually settles. */
export class NodeExecutionCoordinator {
  private active = new Map<string, Entry>()
  private context = new AsyncLocalStorage<Entry>()
  private stopped = false

  constructor(private readonly now: () => number = () => Date.now(), private readonly limit = 32) {}

  isBusy(nodeId: string): boolean { return this.active.has(nodeId) }

  /** Every mutation checks this at its point of dispatch, including continuations after expiry. */
  assertAllowed(nodeId: string): void {
    if (this.stopped) throw new NodeExecutionError('stopped')
    const context = this.context.getStore()
    // An expired continuation cannot escape its old lease by writing a different/new node.
    context?.permit.assertCurrent()
    const active = this.active.get(nodeId)
    if (active && active !== context) throw new NodeExecutionError('busy')
  }

  async run<T>(nodeId: string, kind: NodeExecutionKind, options: NodeExecutionOptions,
    work: (permit: NodeExecutionPermit) => Promise<T> | T): Promise<T> {
    if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 256 || nodeId.includes('\0')) throw new NodeExecutionError('invalid')
    this.assertAllowed(nodeId)
    if (this.active.has(nodeId)) throw new NodeExecutionError('busy')
    if (this.active.size >= this.limit) throw new NodeExecutionError('capacity')
    const timeout = options.timeoutMs ?? 30_000
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120_000) throw new NodeExecutionError('invalid')
    const deadline = this.now() + timeout
    const abort = new AbortController()
    let live = true
    const cancel = () => { live = false; abort.abort() }
    const current = () => {
      if (!live || this.stopped || this.now() >= deadline || options.owner?.active() === false) { cancel(); return false }
      try { if (!options.current()) { cancel(); return false } } catch { cancel(); return false }
      return true
    }
    const permit: NodeExecutionPermit = { nodeId, kind, signal: abort.signal, current,
      assertCurrent: () => { if (!current()) throw new NodeExecutionError('expired') } }
    permit.assertCurrent()
    const timer = setTimeout(cancel, timeout); timer.unref?.()
    let unsubscribe = () => {}
    const entry: Entry = { permit, cancel, cleanup: () => { cancel(); clearTimeout(timer); try { unsubscribe() } catch { /* always release the fence */ } } }
    this.active.set(nodeId, entry)
    try {
      unsubscribe = options.owner?.onDeparture(cancel) ?? (() => {})
      return await this.context.run(entry, async () => {
        permit.assertCurrent()
        const result = await work(permit)
        permit.assertCurrent()
        return result
      })
    } finally {
      entry.cleanup()
      if (this.active.get(nodeId) === entry) this.active.delete(nodeId)
    }
  }

  /** Does not release a running fence or pretend its backend effect was cancelled. */
  dispose(): void { this.stopped = true; for (const entry of this.active.values()) entry.cancel() }
}
