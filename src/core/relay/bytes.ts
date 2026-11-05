/** Canonical RFC4648 bytes without Node globals, shared by browser and native relay. */
export function bytesToB64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
export function b64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0))
}
export function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return b64ToBytes(b64 + '='.repeat((4 - b64.length % 4) % 4))
}

/** Legacy key/hash helpers used Node's permissive decoder. Validation remains at intake. */
export function legacyB64ToBytes(text: string): Uint8Array {
  let value = text.split('=')[0].replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  if (value.length % 4 === 1) value = value.slice(0, -1)
  return b64ToBytes(value + '='.repeat((4 - value.length % 4) % 4))
}
