import { describe, expect, it } from 'vitest'
import { externalPreviewUrl, httpUrl, webNodeData } from './web-preview'

describe('web preview source rules', () => {
  it('preserves Desktop HTTP URL normalization and node metadata', () => {
    expect(httpUrl('https://example.com')).toBe('https://example.com/')
    expect(webNodeData({ filePath: '/tmp/page.html' })).toEqual({ title: 'page.html', color: '#6ac4dc', group: null, filePath: '/tmp/page.html' })
  })
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'http://localhost:3000',
    'http://127.1:3000', 'http://[::1]:3000', 'http://[::ffff:127.0.0.1]:3000', 'http://app.localhost.', 'https://user:pass@example.com'])('refuses hosted external preview %s', (url) => {
    expect(externalPreviewUrl(url)).toBeNull()
  })
  it('keeps real external HTTP and HTTPS links available', () => {
    expect(externalPreviewUrl('https://example.com/page')).toBe('https://example.com/page')
    expect(externalPreviewUrl('http://example.com/page')).toBe('http://example.com/page')
  })
})
