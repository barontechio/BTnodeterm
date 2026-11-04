// @vitest-environment jsdom
import type { NodeTerminalApi } from '@shared/types'
import { afterEach, expect, it, vi } from 'vitest'
import { buildRelayApi } from './relay-api'
import { buildStubApi } from './stubs'
import { markBrowserTeamConnection, forgetBrowserTeamConnection } from './browser-team/connections'
import { installBrowserNotificationRouter } from './browser-notifications'
import type { FrameTransport } from './frame-transport'

afterEach(() => { forgetBrowserTeamConnection('notices-api'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('relay API owns notices, closes on carrier/handle close and never calls owner notify; offline stays inert', async () => {
  markBrowserTeamConnection('notices-api')
  const owner = buildStubApi()
  owner.notify = vi.fn(async () => 'shown' as const)
  window.nodeTerminal = owner as NodeTerminalApi
  vi.stubGlobal('isSecureContext', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  const close = vi.fn()
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    close = close
  })
  let dropped = () => {}
  const transport: FrameTransport = { send() {}, onMessage() {}, onClose(cb) { dropped = cb }, ready: async () => {} }
  const handle = buildRelayApi('notices-api', transport)
  const off = installBrowserNotificationRouter((source) => source === handle.api ? { current: () => true, focus() {} } : null)
  try {
    expect(await handle.api.notify({ title: '', body: '', nodeId: 'n' })).toBe('shown')
    expect(owner.notify).not.toHaveBeenCalled()
    dropped()
    expect(close).toHaveBeenCalledTimes(1)
    expect(await handle.api.notify({ title: '', body: '', nodeId: 'n' })).toBe('skipped')
    const offline = buildRelayApi('notices-api', transport, { offline: true })
    expect(await offline.api.notify({ title: '', body: '', nodeId: '', force: true })).toBe('skipped')
    const another = buildRelayApi('notices-api', transport)
    expect(await another.api.notify({ title: '', body: '', nodeId: '', force: true })).toBe('shown')
    another.close()
    expect(await another.api.notify({ title: '', body: '', nodeId: '', force: true })).toBe('skipped')
    expect(close).toHaveBeenCalledTimes(2)
  } finally { off(); handle.close() }
})
