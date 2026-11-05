import { randomUUID } from 'node:crypto'
import type { AccountOwner } from '../owner-lifetimes'
import type { SshPassphraseRequest } from '../../shared/types'
import { PROMPT_WAIT_MS } from './ssh-project-limits'

export interface PassphraseRecipient {
  owner: AccountOwner
  request(message: SshPassphraseRequest): boolean
  dismiss(requestId: string): void
}
export type PassphraseOutcome = string | null | undefined
type Pending = { recipient: PassphraseRecipient; expiresAt: number; timer: ReturnType<typeof setTimeout>;
  unsubscribe(): void; resolve(value: PassphraseOutcome): void }

/** Secret answers go once to the requesting SSH transport, never to another UI or a saved store. */
export class PassphrasePrompts {
  private pending = new Map<string, Pending>()
  private disposed = false
  constructor(private readonly now: () => number = () => Date.now()) {}

  request(input: Omit<SshPassphraseRequest, 'requestId'>, recipient: PassphraseRecipient | null): Promise<PassphraseOutcome> {
    if (this.disposed || !recipient?.owner.active() || this.pending.size >= 32) return Promise.resolve(undefined)
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const pending: Pending = { recipient, expiresAt: this.now() + PROMPT_WAIT_MS, resolve, unsubscribe: () => {},
        timer: setTimeout(() => this.finish(requestId, undefined), PROMPT_WAIT_MS) }
      pending.timer.unref?.()
      this.pending.set(requestId, pending)
      try { pending.unsubscribe = recipient.owner.onDeparture(() => this.finish(requestId, undefined)) }
      catch { this.finish(requestId, undefined); return }
      if (!this.pending.has(requestId)) { pending.unsubscribe(); return }
      let sent = false
      try { sent = recipient.request({ ...input, requestId }) === true } catch { /* dead UI */ }
      if (!sent) this.finish(requestId, undefined)
    })
  }
  submit(owner: AccountOwner, requestId: string, value: string | null): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.recipient.owner !== owner || !owner.active()) return false
    if (this.now() >= pending.expiresAt) { this.finish(requestId, undefined); return false }
    if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024)) return false
    this.finish(requestId, value); return true
  }
  private finish(id: string, value: PassphraseOutcome): void {
    const pending = this.pending.get(id); if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer)
    try { pending.unsubscribe() } catch { /* releasing the transport must still finish */ }
    try { pending.recipient.dismiss(id) } catch { /* release the transport even if the UI died */ }
    pending.resolve(value)
  }
  dispose(): void { this.disposed = true; for (const id of [...this.pending.keys()]) this.finish(id, undefined) }
}
