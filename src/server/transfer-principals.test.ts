import { describe, expect, it } from 'vitest'
import { TransferPrincipals } from './transfer-principals'

describe('bulk HTTP cookie principal binding', () => {
  it('requires a live cookie-authenticated WS and never creates proxy principals', () => {
    const registry = new TransferPrincipals(token => token === 'owner')
    expect(registry.forCookie('owner')).toBeUndefined()
    registry.attach(1, null); registry.attach(2, 'invalid')
    expect(registry.forClient(1)).toBeUndefined(); expect(registry.forClient(2)).toBeUndefined()
    registry.attach(3, 'owner')
    const first = registry.forClient(3)!
    registry.attach(4, 'owner')
    expect(registry.forCookie('owner')).toBe(first)
    registry.forget(3); expect(first.current()).toBe(true)
    registry.forget(4); expect(first.current()).toBe(false)
    registry.attach(5, 'owner')
    expect(registry.forCookie('owner')).not.toBe(first)
    expect(first.current()).toBe(false)
    registry.dispose()
  })
  it('revocation invalidates immediately without waiting for socket closure', () => {
    let valid = true
    const registry = new TransferPrincipals(() => valid)
    registry.attach(1, 'token')
    const captured = registry.forClient(1)!
    valid = false
    expect(captured.current()).toBe(false)
    expect(registry.forCookie('token')).toBeUndefined()
    registry.dispose()
  })
})
