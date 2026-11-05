import nacl from 'tweetnacl'
import { genKeyPair, publicKeyToB64, publicKeyFromB64, secretKeyFromB64 } from '../../../core/relay/e2ee'
import { decodeJoinCode, type JoinCode } from '../../../core/relay/join-code'

export interface BrowserTeamRecord {
  v: 1
  hostId: string
  code: string
  hostKey: string
  deviceId: string
  publicKey: string
  secretKey: string
  deviceToken: string | null
  approvedAt: string | null
}
function validate(value: BrowserTeamRecord): BrowserTeamRecord {
  const code = decodeJoinCode(value?.code)
  if (value?.v !== 1 || !code || code.hostId !== value.hostId || code.hostPublicKeyB64 !== value.hostKey ||
    !/^[a-f0-9-]{36}$/.test(value.deviceId) ||
    value.deviceToken !== null && (typeof value.deviceToken !== 'string' || !value.deviceToken || value.deviceToken.length > 8192) ||
    value.approvedAt !== null && (typeof value.approvedAt !== 'string' || !Number.isFinite(Date.parse(value.approvedAt)))) throw new Error('[E_JOIN_KEY_LOCKED] Invalid browser team identity')
  publicKeyFromB64(value.publicKey)
  const derived = nacl.box.keyPair.fromSecretKey(secretKeyFromB64(value.secretKey))
  if (publicKeyToB64(derived.publicKey) !== value.publicKey || publicKeyToB64(derived.secretKey) !== value.secretKey) throw new Error('[E_JOIN_KEY_LOCKED] Corrupt browser team key')
  return value
}

/** One IndexedDB transaction is the publication boundary, not request.onsuccess. */
export class BrowserTeamStore {
  private opening?: Promise<IDBDatabase>
  constructor(private factory?: IDBFactory, private name = 'nodeterm-browser-teams-v1') {}
  private db(): Promise<IDBDatabase> {
    return this.opening ??= new Promise((resolve, reject) => {
      let abandoned = false
      const request = (this.factory ?? indexedDB).open(this.name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('teams', { keyPath: 'hostId' })
      request.onerror = () => { this.opening = undefined; reject(request.error) }
      request.onblocked = () => { abandoned = true; this.opening = undefined; reject(new Error('[E_JOIN_KEY_LOCKED] Close other team tabs to update storage')) }
      request.onsuccess = () => {
        const db = request.result
        if (abandoned) { db.close(); return }
        db.onversionchange = () => { db.close(); this.opening = undefined }
        resolve(db)
      }
    })
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, finish: (result: T) => void) => void): Promise<T> {
    const db = await this.db()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('teams', mode, { durability: 'strict' })
      let result: T
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('[E_JOIN_KEY_LOCKED] Browser team storage aborted'))
      tx.onerror = () => reject(tx.error)
      try { action(tx.objectStore('teams'), value => { result = value }) } catch (error) { tx.abort(); reject(error) }
    })
  }
  async list(): Promise<BrowserTeamRecord[]> {
    return this.transaction('readonly', (store, finish) => {
      const read = store.getAll()
      read.onsuccess = () => {
        try { finish(read.result.map(validate)) } catch { store.transaction.abort() }
      }
    })
  }
  /** Writeability and stable per-team key are committed before any token mint. */
  async prepare(code: JoinCode, text: string): Promise<BrowserTeamRecord> {
    return this.transaction('readwrite', (store, finish) => {
      const read = store.get(code.hostId)
      read.onsuccess = () => {
        try {
          let record: BrowserTeamRecord
          if (read.result) {
            record = validate(read.result)
            if (record.hostKey !== code.hostPublicKeyB64) throw new Error('host key changed')
            record = { ...record, code: text }
          } else {
            const keys = genKeyPair()
            record = { v: 1, hostId: code.hostId, code: text, hostKey: code.hostPublicKeyB64,
              deviceId: crypto.randomUUID(), publicKey: publicKeyToB64(keys.publicKey), secretKey: publicKeyToB64(keys.secretKey),
              deviceToken: null, approvedAt: null }
          }
          store.put(record); finish(record)
        } catch { store.transaction.abort() }
      }
    })
  }
  async update(expected: BrowserTeamRecord, patch: Pick<Partial<BrowserTeamRecord>, 'deviceToken' | 'approvedAt'>, current: () => boolean): Promise<BrowserTeamRecord> {
    return this.transaction('readwrite', (store, finish) => {
      const read = store.get(expected.hostId)
      read.onsuccess = () => {
        try {
          const record = validate(read.result)
          if (!current() || record.deviceId !== expected.deviceId || record.hostKey !== expected.hostKey || record.publicKey !== expected.publicKey) throw new Error('team identity changed')
          const next = validate({ ...record, ...patch })
          store.put(next); finish(next)
        } catch { store.transaction.abort() }
      }
    })
  }
  async remove(hostId: string): Promise<void> {
    return this.transaction('readwrite', (store, finish) => { store.delete(hostId); finish(undefined) })
  }
  close(): void { void this.opening?.then(db => db.close(), () => {}); this.opening = undefined }
}
