import type { ContextApi, ContextWindowUsage } from '../../shared/types'
import type { RemoteMeterStart, RemoteMeterUpdate } from '../../shared/remote-meters'
import { IPC } from '../../shared/ipc'

interface Client {
  request(method: string, ...args: unknown[]): Promise<unknown>
  subscribe(channel: string, listener: (...args: any[]) => void): () => void
  onClose(callback: () => void): () => void
}

/** Uses the normal context event consumers; demand is shared across canvas/modal mounts. */
export function withRemoteMeters(client: Client, legacy: ContextApi): ContextApi {
  const listeners = new Set<(usage: ContextWindowUsage) => void>()
  const demands = new Map<string, { refs: number; stop(): void }>()
  const emit = (usage: ContextWindowUsage) => { for (const cb of listeners) cb(usage) }
  return { ...legacy,
    onUpdate: cb => {
      listeners.add(cb); const off = legacy.onUpdate(cb)
      return () => { listeners.delete(cb); off() }
    },
    watchRemote: nodeId => {
      const previous = demands.get(nodeId)
      if (previous) { previous.refs++; return () => { if (--previous.refs === 0) previous.stop() } }
      let stopped = false, lease: string | undefined, session: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const clear = () => {
        if (session) emit({ nodeId, sessionId: session, cleared: true, usedTokens: 0, windowTokens: 0,
          usedPercent: 0, model: null, updatedAt: Date.now() })
      }
      const release = (id: string) => { void client.request(IPC.contextRemoteRelease, id).catch(() => {}) }
      const offUpdate = client.subscribe(IPC.contextRemoteUpdate, (update: RemoteMeterUpdate) => {
        if (stopped || update.leaseId !== lease || update.nodeId !== nodeId) return
        session = update.sessionId
        if (update.status === 'ready' && update.usage) emit(update.usage)
        else clear()
        if (update.status === 'invalidated') lease = undefined // Next cycle obtains fresh authority.
      })
      const offClose = client.onClose(() => demand.stop())
      const demand = { refs: 1, stop: () => {
        if (stopped) return
        stopped = true; if (timer) clearTimeout(timer)
        offUpdate(); offClose(); clear()
        if (demands.get(nodeId) === demand) demands.delete(nodeId)
        if (lease) release(lease)
      } }
      demands.set(nodeId, demand)
      const cycle = async () => {
        if (stopped) return
        let delay = 2_000
        try {
          if (!lease) {
            const result = await client.request(IPC.contextRemoteStart, nodeId) as RemoteMeterStart
            if (result?.status === 'started') {
              if (stopped) { release(result.leaseId); return }
              lease = result.leaseId
            } else if (result?.status === 'unavailable' || result?.status === 'capacity') {
              // Mount can precede PTY attachment; reconnect/account changes also need a NEW proof.
              delay = 5_000
            } else { demand.stop(); return } // Local node stays on the legacy ensure path.
          }
          if (!stopped && lease) {
            const requested = lease
            const ok = await client.request(IPC.contextRemoteRenew, requested)
            if (!ok && lease === requested) { clear(); lease = undefined }
          }
          // One outstanding request, scheduled only after the previous response was consumed.
          if (!stopped) timer = setTimeout(() => { void cycle() }, delay)
        } catch { demand.stop() } // Old hosts/closed carriers never revive an old token.
      }
      void cycle()
      return () => { if (--demand.refs === 0) demand.stop() }
    }
  }
}
