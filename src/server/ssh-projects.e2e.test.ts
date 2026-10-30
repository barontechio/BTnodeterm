import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { Server, type Connection } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { ed25519KeyPair } from '../core/remote-ssh/native/test-keys'
import { resetNativeMuxForTests } from '../core/remote-ssh/native/native-runtime'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { testTmpDir } from '../core/test-tmp'
import { DEFAULT_SETTINGS } from '../shared/types'
import { IPC } from '../shared/ipc'
import { registerServerSshProjects } from './ssh-projects'

/** Real SSH authentication and exec channels; all commands run under a temporary remote HOME. */
describe.skipIf(process.platform === 'win32')('Server SSH transport composition', () => {
  it.each(['0', '1'])('unlocks, reads/writes and reconnects over transport %s', async (native) => {
    const previous = process.env.NODETERM_NATIVE_SSH; process.env.NODETERM_NATIVE_SSH = native
    const root = testTmpDir('server-ssh-e2e-'); const remote = path.join(root, 'remote'); fs.mkdirSync(remote)
    const key = ed25519KeyPair({ passphrase: 'fixture-only', cipher: 'aes256-cbc', rounds: 1 }); const host = ed25519KeyPair()
    const identityFile = path.join(root, 'identity'); fs.writeFileSync(identityFile, key.private, { mode: 0o600 })
    const clients = new Set<Connection>(); const children = new Set<ChildProcess>()
    const sshd = new Server({ hostKeys: [host.private] }, (client) => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {})
      client.on('authentication', (ctx) => ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey']))
      client.on('ready', () => client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec()
          const child = spawn('/bin/sh', ['-c', info.command], { cwd: remote,
            env: { ...process.env, HOME: remote, USERPROFILE: remote } })
          children.add(child); channel.pipe(child.stdin); child.stdin.on('error', () => {})
          child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false })
          child.on('close', (code) => { children.delete(child); channel.exit(code ?? 1); channel.end() })
          channel.on('close', () => { if (child.exitCode === null) child.kill() })
        })
      }))
    })
    await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve))
    const port = (sshd.address() as AddressInfo).port
    const config = path.join(root, 'ssh_config'); const known = path.join(root, 'known_hosts')
    fs.writeFileSync(known, `[127.0.0.1]:${port} ${host.public}\n`)
    fs.writeFileSync(config, `Host *\n  UserKnownHostsFile ${known}\n  GlobalKnownHostsFile ${known}\n  IdentitiesOnly yes\n`)
    const platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 }); platform.clients.push(1, 2)
    initPlatform(platform)
    const connected: string[] = []
    const service = registerServerSshProjects({ platform, enabled: true, settings: () => DEFAULT_SETTINGS,
      onConnected: async (id) => { connected.push(id) } })
    const call = (method: string, ...args: unknown[]): any => platform.handlers[method](1, ...args)
    try {
      const connection = { host: '127.0.0.1', port, user: 'fixture', identityFile, extraArgs: `-F ${config}` }
      await call(IPC.sshSave, { ...connection, id: 'fixture', label: 'Fixture' })
      await call(IPC.sshPromptConnect); platform.handlers[IPC.sshPromptConnect](2)
      const connecting = call(IPC.sshConnectProject, 'fixture', connection, remote) as Promise<unknown>
      void connecting.catch(() => {})
      await vi.waitFor(() => expect(platform.sent.some((e) => e.channel === IPC.sshPassphraseRequest)).toBe(true), { timeout: 10_000 })
      const prompt = platform.sent.find((e) => e.channel === IPC.sshPassphraseRequest)!
      expect(prompt.to).toBe(1)
      platform.handlers[IPC.sshPassphraseSubmit](2, prompt.args[0].requestId, 'fixture-only')
      expect(platform.sent.some((e) => e.channel === IPC.sshPassphraseDismiss)).toBe(false)
      await call(IPC.sshPassphraseSubmit, prompt.args[0].requestId, 'fixture-only')
      await connecting
      const generation = service.manager.connectionKeyFor('fixture'); expect(generation).toBeTruthy()
      const file = path.join(remote, "quoted ' file.txt")
      expect(await call(IPC.sshFsWrite, 'fixture', file, 'remote content')).toBe(true)
      expect(await call(IPC.sshFsRead, 'fixture', file)).toBe('remote content')
      expect(fs.readFileSync(file, 'utf8')).toBe('remote content')
      await call(IPC.sshDisconnectProject, 'fixture')
      expect(() => call(IPC.sshFsRead, 'fixture', file)).toThrow('disconnected')
      const promptCount = platform.sent.filter((event) => event.channel === IPC.sshPassphraseRequest).length
      let reconnected = false
      const reconnect = (call(IPC.sshConnectProject, 'fixture', connection, remote) as Promise<unknown>).then(() => { reconnected = true })
      void reconnect.catch(() => {})
      await vi.waitFor(async () => {
        for (const event of platform.sent.filter((entry) => entry.channel === IPC.sshPassphraseRequest).slice(promptCount)) {
          await call(IPC.sshPassphraseSubmit, event.args[0].requestId, 'fixture-only')
        }
        expect(reconnected).toBe(true)
      }, { timeout: 10_000 })
      await reconnect
      expect(service.manager.connectionKeyFor('fixture')).not.toBe(generation)
      expect(connected).toEqual(['fixture', 'fixture'])
    } finally {
      service.close(); resetNativeMuxForTests(); resetPlatformForTests()
      for (const child of children) child.kill(); for (const client of clients) client.end()
      await new Promise<void>((resolve) => sshd.close(() => resolve()))
      if (previous === undefined) delete process.env.NODETERM_NATIVE_SSH; else process.env.NODETERM_NATIVE_SSH = previous
    }
  }, 25_000)
})
