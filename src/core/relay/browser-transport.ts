import type { RelayTransport } from './relay-socket'

/** Browser socket only. Queues the initial encrypted handshake until open, with a hard cap. */
export function openBrowserRelayTransport(url: string, Socket = WebSocket): RelayTransport {
  const ws = new Socket(url)
  ws.binaryType = 'arraybuffer'
  const queue: (string | Uint8Array)[] = []
  let queued = 0, closed = false
  const closes = new Set<() => void>()
  const messages = new Set<(data: unknown) => void>()
  const close = () => {
    if (closed) return
    closed = true; queue.length = 0; queued = 0
    for (const cb of closes) cb()
    closes.clear(); messages.clear()
    ws.close()
  }
  ws.addEventListener('open', () => {
    if (closed) return
    for (const data of queue.splice(0)) ws.send(typeof data === 'string' ? data : new Uint8Array(data))
    queued = 0
  })
  ws.addEventListener('message', event => {
    if (!closed) for (const cb of messages) cb(event.data)
  })
  ws.addEventListener('close', close)
  ws.addEventListener('error', close)
  return {
    get bufferedAmount() { return queued + ws.bufferedAmount },
    send(data) {
      if (closed) return
      if (ws.readyState === Socket.OPEN) {
        if (ws.bufferedAmount > 8 * 1024 * 1024) { close(); return }
        ws.send(typeof data === 'string' ? data : new Uint8Array(data))
      } else {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data).length : data.length
        if (queued + bytes > 65536) { close(); return }
        queue.push(data); queued += bytes
      }
    },
    close,
    onMessage(cb) { if (!closed) messages.add(cb) },
    onClose(cb) { if (closed) queueMicrotask(cb); else closes.add(cb) }
  }
}
