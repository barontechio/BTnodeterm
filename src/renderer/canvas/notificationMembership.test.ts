import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import { useProjects } from '../state/projects'
import { bindProjectToSession, createSession, disposeSession, getSessionStores, resetSessionsForTest, setSessionStatus } from '../session/session'
import { notificationMembership } from './notificationMembership'
import { captureNotificationTarget } from './browserNotificationTarget'

const api = {} as NodeTerminalApi
const payload = { nodeId: 'new-live', title: '', body: '' }
beforeEach(() => { resetSessionsForTest(); createSession('local', {} as NodeTerminalApi, 'Owner') })
afterEach(() => { useProjects.setState({ projects: [], activeProjectId: '' }); resetSessionsForTest() })
describe('actual project/session notification routing', () => {
  it('uses live epoch during selection changes and refuses removed/rebound/offline/revoked sources', () => {
    const session = createSession('relay', api, 'Team')
    useProjects.setState({ projects: [
      { id: 'team', remote: { connectionId: 'c' }, nodes: [{ id: 'stale-saved' }] },
      { id: 'owner', nodes: [] }
    ] as unknown as Project[], activeProjectId: 'owner' })
    bindProjectToSession('team', session.id)
    let live = { projectId: 'team', nodes: [{ id: 'new-live' }] }
    const read = () => notificationMembership(live)
    const capture = () => captureNotificationTarget(api, payload, read)
    const target = capture()!
    expect(target.projectId).toBe('team')
    expect(captureNotificationTarget(api, { ...payload, nodeId: 'stale-saved' }, read)).toBeNull()
    live = { projectId: 'team', nodes: [] }
    expect(target.current()).toBe(false)
    live = { projectId: 'team', nodes: [{ id: 'new-live' }] }
    getSessionStores(session.id).agentStatus.store.getState().setSessionId('new-live', 'cli-2')
    expect(target.current()).toBe(false)
    const withCli = capture()!
    setSessionStatus(session.id, 'offline')
    expect(withCli.current()).toBe(false)
    setSessionStatus(session.id, 'connected')
    const replacement = createSession('relay', api, 'Replacement with SAME API')
    bindProjectToSession('team', replacement.id)
    expect(withCli.current()).toBe(false)
    const rebound = capture()!
    disposeSession(replacement.id)
    expect(rebound.current()).toBe(false)
  })
})
