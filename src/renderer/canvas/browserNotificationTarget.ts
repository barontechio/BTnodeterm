import type { NodeTerminalApi, NotifyPayload } from '@shared/types'
import type { WorkspaceSession } from '../session/session'

export interface NotificationMembership {
  projectId: string
  nodeId: string
  session: WorkspaceSession
  /** CLI session identity when known; replacement invalidates an old notice. */
  agentSessionId?: string
}

/** Read every placement, including duplicates; never collapse them into a map by node id. */
export function captureNotificationTarget(
  api: NodeTerminalApi,
  payload: NotifyPayload,
  read: () => NotificationMembership[]
): { projectId: string; nodeId: string; current(): boolean } | null {
  const resolve = (): NotificationMembership | undefined => {
    let members: NotificationMembership[]
    try { members = read() } catch { return }
    const matches = members.filter((m) => m.nodeId === payload.nodeId)
    if (matches.length !== 1) return
    const m = matches[0]
    if (payload.projectId !== undefined && payload.projectId !== m.projectId) return
    if (m.session.api !== api || m.session.status !== 'connected') return
    return m
  }
  const captured = resolve()
  if (!captured) return null
  return {
    projectId: captured.projectId,
    nodeId: captured.nodeId,
    current: () => {
      const fresh = resolve()
      return !!fresh && fresh.projectId === captured.projectId && fresh.session === captured.session &&
        fresh.agentSessionId === captured.agentSessionId
    }
  }
}
