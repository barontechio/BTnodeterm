import { isBrowserRuntime } from './runtime'

export interface WebPushCapability { available: boolean; publicKey?: string; reason?: string }
export interface WebPushClickTarget { projectId: string; nodeId: string; sessionId: string }
export const WEB_PUSH_WORKER = '/web-push-sw.js'
export function webPushBrowserAvailable(): boolean {
  return isBrowserRuntime() && window.isSecureContext && 'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' && typeof Notification !== 'undefined'
}
export async function webPushPost<T>(operation: string, body: unknown): Promise<T> {
  const response = await fetch('/auth/web-push/' + operation, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('The server refused this Web Push request. Check your sign-in, project and operator configuration.')
  return response.json() as Promise<T>
}
export async function webPushCapability(): Promise<WebPushCapability> {
  const response = await fetch('/auth/web-push/capability', { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('A password-authenticated owner session is required for Web Push.')
  return response.json() as Promise<WebPushCapability>
}
export async function existingWebPush(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return registration?.active?.scriptURL === new URL(WEB_PUSH_WORKER, location.origin).href ? registration.pushManager.getSubscription() : null
}
/** Call from the actual enable click, before any await, so permission cannot borrow a later
 * unrelated gesture. This feature never subscribes or requests permission at boot. */
export async function enableWebPush(projectId: string, publicKey: string, current: () => boolean): Promise<void> {
  if (!webPushBrowserAvailable() || !navigator.userActivation?.isActive || !current()) throw new Error('Enable Web Push with a click in a supported secure browser.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted' || !current()) throw new Error('Notification permission was not granted, or the project changed.')
  const registration = await navigator.serviceWorker.register(WEB_PUSH_WORKER, { scope: '/', updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  if (!current()) throw new Error('The project changed. Enable again from its settings.')
  const previous = await registration.pushManager.getSubscription()
  // A new explicit consent creates fresh browser keys too; an old login must not own the new
  // session's delivery. Do not silently transfer subscriptions between authenticated sessions.
  if (previous) {
    await webPushPost('unsubscribe', { endpoint: previous.endpoint })
    await previous.unsubscribe()
  }
  if (!current()) throw new Error('The project changed.')
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
  try {
    if (!current()) throw new Error('The project changed.')
    await webPushPost('subscribe', { projectId, subscription: subscription.toJSON() })
    if (!current()) {
      await webPushPost('unsubscribe', { endpoint: subscription.endpoint })
      throw new Error('The project changed.')
    }
  } catch (err) { await subscription.unsubscribe().catch(() => {}); throw err }
}
export async function disableWebPush(): Promise<void> {
  const subscription = await existingWebPush()
  if (!subscription) return
  // Revoke host consent before touching browser delivery. An unknown reply is shown as failure.
  await webPushPost('unsubscribe', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

/** Queue a click until Canvas and host session identities are hydrated. It grants no authority:
 * every attempt re-resolves the receipt against the authenticated HTTP cookie and live host. */
export function installWebPushClicks(route: (target: WebPushClickTarget) => boolean,
  subscribe: (retry: () => void) => () => void): () => void {
  let pending: string | null = null
  let disposed = false
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let epoch = 0
  const retry = (): void => {
    if (!pending || disposed || busy || timer) return
    timer = setTimeout(() => { timer = undefined; void attempt() }, 50)
  }
  const attempt = async (): Promise<void> => {
    if (!pending || disposed || busy) return
    busy = true
    const id = pending
    const captured = epoch
    try {
      const target = await webPushPost<WebPushClickTarget>('resolve', { noticeId: id })
      if (!disposed && captured === epoch && route(target)) pending = null
    } catch { if (captured === epoch) pending = null }
    finally { busy = false; if (captured !== epoch) retry() }
  }
  const receive = (id: unknown): void => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return
    pending = id; epoch++; retry()
  }
  const message = (e: MessageEvent): void => {
    const source = e.source as ServiceWorker | null
    if (e.data?.type === 'nodeterm:web-push-click' && source?.scriptURL === new URL(WEB_PUSH_WORKER, location.origin).href) receive(e.data.noticeId)
  }
  navigator.serviceWorker.addEventListener('message', message)
  const fragment = location.hash.match(/^#web-push=([a-f0-9-]{36})$/)
  if (fragment) { history.replaceState(null, '', location.pathname + location.search); receive(fragment[1]) }
  const off = subscribe(retry)
  return () => { disposed = true; epoch++; clearTimeout(timer); off(); navigator.serviceWorker.removeEventListener('message', message) }
}
