import { describe, expect, it } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import type { WorkspaceSession } from '../session/session'
import { captureNotificationTarget, type NotificationMembership } from './browserNotificationTarget'

const api = {} as NodeTerminalApi
function setup() {
  const session: WorkspaceSession = { id: 'server-1', source: 'server', status: 'connected', label: 'Host', api }
  let members: NotificationMembership[] = [{ projectId: 'p', nodeId: 'n', session, agentSessionId: 'cli-1' }]
  return { session, read: () => members, set: (m: NotificationMembership[]) => { members = m } }
}
const payload = { nodeId: 'n', title: 'done', body: '' }
describe('notification source identity', () => {
  it('requires unique membership across and within projects, exact source and project hint', () => {
    const s = setup()
    expect(captureNotificationTarget(api, payload, s.read)?.current()).toBe(true)
    expect(captureNotificationTarget({} as NodeTerminalApi, payload, s.read)).toBeNull()
    expect(captureNotificationTarget(api, { ...payload, projectId: 'wrong' }, s.read)).toBeNull()
    const m = s.read()[0]
    s.set([m, { ...m }])
    expect(captureNotificationTarget(api, payload, s.read)).toBeNull()
    s.set([m, { ...m, projectId: 'other' }])
    expect(captureNotificationTarget(api, { ...payload, projectId: 'p' }, s.read)).toBeNull()
  })
  it.each(['offline', 'removed', 'rebound', 'api', 'cli', 'project', 'duplicate'])('rejects %s after capture and at deferred execution', (change) => {
    const s = setup()
    const target = captureNotificationTarget(api, payload, s.read)!
    const m = s.read()[0]
    if (change === 'offline') s.session.status = 'offline'
    if (change === 'removed') s.set([])
    if (change === 'rebound') s.set([{ ...m, session: { ...s.session } }])
    if (change === 'api') s.session.api = {} as NodeTerminalApi
    if (change === 'cli') s.set([{ ...m, agentSessionId: 'cli-2' }])
    if (change === 'project') s.set([{ ...m, projectId: 'moved' }])
    if (change === 'duplicate') s.set([m, { ...m, projectId: 'clone' }])
    expect(target.current()).toBe(false)
  })
})
