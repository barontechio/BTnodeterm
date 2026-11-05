import { useEffect, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { externalPreviewUrl } from '../../shared/web-preview'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { MaximizeButton } from './MaximizeButton'
import { Tooltip } from '../components/Tooltip'
import { IconClose, IconOpenExternal } from '../components/icons'

/** Browser preview chrome; the iframe has an opaque origin even for an application URL redirect. */
export default function BrowserWebNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const rawUrl = typeof data.url === 'string' ? data.url : ''
  const filePath = typeof data.filePath === 'string' ? data.filePath : ''
  const external = externalPreviewUrl(rawUrl)
  const title = typeof data.title === 'string' ? data.title : 'Web preview'
  useEffect(() => {
    setSrc(''); setError('')
    if (rawUrl) {
      if (external) setSrc(external)
      else setError('Use an external HTTP(S) page. Host localhost previews need a preview gateway.')
      return
    }
    if (!filePath) { setError('No source'); return }
    const api = window.nodeTerminal.webPreview
    if (!api) { setError('HTML previews are not available on this host.'); return }
    let alive = true
    let granted = ''
    let timer: ReturnType<typeof setInterval> | undefined
    let renewing = false
    const release = (url: string) => { if (url) void api.release(url).catch(() => {}) }
    void api.allow({ projectId: useProjects.getState().activeProjectId ?? '', nodeId: id }).then((url) => {
      if (!alive) { release(url); return }
      granted = url; setSrc(url)
      timer = setInterval(() => {
        if (renewing) return
        renewing = true
        void api.renew(url).then((valid) => {
          if (!valid && alive) { setSrc(''); setError('Preview access expired. Reopen this page.'); clearInterval(timer) }
        }).catch(() => {}).finally(() => { renewing = false })
      }, 60_000)
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : 'Could not load this preview.') })
    return () => { alive = false; clearInterval(timer); release(granted) }
  }, [rawUrl, external, filePath, id])

  return <>
    <div className="term-node web-node" style={{ borderTopColor: data.color }}>
      <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
      <Handle id="flow-in" type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none', top: 0 }} />
      <div className="term-node__header">
        <span className="term-node__title-text" title={rawUrl || filePath}>{title}</span>
        <span className="term-node__spacer" />
        {external && <Tooltip label="Open in new tab"><button className="term-node__close" aria-label="Open in new tab"
          onClick={() => window.nodeTerminal.shell.openExternal(external)}><IconOpenExternal /></button></Tooltip>}
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close"><button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}><IconClose /></button></Tooltip>
      </div>
      <div className="editor-node__body nodrag nowheel nopan" style={{ display: 'flex', flexDirection: 'column' }}>
        {src ? <iframe src={src} title={title} sandbox={rawUrl ? 'allow-scripts allow-forms' : ''} referrerPolicy="no-referrer"
          style={{ width: '100%', flex: 1, minHeight: 0, border: 0 }} /> : <span className="editor-node__loading">{error || 'Loading…'}</span>}
        {external && <div style={{ padding: '4px 8px', fontSize: 11 }}>Open in a new tab if this site blocks embedding.</div>}
        {!rawUrl && src && <div style={{ padding: '4px 8px', fontSize: 11 }}>This preview displays static HTML.</div>}
      </div>
    </div>
    <NodeResizer minWidth={NODE_MIN_SIZES.web.width} minHeight={NODE_MIN_SIZES.web.height} isVisible={selected} color={data.color} />
  </>
}
