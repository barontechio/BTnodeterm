import { describe, expect, it } from 'vitest'
import { NodeExecutionCoordinator } from './node-execution'
import { OwnerLifetimes } from './owner-lifetimes'

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
const options = { current: () => true }

describe('host node execution ownership', () => {
  it('excludes other callers while preserving concurrent work on another node', async () => {
    const guard = new NodeExecutionCoordinator(); const hold = deferred()
    const first = guard.run('a', 'branch', options, async () => { guard.assertAllowed('a'); await hold.promise; guard.assertAllowed('a') })
    expect(() => guard.assertAllowed('a')).toThrow('busy')
    await expect(guard.run('a', 'write', options, () => {})).rejects.toThrow('busy')
    await expect(guard.run('b', 'write', options, () => 'other')).resolves.toBe('other')
    hold.resolve(); await first
    expect(guard.isBusy('a')).toBe(false); guard.assertAllowed('a')
  })
  it('fences an owner departure until in-flight work settles, then permits a fresh owner', async () => {
    const owners = new OwnerLifetimes(); const owner = owners.get(1, () => true)
    const guard = new NodeExecutionCoordinator(); const hold = deferred()
    let signal!: AbortSignal
    const first = guard.run('a', 'account', { ...options, owner }, async (permit) => { signal = permit.signal; await hold.promise })
    void first.catch(() => {})
    owners.forget(1)
    expect(signal.aborted).toBe(true); expect(guard.isBusy('a')).toBe(true)
    await expect(guard.run('a', 'restart', options, () => {})).rejects.toThrow('busy')
    hold.resolve(); await expect(first).rejects.toThrow('expired')
    await expect(guard.run('a', 'write', options, () => 'fresh')).resolves.toBe('fresh')
  })
  it('checks the real deadline before the timer runs and never releases a dispatched effect early', async () => {
    let now = 0; const guard = new NodeExecutionCoordinator(() => now); const hold = deferred()
    const first = guard.run('a', 'write', { ...options, timeoutMs: 10_000 }, async (permit) => {
      await hold.promise; expect(permit.signal.aborted).toBe(false)
      expect(permit.current()).toBe(false); expect(permit.signal.aborted).toBe(true)
    })
    void first.catch(() => {})
    now = 10_001
    expect(guard.isBusy('a')).toBe(true)
    await expect(guard.run('a', 'branch', options, () => {})).rejects.toThrow('busy')
    hold.resolve(); await expect(first).rejects.toThrow('expired')
  })
  it('rejects replaced target identity and detached continuations on every node', async () => {
    const guard = new NodeExecutionCoordinator(); let current = true
    const late = deferred(); let continuation!: Promise<void>
    await guard.run('a', 'branch', { current: () => current }, () => {
      continuation = late.promise.then(() => { guard.assertAllowed('b') })
    })
    void continuation.catch(() => {})
    late.resolve(); await expect(continuation).rejects.toThrow('expired')
    const hold = deferred()
    const replacing = guard.run('a', 'write', { current: () => current }, async () => { await hold.promise; guard.assertAllowed('a') })
    void replacing.catch(() => {})
    current = false; hold.resolve(); await expect(replacing).rejects.toThrow('expired')
  })
  it('releases failed work, bounds concurrency and makes shutdown refuse all later mutations', async () => {
    const guard = new NodeExecutionCoordinator(undefined, 1)
    await expect(guard.run('a', 'write', options, () => { throw new Error('delivery failed') })).rejects.toThrow('delivery failed')
    const hold = deferred(); const running = guard.run('a', 'worktree', options, () => hold.promise)
    void running.catch(() => {})
    await expect(guard.run('b', 'write', options, () => {})).rejects.toThrow('capacity')
    guard.dispose(); expect(() => guard.assertAllowed('b')).toThrow('stopped')
    hold.resolve(); await expect(running).rejects.toThrow('expired')
    expect(guard.isBusy('a')).toBe(false)
  })
})
