import type { MediaScope } from './media'

export const WEB_NODE_SIZE = { width: 720, height: 520 }
export const WEB_PREVIEW_MAX_BYTES = 1024 * 1024

export function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

/** A hosted preview must not reinterpret the host's localhost as the viewer's machine. */
export function externalPreviewUrl(raw: string): string | null {
  const normalized = httpUrl(raw)
  if (!normalized) return null
  const url = new URL(normalized)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.username || url.password || host === 'localhost' || host.endsWith('.localhost') ||
    host === '[::1]' || host === '[::]' || host === '0.0.0.0' || /^127\./.test(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(host)) return null
  return normalized
}

export function webNodeData(source: { url?: string; filePath?: string }) {
  return { title: source.url ? source.url.replace(/^https?:\/\//, '').slice(0, 40) : source.filePath?.split('/').pop() || 'web',
    color: '#6ac4dc', group: null, ...(source.url ? { url: source.url } : {}),
    ...(source.filePath ? { filePath: source.filePath } : {}) }
}

export interface WebPreviewApi {
  allow(scope: MediaScope): Promise<string>
  renew(url: string): Promise<boolean>
  release(url: string): Promise<void>
}
