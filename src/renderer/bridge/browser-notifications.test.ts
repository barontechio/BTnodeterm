// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { createBrowserNotifications, installBrowserNotificationRouter, MAX_BROWSER_NOTIFICATIONS } from './browser-notifications'

class Notice {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => (Notice.permission = 'granted' as const))
  static all: Notice[] = []
  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public options: NotificationOptions) { Notice.all.push(this) }
}
const source = {} as NodeTerminalApi
const payload = { nodeId: 'n', title: 'Finished', body: 'Ready' }
let adapter: ReturnType<typeof createBrowserNotifications>
let off: () => void
let valid: boolean
let focus: ReturnType<typeof vi.fn<(current: () => boolean) => void>>
beforeEach(() => {
  vi.stubGlobal('Notification', Notice)
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  Notice.all = []
  Notice.permission = 'granted'
  Notice.requestPermission.mockClear()
  valid = true
  focus = vi.fn()
  off = installBrowserNotificationRouter((api) => api === source ? { current: () => valid, focus } : null)
  adapter = createBrowserNotifications(() => source)
})
afterEach(() => { adapter.dispose(); off(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('open-page browser notifications', () => {
  it('requires BOTH explicit force and active gesture before permission', async () => {
    Notice.permission = 'default'
    expect(await adapter.notify(payload)).toBe('skipped')
    expect(await adapter.notify({ ...payload, force: true })).toBe('skipped')
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true })
    expect(await adapter.notify(payload)).toBe('skipped')
    expect(Notice.requestPermission).not.toHaveBeenCalled()
    expect(await adapter.notify({ ...payload, force: true })).toBe('shown')
    expect(Notice.requestPermission).toHaveBeenCalledTimes(1)
  })
  it('rechecks lifetime after asynchronous permission', async () => {
    Notice.permission = 'default'
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true })
    Notice.requestPermission.mockImplementationOnce(async () => { adapter.dispose(); return 'granted' })
    expect(await adapter.notify({ ...payload, force: true })).toBe('skipped')
    expect(Notice.all).toHaveLength(0)
  })
  it('reports denied, absent, insecure and construction failure honestly', async () => {
    Notice.permission = 'denied'
    expect(await adapter.notify(payload)).toBe('failed')
    vi.stubGlobal('Notification', undefined)
    expect(await adapter.notify(payload)).toBe('failed')
    vi.stubGlobal('Notification', Notice)
    vi.stubGlobal('isSecureContext', false)
    expect(await adapter.notify(payload)).toBe('failed')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('Notification', class { static permission = 'granted'; constructor() { throw new Error('unsupported') } })
    expect(await adapter.notify(payload)).toBe('failed')
  })
  it('bounds content and live count; pagehide closes every survivor', async () => {
    for (let i = 0; i < MAX_BROWSER_NOTIFICATIONS + 2; i++) {
      expect(await adapter.notify({ ...payload, title: 'x'.repeat(1000), body: 'y'.repeat(1000) })).toBe('shown')
    }
    expect(Notice.all[0].title).toHaveLength(160)
    expect(Notice.all[0].options.body).toHaveLength(500)
    expect(Notice.all.filter((n) => n.close.mock.calls.length === 0)).toHaveLength(MAX_BROWSER_NOTIFICATIONS)
    window.dispatchEvent(new Event('pagehide'))
    expect(Notice.all.every((n) => n.close.mock.calls.length === 1)).toBe(true)
    expect(await adapter.notify(payload)).toBe('skipped')
  })
  it('shares the page cap across source APIs and cleans up on native close/error', async () => {
    const other = createBrowserNotifications(() => source)
    try {
      for (let i = 0; i < MAX_BROWSER_NOTIFICATIONS; i++) await adapter.notify(payload)
      await other.notify(payload)
      expect(Notice.all[0].close).toHaveBeenCalledTimes(1)
      const latest = Notice.all.at(-1)!
      latest.onclose!()
      expect(latest.onclick).toBeNull()
      await other.notify(payload)
      Notice.all.at(-1)!.onerror!()
      expect(Notice.all.at(-1)!.onclick).toBeNull()
    } finally { other.dispose() }
  })
  it('click is once-only, checks again after focus, and invalidates queued focus on disposal', async () => {
    await adapter.notify(payload)
    const click = Notice.all[0].onclick!
    click(); click()
    expect(focus).toHaveBeenCalledTimes(1)
    const guard = focus.mock.calls[0][0] as () => boolean
    expect(guard()).toBe(true)
    adapter.dispose()
    expect(guard()).toBe(false)
  })
  it('refuses removed targets and focus-triggered source replacement', async () => {
    await adapter.notify(payload)
    valid = false
    Notice.all[0].onclick!()
    expect(window.focus).not.toHaveBeenCalled()
    valid = true
    await adapter.notify(payload)
    vi.mocked(window.focus).mockImplementation(() => { valid = false })
    Notice.all[1].onclick!()
    expect(focus).not.toHaveBeenCalled()
  })
  it('drops unknown sources, detached routing, and normal foreground events', async () => {
    const foreign = createBrowserNotifications(() => ({} as NodeTerminalApi))
    expect(await foreign.notify(payload)).toBe('skipped')
    foreign.dispose()
    vi.mocked(document.hasFocus).mockReturnValue(true)
    expect(await adapter.notify(payload)).toBe('skipped')
    expect(await adapter.notify({ ...payload, force: true })).toBe('shown')
    off()
    Notice.all[0].onclick!()
    expect(focus).not.toHaveBeenCalled()
  })
})
