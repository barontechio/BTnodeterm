import { useEffect, useState } from 'react'
import { useProjects } from '../../../state/projects'
import { sessionForProject } from '../../../session/session'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { webPushBrowserAvailable, webPushCapability, existingWebPush, webPushPost, enableWebPush, disableWebPush, type WebPushCapability } from '../../../bridge/web-push'

export function WebPushPanel(): React.JSX.Element {
  const projectId = useProjects(s => s.activeProjectId)
  const project = useProjects(s => s.projects.find(p => p.id === projectId))
  const [capability, setCapability] = useState<WebPushCapability>({ available: false })
  const [enabled, setEnabled] = useState(false)
  const [scope, setScope] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('Checking Web Push availability…')
  const local = !!project && !project.remote && !project.ssh && sessionForProject(project.id).api === window.nodeTerminal
  useEffect(() => {
    let current = true
    if (!local || !webPushBrowserAvailable()) {
      setNote(local ? 'This browser needs HTTPS, Service Workers and Push API support.' : 'Select a local project on this server to manage browser push notifications.')
      setCapability({ available: false })
      return
    }
    void (async () => {
      try {
        const cap = await webPushCapability()
        const subscription = cap.available ? await existingWebPush() : null
        const status = subscription ? await webPushPost<{ enabled: boolean; projectId?: string }>('status', { endpoint: subscription.endpoint }) : { enabled: false }
        if (!current) return
        setCapability(cap); setEnabled(status.enabled); setScope(status.projectId)
        setNote(cap.available ? '' : cap.reason ?? 'Web Push is unavailable.')
      } catch (e) { if (current) { setCapability({ available: false }); setNote((e as Error).message) } }
    })()
    return () => { current = false }
  }, [projectId, local])
  const toggle = (): void => {
    if (!projectId || busy) return
    const captured = sessionForProject(projectId)
    const current = (): boolean => {
      const p = useProjects.getState().getProject(projectId)
      return !!p && !p.remote && !p.ssh && useProjects.getState().activeProjectId === projectId &&
        sessionForProject(projectId) === captured && captured.api === window.nodeTerminal && captured.status === 'connected'
    }
    setBusy(true); setNote('')
    const operation = enabled ? disableWebPush() : enableWebPush(projectId, capability.publicKey!, current)
    void operation.then(() => { if (current()) { setEnabled(!enabled); setScope(enabled ? undefined : projectId) } })
      .catch(e => setNote((e as Error).message)).finally(() => setBusy(false))
  }
  return <FieldRow label="Notify even when this page is closed"
    description={enabled ? `Enabled for ${useProjects.getState().getProject(scope ?? '')?.name ?? 'a saved project'} in this browser. Signing out revokes delivery.` : 'Enable for the selected project on this server. The browser and OS must allow background delivery. This device receives generic finished-turn and needs-response alerts for up to 30 days.'}
    note={note} control={<Button disabled={!local || !capability.available || busy} onClick={toggle}>{busy ? 'Saving…' : enabled ? 'Disable browser push' : 'Enable browser push'}</Button>} />
}
