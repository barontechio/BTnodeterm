import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { DEFAULT_SETTINGS } from '../shared/types'
import { IPC } from '../shared/ipc'
import { registerServerSshProjects } from './ssh-projects'

describe('Server SSH owner surface', () => {
  let service: ReturnType<typeof registerServerSshProjects> | undefined
  afterEach(() => { service?.close(); resetPlatformForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
  const boot = (enabled: boolean, projectTarget?: Parameters<typeof registerServerSshProjects>[0]['projectTarget']) => {
    const platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 }); platform.clients.push(1, 2, 3)
    initPlatform(platform)
    service = registerServerSshProjects({ platform, enabled, settings: () => DEFAULT_SETTINGS, projectTarget, onConnected: async () => {} })
    return platform
  }
  it('remains disabled without touching an agent or starting transport; guests cannot inspect capabilities', () => {
    const before = process.env.NODETERM_APP_AGENT_SOCK; const p = boot(false)
    expect(p.handlers[IPC.sshProjectCapabilities](1)).toEqual({ enabled: false, filesystem: false, transfers: false, media: false, transcriptAgents: [], hostContext: 'server' })
    expect(() => p.handlers[IPC.sshProjectCapabilities](3)).toThrow('owner-required')
    expect(() => p.handlers[IPC.sshConnectProject](1, 'p', { host: 'example.invalid', user: 'fixture' })).toThrow('ssh-disabled')
    expect(process.env.NODETERM_APP_AGENT_SOCK).toBe(before)
    expect(fs.existsSync(path.join(p.userDataDir, 'ssh-askpass.sh'))).toBe(false)
    service!.close(); expect(process.env.NODETERM_APP_AGENT_SOCK).toBe(before)
  })
  it('persists owner inventory, refuses relay management and explicitly reports unavailable transfers', async () => {
    const p = boot(true)
    const server = { id: 'test', label: 'Fixture', host: 'example.invalid', user: 'fixture' }
    await p.handlers[IPC.sshSave](1, server)
    expect(p.handlers[IPC.sshList](2)).toEqual([server])
    expect(JSON.parse(fs.readFileSync(path.join(p.userDataDir, 'ssh-servers.json'), 'utf8'))).toEqual([server])
    expect(() => p.handlers[IPC.sshSave](3, server)).toThrow('owner-required')
    expect(() => p.handlers[IPC.sshUploadFile](1, 'p', '/host/file', 'file')).toThrow('transfer-unavailable')
    expect(() => p.handlers[IPC.sshFsRead](1, 'not-connected', '/same/file')).toThrow('project-disconnected')
    const epoch = p.handlers[IPC.sshPromptConnect](1)
    p.handlers[IPC.sshPromptDisconnect](1, 'stale')
    p.handlers[IPC.sshPromptDisconnect](1, epoch)
    service!.forgetClient(1)
  })
  it('rejects malformed input and a saved-project destination mismatch before starting SSH', async () => {
    const p = boot(true, () => ({ server: { host: 'saved.invalid', user: 'u' }, remoteCwd: '/saved' }))
    await expect(p.handlers[IPC.sshConnectProject](1, 'p', { host: 'other.invalid', user: 'u' }, '/saved')).rejects.toThrow('target-changed')
    await expect(p.handlers[IPC.sshConnectProject](1, 'p', { host: 'saved.invalid', user: 'u', port: 0 }, '/saved')).rejects.toThrow('invalid-connection')
    await expect(p.handlers[IPC.sshConnectProject](1, 'p', { host: 'saved.invalid', user: 'u' }, '/other')).rejects.toThrow('target-changed')
    expect(fs.existsSync(path.join(p.userDataDir, 'ssh-askpass.sh'))).toBe(false)
  })

  it.each(['owner', 'target'])('revokes a queued connection when its %s changes', async (change) => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '1')
    const server = { host: 'saved.invalid', user: 'u' }
    let target = { server, remoteCwd: '/saved' }
    const p = boot(true, () => target)
    let current: (() => boolean) | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(service!.manager, 'connect').mockImplementation(async (_project, _server, _cwd, options) => {
      current = options?.current
      await gate
      if (!current?.()) throw new Error('SSH connect cancelled')
      throw new Error('revocation was ignored')
    })
    const pending = expect(p.handlers[IPC.sshConnectProject](1, 'p', server, '/saved')).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(current).toBeDefined())
    expect(current!()).toBe(true)
    if (change === 'owner') {
      service!.forgetClient(1)
      p.handlers[IPC.sshPromptConnect](1) // same numeric id must not revive the old request
    } else target = { server: { ...server, host: 'changed.invalid' }, remoteCwd: '/saved' }
    expect(current!()).toBe(false)
    release()
    await pending
  })

  it('does not leave a completed connect request authorized for detached work', async () => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '1')
    const p = boot(true)
    let current: (() => boolean) | undefined
    vi.spyOn(service!.manager, 'connect').mockImplementation(async (_project, _server, _cwd, options) => {
      current = options?.current
      return { controlPath: '/fixture' }
    })
    await p.handlers[IPC.sshConnectProject](1, 'p', { host: 'fixture.invalid', user: 'u' })
    expect(current!()).toBe(false)
  })

})
