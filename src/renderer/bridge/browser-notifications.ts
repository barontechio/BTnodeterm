import type { NodeTerminalApi, NotifyPayload } from '@shared/types'

export interface BrowserNotificationTarget {
  current(): boolean
  focus(current: () => boolean): void
}
type Router = (api: NodeTerminalApi, payload: NotifyPayload) => BrowserNotificationTarget | null
let router: Router | null = null

/** Canvas supplies routing; the transport/DOM layer must never import renderer stores. */
export function installBrowserNotificationRouter(next: Router): () => void {
  router = next
  return () => { if (router === next) router = null }
}

export const MAX_BROWSER_NOTIFICATIONS = 8
const liveNotices = new Map<Notification, () => void>()

/** Open-page notifications only. Each instance belongs to one actual carrier/API lifetime. */
export function createBrowserNotifications(source: () => NodeTerminalApi) {
  let disposed = false
  const notices = new Map<Notification, () => void>()
  const dispose = (): void => {
    disposed = true
    for (const close of notices.values()) close()
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const notify: NodeTerminalApi['notify'] = async (payload) => {
    if (disposed) return 'skipped'
    if (!window.isSecureContext || typeof Notification === 'undefined') return 'failed'
    const routing = router
    const target = payload.nodeId ? routing?.(source(), payload) : null
    // Unknown/ambiguous sources must not display a misleading actionable notification.
    if (payload.nodeId && !target) return 'skipped'
    const current = (): boolean => !disposed && (!payload.nodeId || (router === routing && !!target?.current()))
    try {
      if (Notification.permission === 'default') {
        // Both conditions matter: incoming events cannot borrow unrelated user activation.
        if (payload.force !== true || !navigator.userActivation?.isActive) return 'skipped'
        await Notification.requestPermission()
      }
      if (!current()) return 'skipped'
      if (Notification.permission !== 'granted') return 'failed'
      if (!payload.force && document.hasFocus()) return 'skipped'
      while (liveNotices.size >= MAX_BROWSER_NOTIFICATIONS) liveNotices.values().next().value?.()
      const notice = new Notification(payload.title.slice(0, 160), { body: payload.body.slice(0, 500) })
      let consumed = false
      const close = (): void => {
        consumed = true
        notices.delete(notice)
        liveNotices.delete(notice)
        notice.onclick = notice.onclose = notice.onerror = null
        notice.close()
      }
      notices.set(notice, close)
      liveNotices.set(notice, close)
      notice.onclose = notice.onerror = close
      notice.onclick = () => {
        if (consumed) return
        close()
        if (!current()) return
        try { window.focus() } catch { return }
        // Focus can synchronously trigger state changes or disconnect the source.
        if (current()) target?.focus(current)
      }
      return 'shown'
    } catch {
      return 'failed'
    }
  }
  return { notify, dispose }
}
