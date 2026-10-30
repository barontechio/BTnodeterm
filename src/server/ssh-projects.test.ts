import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { DEFAULT_SETTINGS } from '../shared/types'
import { IPC } from '../shared/ipc'
import { registerServerSshProjects } from './ssh-projects'

describe('Server SSH owner surface', () => {
  let service: ReturnType<typeof registerServerSshProjects> | undefined
  afterEach(() => { service?.close(); resetPlatformForTests() })
  const boot = (enabled: boolean, projectTarget?: Parameters<typeof registerServerSshProjects>[0]['projectTarget']) => {
    const platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 }); platform.clients.push(1, 2, 3)
    initPlatform(platform)
    service = registerServerSshProjects({ platform, enabled, settings: () => DEFAULT_SETTINGS, projectTarget, onConnected: async () => {} })
    return platform
  }
  it('remains disabled without touching an agent or starting transport; guests cannot inspect capabilities', () => {
    const before = process.env.NODETERM_APP_AGENT_SOCK; const p = boot(false)
    expect(p.handlers[IPC.sshProjectCapabilities](1)).toEqual({ enabled: false, filesystem: false, transfers: false, media: false, hostContext: 'server' })
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

})
