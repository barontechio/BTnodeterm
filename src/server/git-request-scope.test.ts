import { describe, expect, it } from 'vitest'
import { ServerGitRequestScope } from './git-request-scope'
import { resolveGitRemote } from '../core/remote-ssh/remote-git'
import { IPC } from '../shared/ipc'
import type { Project } from '../shared/types'

const fixture = () => {
  const projects = new Map<string, { name: string; ssh?: Project['ssh'] }>(['a', 'b'].map((id) => [id, {
    name: id, ssh: { server: { host: id, user: 'fixture' }, remoteCwd: '/same' }
  }]))
  projects.set('local', { name: 'Local' })
  let generation = 'one'; let connected = true
  const manager = { refForProject: (id: string) => connected ? { conn: projects.get(id)!.ssh!.server, controlPath: `/socket/${id}`, remoteCwd: '/same' } : undefined,
    connectionKeyFor: () => connected ? generation : undefined }
  const scope = new ServerGitRequestScope({ platform: { isOwnerClient: (id) => id === 1 || id === 2 },
    workspace: { projectTargetInfo: (id) => projects.get(id) ?? null, sshProjectIds: () => ['a', 'b'] }, manager: () => manager })
  return { scope, projects, replace: () => { generation = 'two' }, disconnect: () => { connected = false } }
}
describe('Server Git connection routing', () => {
  it('isolates two owners with equal paths and captures the selected project through awaits', async () => {
    const { scope } = fixture(); scope.setActive(1, 'a'); scope.setActive(2, 'b')
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve })
    const first = scope.run(1, IPC.gitStatus, ['/same'], async () => { await gate; return resolveGitRemote('/same')?.conn.host })
    scope.setActive(1, 'b')
    expect(scope.run(2, IPC.gitStatus, ['/same'], () => resolveGitRemote('/same')?.conn.host)).toBe('b')
    resume(); expect(await first).toBe('a')
  })
  it('never falls back to a local repo for disconnected, replaced or edited remote targets', async () => {
    for (const change of ['disconnect', 'replace', 'edit']) {
      const f = fixture(); f.scope.setActive(1, 'a')
      const operation = f.scope.run(1, IPC.gitStatus, ['/same'], async () => {
        await Promise.resolve()
        if (change === 'disconnect') f.disconnect()
        if (change === 'replace') f.replace()
        if (change === 'edit') f.projects.get('a')!.ssh!.server.host = 'new-host'
        return resolveGitRemote('/same')
      })
      await expect(operation).rejects.toThrow('connection-changed')
    }
    const f = fixture(); f.scope.setActive(1, 'a'); f.disconnect()
    expect(() => f.scope.run(1, IPC.gitStatus, ['/same'], () => resolveGitRemote('/same'))).toThrow('remote-unavailable')
  })
  it('refuses path escapes, ambiguous unselected paths and local-only effects in a remote scope', () => {
    const { scope } = fixture()
    expect(() => scope.run(1, IPC.gitStatus, ['/same'], () => {})).toThrow('project-required')
    expect(() => scope.setActive(3, 'a')).toThrow('owner-required')
    scope.setActive(1, 'a')
    expect(() => scope.run(1, IPC.gitStatus, ['/same'], () => resolveGitRemote('/elsewhere'))).toThrow('path-refused')
    expect(() => scope.run(1, IPC.gitPublish, ['/same'], () => {})).toThrow('local-operation-refused')
    scope.setActive(1, 'local')
    expect(scope.run(1, IPC.gitStatus, ['/same'], () => resolveGitRemote('/same'))).toBeUndefined()
    scope.forgetClient(1)
    expect(() => scope.run(1, IPC.gitStatus, ['/same'], () => {})).toThrow('project-required')
  })
})
