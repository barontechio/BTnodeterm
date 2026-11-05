import { useProjects } from '../state/projects'
import { sessionForProject, getSessionStores } from '../session/session'
import type { NotificationMembership } from './browserNotificationTarget'

/** The epoch owner, not the selected tab, identifies the live node array during a switch. */
export function notificationMembership(live: { projectId: string | null; nodes: readonly { id: string }[] }): NotificationMembership[] {
  return useProjects.getState().projects.flatMap((project) => {
    const session = sessionForProject(project.id)
    const members = live.projectId === project.id ? live.nodes : project.nodes
    return members.map((node) => ({
      projectId: project.id,
      nodeId: node.id,
      session,
      agentSessionId: getSessionStores(session.id).agentStatus.store.getState().byId[node.id]?.sessionId
    }))
  })
}
