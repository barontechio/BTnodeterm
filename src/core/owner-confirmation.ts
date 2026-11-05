import { createHash, randomBytes } from 'node:crypto'
import { stableStringify } from '../shared/canvas-mutations'
import { CONTROL_REQUEST_TIMEOUT_MS } from '../shared/control-confirm'
import { IPC } from '../shared/ipc'
import type { OwnerAction, OwnerConfirmation, OwnerConfirmationAnswer } from '../shared/owner-confirmation'
import type { CorePlatform } from './platform'

export type ConfirmationRefusal = 'owner-unavailable' | 'busy' | 'denied' | 'expired' | 'cancelled'
export type OwnerPermit = { ok: false; reason: ConfirmationRefusal } |
  /** Recheck current() in a destination FIFO after consumption; queue wait can outlive the owner. */
  { ok: true; consume(): Promise<boolean>; current(): boolean; cancel(): void }
export interface ConfirmationIntent {
  action: OwnerAction
  requester: OwnerConfirmation['requester']
  /** Exact normalized arguments, target/session identity and authorization policy snapshot. Host-only. */
  binding: Record<string, unknown>
  message: string
  details?: string
  confirmLabel: string
  danger?: boolean
  /** Re-read target/session identity and authorization immediately before consuming the permit. */
  checkCurrent(): boolean | Promise<boolean>
}
interface Pending {
  id: string
  key: string
  proof: string
  expiresAt: number
  recipients: Map<number, { epoch: string; token: string }>
  approvedBy?: number
  consuming?: boolean
  checkCurrent: ConfirmationIntent['checkCurrent']
  timer: ReturnType<typeof setTimeout>
  resolve(permit: OwnerPermit): void
}
const nonce = () => randomBytes(24).toString('base64url')

/** Pending intent stays on the host. Decisions grant a short-lived, single-use execution permit. */
export class OwnerConfirmationBroker {
  private clients = new Map<number, string>()
  private pending = new Map<string, Pending>()
  private stopped = false

  constructor(private readonly platform: CorePlatform, private readonly now: () => number = Date.now) {}

  private eligible(id: number, epoch: string): boolean {
    return !this.stopped && this.clients.get(id) === epoch && this.platform.clientIds().includes(id) &&
      this.platform.isOwnerClient?.(id) === true
  }
  connect(id: number): string {
    if (this.stopped || !this.platform.clientIds().includes(id) || !this.platform.isOwnerClient?.(id)) throw new Error('confirmation-owner-required')
    this.forgetClient(id)
    const epoch = nonce(); this.clients.set(id, epoch); return epoch
  }
  disconnect(id: number, epoch: string): void { if (this.clients.get(id) === epoch) this.forgetClient(id) }
  forgetClient(id: number): void {
    this.clients.delete(id)
    for (const pending of [...this.pending.values()]) {
      pending.recipients.delete(id)
      if (pending.approvedBy === id || pending.recipients.size === 0) this.finish(pending, 'cancelled')
    }
  }

  private dismiss(pending: Pending): void {
    for (const [id, recipient] of pending.recipients) {
      if (this.eligible(id, recipient.epoch)) this.platform.sendTo(id, IPC.ownerConfirmationDismiss, pending.id)
    }
  }
  private drop(pending: Pending): void {
    this.pending.delete(pending.id); clearTimeout(pending.timer)
    if (pending.approvedBy === undefined) this.dismiss(pending)
  }
  private finish(pending: Pending, reason: ConfirmationRefusal): void {
    this.drop(pending); pending.resolve({ ok: false, reason })
  }

  request(intent: ConfirmationIntent): Promise<OwnerPermit> {
    const recipients = new Map<number, { epoch: string; token: string }>()
    for (const [id, epoch] of this.clients) if (this.eligible(id, epoch)) recipients.set(id, { epoch, token: nonce() })
    if (!recipients.size) return Promise.resolve({ ok: false, reason: 'owner-unavailable' })
    const key = `${intent.requester.nodeId}\0${intent.action}`
    if (this.pending.size >= 32 || [...this.pending.values()].some((p) => p.key === key)) return Promise.resolve({ ok: false, reason: 'busy' })
    let binding: string
    try {
      const { checkCurrent: _check, ...snapshot } = intent
      if (typeof intent.checkCurrent !== 'function') return Promise.resolve({ ok: false, reason: 'cancelled' })
      binding = stableStringify(structuredClone(snapshot))
    } catch { return Promise.resolve({ ok: false, reason: 'cancelled' }) }
    if (Buffer.byteLength(binding) > 256 * 1024 || (intent.details?.length ?? 0) > 128 * 1024) return Promise.resolve({ ok: false, reason: 'cancelled' })
    const id = nonce(); const expiresAt = this.now() + CONTROL_REQUEST_TIMEOUT_MS
    const proof = createHash('sha256').update(binding).digest('hex')
    return new Promise((resolve) => {
      const pending: Pending = { id, key, proof, expiresAt, recipients, resolve, checkCurrent: intent.checkCurrent,
        timer: setTimeout(() => this.finish(pending, 'expired'), CONTROL_REQUEST_TIMEOUT_MS) }
      pending.timer.unref()
      this.pending.set(id, pending)
      for (const [clientId, recipient] of recipients) {
        const message: OwnerConfirmation = { id, token: recipient.token, proof, expiresAt, remainingMs: Math.max(0, expiresAt - this.now()),
          action: intent.action, requester: structuredClone(intent.requester), message: intent.message,
          ...(intent.details !== undefined ? { details: intent.details } : {}),
          confirmLabel: intent.confirmLabel, danger: intent.danger === true }
        this.platform.sendTo(clientId, IPC.ownerConfirmationRequest, message)
      }
    })
  }

  decide(id: number, answer: OwnerConfirmationAnswer): boolean {
    if (!['approve', 'deny', 'busy'].includes(answer.answer)) return false
    const pending = this.pending.get(answer.id)
    const recipient = pending?.recipients.get(id)
    if (!pending || pending.approvedBy !== undefined || !recipient || !this.eligible(id, recipient.epoch) ||
      recipient.token !== answer.token || pending.proof !== answer.proof) return false
    if (this.now() >= pending.expiresAt) { this.finish(pending, 'expired'); return false }
    if (answer.answer === 'busy') {
      pending.recipients.delete(id)
      if (!pending.recipients.size) this.finish(pending, 'busy')
      return true
    }
    if (answer.answer === 'deny') { this.finish(pending, 'denied'); return true }
    pending.approvedBy = id
    this.dismiss(pending)
    let consumed = false
    let cancelled = false
    pending.resolve({ ok: true, consume: async () => {
      if (pending.consuming) return false
      const current = this.pending.get(pending.id)
      if (current !== pending || this.now() >= pending.expiresAt || !this.eligible(id, recipient.epoch)) {
        if (current === pending) this.finish(pending, 'cancelled')
        return false
      }
      pending.consuming = true
      let valid = false
      try { valid = (await pending.checkCurrent()) === true } catch { /* a failed proof read is a refusal */ }
      if (!valid || this.pending.get(pending.id) !== pending || this.now() >= pending.expiresAt || !this.eligible(id, recipient.epoch)) {
        if (this.pending.get(pending.id) === pending) this.finish(pending, 'cancelled')
        return false
      }
      consumed = true
      this.drop(pending)
      return true
    }, current: () => consumed && !cancelled && this.now() < pending.expiresAt && this.eligible(id, recipient.epoch),
    cancel: () => { cancelled = true; if (this.pending.get(pending.id) === pending) this.finish(pending, 'cancelled') } })
    return true
  }

  dispose(): void {
    for (const pending of [...this.pending.values()]) this.finish(pending, 'cancelled')
    this.stopped = true
    this.clients.clear()
  }
}

export function registerOwnerConfirmationIpc(platform: CorePlatform, broker: OwnerConfirmationBroker): void {
  platform.handleWithSender(IPC.ownerConfirmationConnect, (id) => broker.connect(id))
  platform.handleWithSender(IPC.ownerConfirmationDisconnect, (id, epoch: unknown) => { if (typeof epoch === 'string') broker.disconnect(id, epoch) })
  platform.handleWithSender(IPC.ownerConfirmationDecide, (id, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false
    const answer = raw as Partial<OwnerConfirmationAnswer>
    if (typeof answer.id !== 'string' || typeof answer.token !== 'string' || typeof answer.proof !== 'string' ||
      !['approve', 'deny', 'busy'].includes(answer.answer ?? '')) return false
    return broker.decide(id, answer as OwnerConfirmationAnswer)
  })
}
