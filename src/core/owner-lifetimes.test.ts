import { describe, expect, it, vi } from 'vitest'
import { OwnerLifetimes } from './owner-lifetimes'

describe('owner connection/document lifetimes', () => {
  it('retains identity within a connection and replaces it only after departure', () => {
    const registry = new OwnerLifetimes()
    const first = registry.get(1, () => true); const listener = vi.fn(); first.onDeparture(listener)
    expect(registry.get(1, () => true)).toBe(first)
    registry.forget(1)
    expect(listener).toHaveBeenCalledOnce(); expect(first.active()).toBe(false)
    expect(registry.get(1, () => true)).not.toBe(first)
  })
  it('refuses ineligible callers and cannot revive a revoked or disposed identity', () => {
    const registry = new OwnerLifetimes(); let eligible = true
    const first = registry.get(1, () => eligible)
    eligible = false
    expect(first.active()).toBe(false); expect(() => registry.get(1, () => false)).toThrow('owner-required')
    registry.forget(1); eligible = true
    const next = registry.get(1, () => eligible)
    registry.dispose()
    expect(first.active()).toBe(false); expect(next.active()).toBe(false)
    expect(() => registry.get(1, () => true)).toThrow('owner-required')
  })
})
