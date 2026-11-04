import { connectRelayClient, type RelayClientSession } from '../../../core/relay/relay-client'
import { decodeJoinCode, allowedEndpoint } from '../../../core/relay/join-code'
import { publicKeyFromB64, secretKeyFromB64 } from '../../../core/relay/e2ee'
import { openBrowserRelayTransport } from '../../../core/relay/browser-transport'
import type { DeviceMintResult, JoinMintResult } from '../../../core/relay/join-token'
import type { RelayClientApi, RelayHostedApi, RelayClosedReason } from '../../../shared/types'
import { BROWSER_JOIN_DEVICE, BROWSER_JOIN_TOKEN } from '../../../shared/browser-join'
import { relayPtyDataKey } from '../../../shared/relay-pty-channel'
import { BrowserTeamStore, type BrowserTeamRecord } from './store'
import { markBrowserTeamConnection, forgetBrowserTeamConnection } from './connections'

type Listener = (...args: any[]) => void
interface Entry {
  hostId: string; session?: RelayClientSession; closed: boolean; approved: boolean
  sas?: string | null; reason?: RelayClosedReason; release(): void
  listeners: Map<string, Set<Listener>>
}
export interface BrowserJoinBroker { request(method: string, ...args: unknown[]): Promise<unknown> }
export function createBrowserTeamJoin(broker: BrowserJoinBroker, options: {
  store?: BrowserTeamStore; locks?: LockManager; channel?: BroadcastChannel
} = {}): {
  relayClient: RelayClientApi; relayHosted: RelayHostedApi
  onPtyData(key: string, listener: (data: string) => void): () => void
  dispose(): void
} {
  const store = options.store ?? new BrowserTeamStore()
  const entries = new Map<string, Entry>()
  const pty = new Map<string, Set<(data: string) => void>>()
  const blocked = new Set<string>()
  let disposed = false
  let channel: BroadcastChannel | undefined = options.channel
  const emit = (entry: Entry, event: string, ...args: unknown[]) => {
    for (const listener of entry.listeners.get(event) ?? []) listener(...args)
  }
  const close = (id: string, reason?: RelayClosedReason) => {
    const entry = entries.get(id)
    if (!entry || entry.closed) return
    entry.closed = true; entry.approved = false; entry.reason = reason
    entry.session?.close(); entry.session = undefined
    entry.release(); emit(entry, 'closed', reason)
    entry.listeners.clear()
    for (const key of pty.keys()) if (key.startsWith(`relay:${id}:`)) pty.delete(key)
  }
  const closeHost = (hostId: string) => { for (const [id, entry] of entries) if (entry.hostId === hostId) close(id, 'removed') }
  const listen = (id: string, event: string, listener: Listener): (() => void) => {
    const entry = entries.get(id)
    if (!entry) return () => {}
    let active = true
    const guarded: Listener = (...args) => { if (active) listener(...args) }
    if (event === 'closed' && entry.closed) queueMicrotask(() => guarded(entry.reason))
    else if (!entry.closed) {
      const set = entry.listeners.get(event) ?? new Set<Listener>()
      entry.listeners.set(event, set); set.add(guarded)
      if (event === 'approved' && entry.approved) queueMicrotask(() => { if (!entry.closed) guarded() })
      if (event === 'sas' && entry.sas !== undefined) queueMicrotask(() => { if (!entry.closed) guarded(entry.sas) })
    }
    return () => { active = false; entry.listeners.get(event)?.delete(guarded) }
  }
  const ensureChannel = () => {
    if (channel) return
    channel = new BroadcastChannel('nodeterm-browser-team-revocation-v1')
    channel.onmessage = event => {
      if (event.data?.type === 'forget' && typeof event.data.hostId === 'string') closeHost(event.data.hostId)
    }
  }
  const relayClient: RelayClientApi = {
    async connect(text) {
      if (disposed) throw new Error('[E_JOIN_REFUSED] Browser connection closed')
      const code = decodeJoinCode(text)
      if (!code) throw new Error('[E_JOIN_BAD_CODE] Paste a hosted team invite code')
      const locks = options.locks ?? navigator.locks
      if (!locks || typeof indexedDB === 'undefined' || typeof BroadcastChannel === 'undefined') throw new Error('[E_JOIN_KEY_LOCKED] Secure browser storage and Web Locks are required')
      if (blocked.has(code.hostId)) throw new Error('[E_JOIN_KEY_LOCKED] The team pin could not be saved; reload after fixing browser storage')
      if ([...entries.values()].filter(entry => !entry.closed).length >= 8) throw new Error('[E_JOIN_BUSY] Too many browser team connections')
      ensureChannel()
      for (const [oldId, entry] of entries) if (entries.size >= 32 && entry.closed) { entries.delete(oldId); forgetBrowserTeamConnection(oldId) }
      const id = `browser-team-${crypto.randomUUID()}`
      let release!: () => void
      const stopped = new Promise<void>(resolve => { release = resolve })
      const entry: Entry = { hostId: code.hostId, closed: false, approved: false, release, listeners: new Map() }
      entries.set(id, entry); markBrowserTeamConnection(id)
      const current = () => !disposed && !entry.closed
      let ready!: () => void, fail!: (error: unknown) => void
      const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject })
      void locks.request(`nodeterm-team:${code.hostId}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('[E_JOIN_BUSY] This team is already connected in another tab')
        if (!current()) throw new Error('[E_JOIN_REFUSED] Join cancelled')
        let record = await store.prepare(code, text)
        if (!current()) throw new Error('[E_JOIN_REFUSED] Join cancelled')
        let revocation: Promise<unknown> = Promise.resolve()
        const update = async (patch: Pick<Partial<BrowserTeamRecord>, 'deviceToken' | 'approvedAt'>) => {
          record = await store.update(record, patch, current)
          if (!current()) throw new Error('[E_JOIN_REFUSED] Join cancelled')
        }
        const mint = async () => {
          if (!current()) throw new Error('[E_JOIN_REFUSED] Join cancelled')
          const result = await broker.request(BROWSER_JOIN_DEVICE, { code: text, deviceId: record.deviceId, label: 'Browser' }) as DeviceMintResult
          if (!result.ok) throw new Error(`[${result.kind === 'network' ? 'E_JOIN_NETWORK' : result.kind === 'throttled' ? 'E_JOIN_THROTTLED' : 'E_JOIN_RATE'}] Could not register this browser for the team`)
          // Never proceed to the relay with a device token or identity that was not committed.
          try { await update({ deviceToken: result.deviceToken }) }
          catch (error) { blocked.add(code.hostId); throw error }
        }
        let minted = false
        if (!record.deviceToken) { await mint(); minted = true }
        let token = await broker.request(BROWSER_JOIN_TOKEN, record.deviceToken) as JoinMintResult
        if (!token.ok && token.kind === 'bad-token' && !minted) { await mint(); token = await broker.request(BROWSER_JOIN_TOKEN, record.deviceToken) as JoinMintResult }
        if (!token.ok) {
          // Keep the rejected token durable: only explicit Forget/Remove and rejoin may mint anew.
          if (token.kind === 'revoked') await update({ approvedAt: null })
          throw new Error(`[${token.kind === 'revoked' ? 'E_JOIN_REVOKED' : token.kind === 'bad-token' ? 'E_JOIN_REFUSED' : token.kind === 'throttled' ? 'E_JOIN_THROTTLED' : 'E_JOIN_NETWORK'}] Team connection refused`)
        }
        if (!current() || token.pairingToken.length > 8192 || !allowedEndpoint(token.relayEndpoint)) throw new Error('[E_JOIN_REFUSED] Invalid relay destination or cancelled join')
        const url = new URL(token.relayEndpoint)
        if (url.username || url.password || url.hash) throw new Error('[E_JOIN_REFUSED] Invalid relay destination')
        url.searchParams.set('token', token.pairingToken)
        const session = connectRelayClient({
          url: token.relayEndpoint, token: token.pairingToken, hostKeyB64: record.hostKey,
          ourKeys: { publicKey: publicKeyFromB64(record.publicKey), secretKey: secretKeyFromB64(record.secretKey) },
          transport: openBrowserRelayTransport(url.href), autoApprove: record.approvedAt !== null,
          requireDurablePin: true,
          pins: { record: async approval => {
            if (approval.peerKeyB64 !== record.hostKey || !approval.localConfirmed || !approval.remoteConfirmed || !current()) throw new Error('invalid approval')
            try { await update({ approvedAt: new Date().toISOString() }) }
            catch (error) { blocked.add(code.hostId); throw error }
          } },
          onSas: session => { entry.sas = session.sas(); emit(entry, 'sas', entry.sas) },
          onApproved: () => { if (current()) { entry.approved = true; emit(entry, 'approved') } },
          onFrame: json => { if (current() && entry.approved) emit(entry, 'frame', json) },
          onPtyData: (sessionId, data) => {
            if (current() && entry.approved) for (const listener of pty.get(relayPtyDataKey(id, sessionId)) ?? []) listener(data)
          },
          onDenied: reason => {
            blocked.add(code.hostId)
            revocation = store.update(record, { approvedAt: null }, () => !disposed).then(() => blocked.delete(code.hostId), () => {})
            close(id, reason)
          },
          onClose: () => close(id)
        })
        if (!current()) session.close()
        else entry.session = session
        ready()
        await stopped
        await revocation
      }).catch(error => { close(id); fail(error) })
      await started
      return id
    },
    onSas: (id, listener) => listen(id, 'sas', listener),
    onApproved: (id, listener) => listen(id, 'approved', listener),
    onFrame: (id, listener) => listen(id, 'frame', listener),
    onClosed: (id, listener) => listen(id, 'closed', listener),
    confirm: id => { const entry = entries.get(id); if (entry && !entry.closed) entry.session?.confirm() },
    send: (id, frame) => { const entry = entries.get(id); if (entry?.approved && !entry.closed && frame.length <= 1024 * 1024) entry.session?.send(frame) },
    disconnect: id => close(id)
  }
  return {
    relayClient,
    relayHosted: {
      bookmarks: async () => (await store.list()).map(record => ({ hostId: record.hostId, label: decodeJoinCode(record.code)!.label,
        code: record.code, approved: record.approvedAt !== null && !blocked.has(record.hostId) })),
      async removeBookmark(hostId) {
        closeHost(hostId); ensureChannel(); channel!.postMessage({ type: 'forget', hostId })
        await store.remove(hostId); blocked.delete(hostId)
      }
    },
    onPtyData(key, listener) {
      const set = pty.get(key) ?? new Set(); pty.set(key, set); set.add(listener)
      return () => { set.delete(listener); if (!set.size) pty.delete(key) }
    },
    dispose() {
      disposed = true
      for (const id of entries.keys()) { close(id); forgetBrowserTeamConnection(id) }
      entries.clear(); pty.clear(); channel?.close(); store.close()
    }
  }
}
