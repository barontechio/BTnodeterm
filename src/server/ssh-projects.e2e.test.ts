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
import { sshHostKey, type SshConnection } from '../shared/ssh'
import { DEFAULT_SETTINGS, type CanvasNodeState, type ChatTranscriptResult } from '../shared/types'
import { IPC } from '../shared/ipc'
import { registerServerSshProjects } from './ssh-projects'
import { makeSshSetupRunner } from '../core/remote-ssh/ssh-setup-runner'
import { createServerRemoteTranscripts } from './remote-transcripts'
import { registerTranscriptIpc } from '../core/transcript-ipc'

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
    let savedTarget: { server: SshConnection; remoteCwd: string } | undefined
    const service = registerServerSshProjects({ platform, enabled: true, settings: () => DEFAULT_SETTINGS, projectTarget: () => savedTarget,
      onConnected: async (id) => { connected.push(id) } })
    const call = (method: string, ...args: unknown[]): any => platform.handlers[method](1, ...args)
    let transcripts: ReturnType<typeof createServerRemoteTranscripts> | undefined
    try {
      const connection = { host: '127.0.0.1', port, user: 'fixture', identityFile, extraArgs: `-F ${config}` }
      savedTarget = { server: connection, remoteCwd: remote }
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
      const chunks: string[] = []
      const setup = makeSshSetupRunner((endpoint) => service.refForEndpoint(endpoint))
      expect(await setup({ script: 'printf "%s" "$FIXTURE_VALUE"; printf " stderr" >&2', cwd: remote,
        env: { FIXTURE_VALUE: 'remote setup' }, onChunk: (chunk) => { chunks.push(chunk) },
        signal: new AbortController().signal, ssh: { server: connection, remoteCwd: remote } })).toEqual({ exitCode: 0 })
      expect(chunks.join('')).toContain('remote setup')
      expect(chunks.join('')).toContain('stderr')
      const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
      const history = path.join(remote, '.nodeterm', 'claude-accounts', 'managed', 'projects', 'repo')
      fs.mkdirSync(history, { recursive: true })
      const content = JSON.stringify({ type: 'user', uuid: 'message-1', message: { role: 'user', content: 'remote conversation' } }) + '\n'
      fs.writeFileSync(path.join(history, `${sid}.jsonl`), content)
      const decoy = path.join(remote, '.claude', 'projects', 'repo'); fs.mkdirSync(decoy, { recursive: true })
      fs.writeFileSync(path.join(decoy, `${sid}.jsonl`), 'system account decoy')
      const settings = structuredClone(DEFAULT_SETTINGS)
      settings.claudeAccounts = [{ id: 'managed', label: 'Remote account', host: sshHostKey(connection), createdAt: Date.now() }]
      const node: CanvasNodeState = { id: 'remote-node', kind: 'terminal', agentId: 'claude', accountId: 'managed', agentSessionId: sid,
        title: 'Remote', cwd: remote, color: '#000', group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }
      transcripts = createServerRemoteTranscripts({ platform, enabled: true, settings: () => settings, sessionOf: () => sid,
        pty: { sshRemoteForNode: () => undefined }, ssh: service, workspace: {
          projectIdsForNode: () => savedTarget ? ['fixture'] : [], getNodeForHostAction: () => node,
          relayNodePlacements: () => [{ projectId: 'fixture', node }],
          sshProjectIdForNode: () => 'fixture', projectTargetInfo: () => savedTarget ? { name: 'Fixture', ssh: savedTarget } : null
        } })
      registerTranscriptIpc({ rpcScope: transcripts.rpcScope, isRemoteNode: transcripts.isRemoteNode,
        remoteAgentSupported: transcripts.supported, readRemote: (q) => transcripts!.reader.read(q),
        readRemotePage: (q, page) => transcripts!.reader.readPage(q, page), remoteExists: (q) => transcripts!.reader.exists(q) })
      const chat = await call(IPC.chatReadTranscript, sid, remote, 'managed', 'remote-node', 'claude', { maxBytes: 65536 }) as ChatTranscriptResult
      expect(chat.found).toBe(true); expect(JSON.stringify(chat.messages)).toContain('remote conversation')
      expect(JSON.stringify(chat.messages)).not.toContain('system account decoy')
      expect(await platform.handlers[IPC.chatReadTranscript](3, sid, remote, 'managed', 'remote-node', 'claude', { maxBytes: 65536 }))
        .toMatchObject({ found: false, unreadable: true, unreadableReason: 'remote-reader-permission-required' })
      expect(await transcripts.rpcScope(1, () => transcripts!.reader.exists({ sessionId: sid, nodeId: 'remote-node', accountId: 'managed', cwd: remote }))).toBe('present')
      savedTarget = undefined
      expect(service.refForProject('fixture')).toBeUndefined()
      expect(service.spawnRefFor('fixture')).toBeUndefined()
      expect(() => call(IPC.sshFsRead, 'fixture', file)).toThrow('target-changed')
      savedTarget = { server: { ...connection, identityFile: '/different-key' }, remoteCwd: remote }
      expect(service.refForProject('fixture')).toBeUndefined()
      savedTarget = { server: connection, remoteCwd: remote }
      await call(IPC.sshDisconnectProject, 'fixture')
      expect(() => call(IPC.sshFsRead, 'fixture', file)).toThrow('disconnected')
      expect(await call(IPC.chatReadTranscript, sid, remote, 'managed', 'remote-node', 'claude', { maxBytes: 65536 }))
        .toMatchObject({ found: false, unreadable: true })
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
      transcripts?.dispose(); service.close(); resetNativeMuxForTests(); resetPlatformForTests()
      for (const child of children) child.kill(); for (const client of clients) client.end()
      await new Promise<void>((resolve) => sshd.close(() => resolve()))
      if (previous === undefined) delete process.env.NODETERM_NATIVE_SSH; else process.env.NODETERM_NATIVE_SSH = previous
    }
  }, 25_000)
})
