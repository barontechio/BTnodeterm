/* Web Push only: deliberately no cache, fetch interception, background sync or credentials. */
self.addEventListener('push', event => {
  let value
  try { value = event.data.json() } catch { return }
  if (value?.v !== 1 || !/^[a-f0-9-]{36}$/.test(value.noticeId) || !['done', 'approval', 'question'].includes(value.kind)) return
  event.waitUntil(self.registration.showNotification('nodeterm', {
    body: value.kind === 'done' ? 'An agent has finished a turn.' : 'An agent needs your response.',
    tag: value.noticeId,
    data: { noticeId: value.noticeId }
  }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const id = event.notification.data?.noticeId
  if (!/^[a-f0-9-]{36}$/.test(id)) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = windows.find(c => { const u = new URL(c.url); return u.origin === self.location.origin && u.pathname === '/' })
    if (client) {
      await client.focus()
      client.postMessage({ type: 'nodeterm:web-push-click', noticeId: id })
    } else await self.clients.openWindow('/#web-push=' + encodeURIComponent(id))
  })())
})
