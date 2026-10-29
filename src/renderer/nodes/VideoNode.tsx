import { useEffect, useState } from 'react'
import { Tooltip } from '../components/Tooltip'
import { MaximizeButton } from './MaximizeButton'
import { IconClose } from '../components/icons'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { isAudioFile, type CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'

/**
 * A video player node. A local file is served over the `nt-media://` protocol (allowlisted on
 * mount via `media.allow`) and rendered with native controls so seeking/scrubbing works. A file
 * in an SSH project (`data.sshFs` — the path lives on the HOST, mirroring EditorNode's flag) is
 * first pulled into the local media cache over the project's ControlMaster (`media.allowSsh`;
 * re-fetch is skipped when the cached copy still matches), then played the same way. The
 * frame/header mirror {@link EditorNode} for consistent drag/resize/close behavior.
 */
export default function VideoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const filePath = (data.filePath as string) ?? ''
  const fileName = filePath.split('/').pop() || 'video'
  const remote = !!data.sshFs
  const audio = isAudioFile(filePath)

  useEffect(() => {
    setSrc('')
    setError('')
    setFetching(false)
    if (!filePath) return
    let alive = true
    let allowedUrl = ''
    let renewal: ReturnType<typeof setInterval> | undefined
    const media = window.nodeTerminal.media
    const release = (url: string) => { if (url) void media.release?.(url).catch(() => {}) }
    const accept = (url: string) => {
      if (!alive) { release(url); return }
      allowedUrl = url
      setSrc(url)
      if (media.renew) {
        let renewing = false
        renewal = setInterval(() => {
          if (renewing) return
          renewing = true
          void media.renew!(url).then((valid) => {
            if (!valid && alive) { setSrc(''); setError('Playback access expired. Reopen this media file.'); clearInterval(renewal) }
          }).catch(() => {}).finally(() => { renewing = false })
        }, 60_000)
      }
    }
    const cleanup = () => { alive = false; clearInterval(renewal); release(allowedUrl) }
    if (remote) {
      // Remote fetch can take a while for a large file — say what the wait is.
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) {
        setError('Couldn’t load this media file.')
        return
      }
      setFetching(true)
      window.nodeTerminal.media
        .allowSsh(projectId, filePath)
        .then((r) => {
          if (!alive) { if (r.ok) release(r.url); return }
          setFetching(false)
          if (r.ok) accept(r.url)
          else setError(r.error)
        })
        .catch(() => {
          if (!alive) return
          setFetching(false)
          setError('Couldn’t load this media file.')
        })
      return cleanup
    }
    window.nodeTerminal.media
      .allow(filePath, { projectId: useProjects.getState().activeProjectId ?? '', nodeId: id })
      .then(accept)
      .catch(() => {
        if (alive) setError('Couldn’t load this media file.')
      })
    return cleanup
    // activeProjectId is read at effect time on purpose: the node lives inside its project's
    // canvas, so the active project when the node mounts IS its project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, remote, id])

  return (
    <>
    <div
      className={`term-node video-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      {/* Paint only: the old resize box in its old place (see .nt-resize-ghost in styles.css). */}
      <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>
          {fileName}
        </span>
        <span className="term-node__spacer" />
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>

      <div className="editor-node__body">
        <div className="editor-node__image nodrag nowheel nopan">
          {src ? (
            audio ? (
              <audio src={src} controls preload="metadata" style={{ width: '100%' }} />
            ) : (
              <video
                src={src}
                controls
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            )
          ) : (
            <span className="editor-node__loading">
              {error || (fetching ? 'Fetching from the host…' : 'Loading…')}
            </span>
          )}
        </div>
      </div>
    </div>
    {/* Sibling of the root, not a child: under Liquid Glass the root has a backdrop-filter,
        which makes it the containing block for these absolute edges, so they were clipped and
        covered (only the top edge stayed grabbable). Out here they sit on the node wrapper.
        AFTER the root, never before it: focus mode reparents the root out of this wrapper, and
        React inserting a control "before the root" would then throw NotFoundError. */}
    <NodeResizer minWidth={NODE_MIN_SIZES.video.width} minHeight={NODE_MIN_SIZES.video.height} isVisible={selected} color={data.color} />
    </>
  )
}
