// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest'
import { enableWebPush, installWebPushClicks } from './web-push'
import { markBrowserRuntime } from './runtime'
markBrowserRuntime()
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('never asks notification permission without current explicit user activation', async () => {
  const requestPermission = vi.fn(async () => 'granted')
  vi.stubGlobal('Notification', { requestPermission }); vi.stubGlobal('PushManager', class {})
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false } })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: vi.fn() } })
  await expect(enableWebPush('project', 'key', () => true)).rejects.toThrow(/click/)
  expect(requestPermission).not.toHaveBeenCalled()
})
it('accepts only worker-origin click messages, revalidates via HTTP, waits for real routing and disposes', async () => {
  vi.useFakeTimers()
  const worker = new EventTarget()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker })
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ projectId: 'p', nodeId: 'n', sessionId: 's' }) }))
  vi.stubGlobal('fetch', fetcher)
  let retry!: () => void
  const route = vi.fn(() => false)
  const off = installWebPushClicks(route, cb => { retry = cb; return () => {} })
  const noticeId = '12345678-1234-1234-1234-123456789abc'
  const emit = (scriptURL: string) => worker.dispatchEvent(new MessageEvent('message', { data: { type: 'nodeterm:web-push-click', noticeId }, source: { scriptURL } as never }))
  emit('https://evil.test/web-push-sw.js'); await vi.runAllTimersAsync(); expect(fetcher).not.toHaveBeenCalled()
  emit(new URL('/web-push-sw.js', location.origin).href); await vi.advanceTimersByTimeAsync(60)
  expect(route).toHaveBeenCalledTimes(1)
  route.mockReturnValue(true); retry(); await vi.advanceTimersByTimeAsync(60)
  expect(route).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(2)
  off(); emit(new URL('/web-push-sw.js', location.origin).href); await vi.runAllTimersAsync(); expect(route).toHaveBeenCalledTimes(2)
})
