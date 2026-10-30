import { useEffect, useRef, useState } from 'react'
import type { WorktreeRecoveryApi, WorktreeRecoveryInspection, WorktreeRecoveryItem } from '../../shared/worktree-recovery'
import { claimOwnerConfirmation, releaseOwnerConfirmation } from '../lib/ownerConfirmationSlot'
import { ConfirmDialog } from './ConfirmDialog'

const TICKET = 'worktree-recovery-owner'
const visible = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** App-global physical-owner administration. Uses this host's default API, never the active relay
 * project's id or inherited local namespaces. Read-only refreshes never replay a recovery action. */
export function WorktreeRecoveryHost({ api: provided }: { api?: WorktreeRecoveryApi } = {}) {
  const candidate = provided ?? window.nodeTerminal?.worktree?.recovery
  const api = candidate && typeof candidate.list === 'function' && typeof candidate.inspect === 'function' && typeof candidate.keep === 'function'
    ? candidate : undefined
  const [records, setRecords] = useState<WorktreeRecoveryItem[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [inspection, setInspection] = useState<WorktreeRecoveryInspection | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const epoch = useRef(0); const keeping = useRef(false)
  const inspectionSequence = useRef(0)
  const reload = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    epoch.current++; let live = true; let reading = false; let unsupported = false
    setOpen(false); setRecords([]); setError(''); setMessage(''); setSelected('')
    const refresh = async () => {
      if (!api || !live || reading || unsupported) return
      reading = true
      try {
        const result = await api.list()
        if (!live) return
        if (result == null) { unsupported = true; setRecords([]); setError(''); return }
        if (!result.ok) { setError(result.error); setRecords([]); return }
        const pending = result.records.filter((row) => row.phase !== 'recovered')
        setError(''); setRecords(pending)
        setSelected((id) => pending.some((row) => row.id === id) ? id : pending[0]?.id ?? '')
      } catch { if (live) setError('Recovery status could not be read. Refresh before continuing.') }
      finally { reading = false }
    }
    reload.current = refresh; void refresh()
    const timer = api ? setInterval(() => { void refresh() }, 15_000) : undefined
    const focus = () => { void refresh() }; window.addEventListener('focus', focus)
    return () => {
      live = false; epoch.current++; clearInterval(timer); window.removeEventListener('focus', focus)
      if (reload.current === refresh) reload.current = null
      releaseOwnerConfirmation(TICKET)
    }
  }, [api])
  useEffect(() => {
    let live = true; const sequence = ++inspectionSequence.current; setInspection(null)
    if (open && selected && api) void api.inspect(selected).then((result) => {
      if (live && sequence === inspectionSequence.current) setInspection(result)
    }).catch(() => { if (live && sequence === inspectionSequence.current) setInspection({ ok: false, error: 'The checkout could not be inspected. Refresh its status.' }) })
    return () => { live = false; inspectionSequence.current++ }
  }, [api, open, selected])
  const close = () => { releaseOwnerConfirmation(TICKET); setOpen(false) }
  const row = records.find((record) => record.id === selected)
  const canKeep = !message && !error && row?.phase === 'prepared' && inspection?.ok === true && inspection.status === 'kept' &&
    JSON.stringify(inspection.record) === JSON.stringify(row)
  const keep = async () => {
    if (!api || !row || !canKeep || keeping.current) return
    keeping.current = true; setBusy(true); const started = epoch.current
    try {
      const result = await api.keep(row.id)
      if (started !== epoch.current) return
      setMessage(result.ok ? result.message : result.error); setInspection(null)
      await reload.current?.()
    } catch {
      if (started === epoch.current) {
        setMessage('Recovery may have completed. Refresh its status before another action.'); setInspection(null)
      }
    } finally { keeping.current = false; if (started === epoch.current) setBusy(false) }
  }
  if (!api || (!open && !records.length && !error)) return null
  const status = inspection?.ok ? inspection.status === 'kept'
    ? 'The original checkout and branch are present. Keep them to release this pending recovery.'
    : 'The original checkout could not be verified. Keep this recovery record while inspecting the files.'
    : inspection?.error ?? (selected ? 'Checking the existing checkout…' : 'No pending recovery records.')
  return <>
    <button className="confirm__btn" style={{ position: 'fixed', top: 52, right: 16, zIndex: 100 }} onClick={() => {
      if (claimOwnerConfirmation(TICKET)) { setMessage(''); setOpen(true) }
    }}>Worktree recovery{records.length ? ` (${records.length})` : ''}</button>
    {open && <ConfirmDialog message={visible(busy ? 'Keeping the existing checkout…' : message || error || status)}
      body={row && <div className="confirm__msg space-y-2" style={{ overflowWrap: 'anywhere' }}>
        <p>Recovery on this host</p>
        <select aria-label="Pending recovery" value={selected} disabled={busy} onChange={(event) => {
          setMessage(''); setSelected(event.target.value)
        }} style={{ width: '100%' }}>
          {records.map((record) => <option key={record.id} value={record.id}>{visible(record.branch)} — {visible(record.path)}</option>)}
        </select>
        <p>Branch: {visible(row.branch)}</p><p>Directory: {visible(row.path)}</p>
        <button className="confirm__btn" disabled={busy} onClick={() => {
          setMessage(''); setInspection(null)
          const started = epoch.current; const sequence = ++inspectionSequence.current
          const current = () => started === epoch.current && sequence === inspectionSequence.current
          void reload.current?.().then(async () => {
            if (!current()) return
            const result = await api.inspect(row.id)
            if (current()) setInspection(result)
          }).catch(() => { if (current()) setInspection({ ok: false, error: 'The checkout could not be inspected. Refresh its status.' }) })
        }}>Refresh status</button>
      </div>}
      alert={!canKeep || busy} confirmLabel={canKeep && !busy ? 'Keep existing checkout' : 'Close'} cancelLabel="Close"
      danger={false} enterConfirms={false} autoFocusButtons={false}
      onConfirm={() => { if (busy) return; if (canKeep) void keep(); else close() }} onCancel={close} />}
  </>
}
