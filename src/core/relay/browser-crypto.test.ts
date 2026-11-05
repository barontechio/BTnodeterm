import { expect, it } from 'vitest'
import { hkdfSync, createHash } from 'node:crypto'
import { deriveSessionKey, publicKeyToB64 } from './e2ee'
import { hostIdFromPublicKey } from './relay-id'
import { bytesToB64, b64ToBytes, legacyB64ToBytes } from './bytes'

it('portable HKDF/host IDs/base64 stay byte-identical to existing Node wire primitives', () => {
  for (let value = 0; value < 32; value++) {
    const shared = new Uint8Array(32).fill(value), host = new Uint8Array(16).fill(value + 1), client = new Uint8Array(16).fill(value + 2)
    const expected = new Uint8Array(hkdfSync('sha256', shared, Buffer.concat([host, client]), Buffer.from('nodeterm-relay-session-v2'), 32))
    expect(deriveSessionKey(shared, host, client)).toEqual(expected)
    expect(hostIdFromPublicKey(shared)).toBe(createHash('sha256').update(shared).digest('base64url').slice(0, 22))
    expect(publicKeyToB64(shared)).toBe(Buffer.from(shared).toString('base64'))
    expect(b64ToBytes(bytesToB64(shared))).toEqual(shared)
  }
  for (const value of ['abc', 'ab', 'a', '!!!a_b-c+===junk', 'a b\nc', '']) {
    expect(legacyB64ToBytes(value)).toEqual(Uint8Array.from(Buffer.from(value, 'base64')))
  }
})
