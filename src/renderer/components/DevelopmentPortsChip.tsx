import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DevelopmentPreviewApi, DevelopmentPreviewRecord } from '@shared/development-preview'

/** Owner-only opt-in gateway. A joined relay API never supplies this namespace. */
export function DevelopmentPortsChip({ api, projectId, nodeId }: {
  api: DevelopmentPreviewApi; projectId: string; nodeId: string
}): React.JSX.Element | null {
  const [supported, setSupported] = useState(false)
  const [visible, setVisible] = useState(false)
  const [records, setRecords] = useState<DevelopmentPreviewRecord[]>([])
  const [links, setLinks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const working = useRef(false)
  const held = useRef(new Set<string>())
  useEffect(() => {
    const epoch = ++generation.current
    setSupported(false); working.current = false; setVisible(false); setRecords([]); setLinks({})
    void api.status().then(result => { if (generation.current === epoch) setSupported(result.supported) }).catch(() => {})
    return () => {
      generation.current++
      for (const origin of held.current) void api.stop(origin).catch(() => {})
      held.current.clear()
    }
  }, [api, projectId, nodeId])
  if (!supported) return null
  const list = async () => {
    if (working.current) return
    working.current = true
    const epoch = generation.current
    setVisible(true); setBusy(true); setError('')
    try { const rows = await api.list({ projectId, nodeId }); if (epoch === generation.current) setRecords(rows) }
    catch (e) { if (epoch === generation.current) setError(String(e)) }
    finally { if (epoch === generation.current) { working.current = false; setBusy(false) } }
  }
  const open = async (id: string) => {
    if (working.current) return
    working.current = true
    const epoch = generation.current
    setBusy(true); setError('')
    try {
      const origin = await api.open(id)
      if (epoch !== generation.current) { void api.stop(origin).catch(() => {}); return }
      held.current.add(origin); setLinks(current => ({ ...current, [id]: origin }))
    } catch (e) { if (epoch === generation.current) setError(`Preview could not be confirmed: ${String(e)}`) }
    finally { if (epoch === generation.current) { working.current = false; setBusy(false) } }
  }
  const stop = async (id: string, origin: string) => {
    if (working.current) return
    working.current = true
    const epoch = generation.current
    setBusy(true); setError('')
    try { await api.stop(origin); if (epoch !== generation.current) return; held.current.delete(origin); setLinks(current => { const next = { ...current }; delete next[id]; return next }) }
    catch { if (epoch === generation.current) setError('The stop could not be confirmed. The preview still expires automatically.') }
    finally { if (epoch === generation.current) { working.current = false; setBusy(false) } }
  }
  return <>
    <button className="nodrag nopan rounded px-1 text-xs" title="Open an approved development preview" onClick={() => void list()}>Preview</button>
    {visible && createPortal(<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" onMouseDown={event => event.stopPropagation()}>
      <section role="dialog" aria-modal="true" aria-label="Development previews" className="w-[440px] rounded-lg bg-neutral-900 p-5 text-sm text-white shadow-xl">
        <h2 className="mb-2 text-base font-semibold">Development previews</h2>
        <p className="mb-4 text-neutral-300">Only services approved by the server operator appear here. Previews expire within five minutes. Cookies, browser storage and service workers are unavailable.</p>
        {records.map(record => <div key={record.id} className="mb-2 flex items-center gap-3">
          <span className="grow">{record.label}</span>
          {links[record.id] ? <><a className="underline" href={links[record.id]} target="_blank" rel="noopener noreferrer">Open preview</a><button disabled={busy} onClick={() => void stop(record.id, links[record.id])}>Stop</button></> :
            <button disabled={busy} onClick={() => void open(record.id)}>Allow preview</button>}
        </div>)}
        {!busy && !records.length && <p>No approved live service was found for this node.</p>}
        {busy && <p role="status">Checking the service…</p>}
        {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
        <button className="mt-4 rounded border px-3 py-1" onClick={() => setVisible(false)}>Close</button>
      </section>
    </div>, document.body)}
  </>
}
