import { useEffect, useRef, useState } from 'react'
import type { OwnerConfirmation } from '../../shared/owner-confirmation'
import { CONTROL_REQUEST_TIMEOUT_MS } from '../../shared/control-confirm'
import { ConfirmDialog } from './ConfirmDialog'
import { claimOwnerConfirmation, releaseOwnerConfirmation } from '../lib/ownerConfirmationSlot'

function visibleText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** One owner dialog; an unsolicited request never gains keyboard approval or button focus. */
export function OwnerConfirmationHost() {
  const [head, setHead] = useState<OwnerConfirmation | null>(null)
  const current = useRef<OwnerConfirmation | null>(null)
  const clear = (id: string) => {
    releaseOwnerConfirmation(id)
    if (current.current?.id === id) { current.current = null; setHead(null) }
  }
  useEffect(() => {
    const api = window.nodeTerminal.ownerConfirmation
    if (!api) return
    let alive = true
    let epoch = ''
    const request = api.onRequest((message) => {
      if (!alive) return
      if (message.remainingMs <= 0 || !claimOwnerConfirmation(message.id)) {
        void api.decide({ id: message.id, token: message.token, proof: message.proof, answer: 'busy' }).catch(() => {})
        return
      }
      const local = { ...message, expiresAt: Date.now() + Math.min(message.remainingMs, CONTROL_REQUEST_TIMEOUT_MS) }
      current.current = local; setHead(local)
    })
    const dismiss = api.onDismiss(clear)
    void api.connect().then((value) => {
      if (alive) epoch = value
      else void api.disconnect(value).catch(() => {})
    }).catch(() => {}) // An older host has no broker; legacy Desktop dialogs retain their path.
    return () => {
      alive = false; request(); dismiss()
      if (current.current) { releaseOwnerConfirmation(current.current.id); current.current = null }
      if (epoch) void api.disconnect(epoch).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (!head) return
    const timer = setTimeout(() => clear(head.id), Math.max(0, head.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [head])
  if (!head) return null
  const answer = (approved: boolean) => {
    if (current.current?.id !== head.id || head.expiresAt <= Date.now()) { clear(head.id); return }
    clear(head.id)
    void window.nodeTerminal.ownerConfirmation?.decide({ id: head.id, token: head.token, proof: head.proof,
      answer: approved ? 'approve' : 'deny' }).catch(() => {})
  }
  return <ConfirmDialog key={head.id} message={visibleText(head.message)} confirmLabel={head.confirmLabel}
    cancelLabel="Decline" danger={head.danger} enterConfirms={false} autoFocusButtons={false}
    body={<div className="confirm__msg space-y-2">
      <p>{visibleText(head.requester.title)} requests this action.</p>
      {head.details && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words" style={{ unicodeBidi: 'bidi-override', direction: 'ltr' }}>{visibleText(head.details)}</pre>}
    </div>}
    onConfirm={() => answer(true)} onCancel={() => answer(false)} />
}
