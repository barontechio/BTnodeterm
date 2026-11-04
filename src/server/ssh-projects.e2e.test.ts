import { randomBytes } from 'node:crypto'
import { hookServer } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import type { RemoteContextReadScope } from '../core/context-link'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
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
import { handleContextLinkRequest, initContextLink, setContextLinks } from '../core/context-link'
import type { PtyManager } from '../core/pty-manager'
import { remoteCodexHome } from '../core/codex-accounts-core'
import { registerTranscriptIpc } from '../core/transcript-ipc'
import { posixQuote } from '../shared/ssh'

// HOME does not redirect OpenSSH's passwd-derived ~/.ssh paths. The shared ControlMaster
// builders do not forward extraArgs, so a caller-supplied -F is not a fixture sandbox. Route the real
// executable (including native's real ssh -G) through a test-only, fail-closed wrapper.
const sshFixture = vi.hoisted(() => ({ executable: '' }))
vi.mock('../core/exec-path', async (original) => {
  const actual = await original<typeof import('../core/exec-path')>()
  return { ...actual, findExecutableSync: (...args: Parameters<typeof actual.findExecutableSync>) => {
    if (args[0] !== 'ssh') return actual.findExecutableSync(...args)
    if (!sshFixture.executable) throw new Error('SSH fixture sandbox is not initialized')
    return sshFixture.executable
  } }
})

/** Real SSH authentication and exec channels; all commands run under a temporary remote HOME. */
describe.skipIf(process.platform === 'win32')('Server SSH transport composition', () => {
  it.each(['0', '1'])('unlocks, reads/writes and reconnects over transport %s', async (native) => {
    const previous = process.env.NODETERM_NATIVE_SSH
    const previousConfig = process.env.NODETERM_TEST_SSH_CONFIG
    const previousCalls = process.env.NODETERM_TEST_SSH_CALLS
    const clients = new Set<Connection>(); const children = new Set<ChildProcess>()
    let cleanupServer: Server | undefined
    let cleanupService: ReturnType<typeof registerServerSshProjects> | undefined
    let transcripts: ReturnType<typeof createServerRemoteTranscripts> | undefined
    try {
      process.env.NODETERM_NATIVE_SSH = native
      const root = testTmpDir('server-ssh-e2e-'); const remote = path.join(root, 'remote'); fs.mkdirSync(remote)
      if (!sshFixture.executable) {
        sshFixture.executable = path.join(testTmpDir('ssh-fixture-bin-'), 'ssh')
        const realSsh = (await vi.importActual<typeof import('../core/exec-path')>('../core/exec-path'))
          .findExecutableSync('ssh', ['/usr/bin/ssh', '/usr/local/bin/ssh'])
        if (!realSsh) throw new Error('OpenSSH client required for protocol fixture')
        fs.writeFileSync(sshFixture.executable, `#!/bin/sh\nset -eu\n: "\${NODETERM_TEST_SSH_CONFIG:?}" "\${NODETERM_TEST_SSH_CALLS:?}"\nprintf '%s\\n' "$1" >> "$NODETERM_TEST_SSH_CALLS"\nexec ${posixQuote(realSsh)} -F "$NODETERM_TEST_SSH_CONFIG" "$@"\n`, { mode: 0o700 })
      }
      const key = ed25519KeyPair({ passphrase: 'fixture-only', cipher: 'aes256-cbc', rounds: 1 }); const host = ed25519KeyPair()
      const identityFile = path.join(root, 'identity'); fs.writeFileSync(identityFile, key.private, { mode: 0o600 })
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
      cleanupServer = sshd
      await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve))
      const port = (sshd.address() as AddressInfo).port
      const config = path.join(root, 'ssh_config'); const known = path.join(root, 'known_hosts')
      fs.writeFileSync(known, `[127.0.0.1]:${port} ${host.public}\n`)
      fs.writeFileSync(config, `Host *\n  UserKnownHostsFile ${known}\n  GlobalKnownHostsFile ${known}\n  IdentitiesOnly yes\n`)
      process.env.NODETERM_TEST_SSH_CONFIG = config
      process.env.NODETERM_TEST_SSH_CALLS = path.join(root, 'ssh-calls')
      const resolved = execFileSync(sshFixture.executable, ['-G', '-p', String(port), '-l', 'fixture', '127.0.0.1'], { encoding: 'utf8' })
      expect(resolved).toContain(`userknownhostsfile ${known}\n`)
      expect(resolved).toContain(`globalknownhostsfile ${known}\n`)
      fs.writeFileSync(process.env.NODETERM_TEST_SSH_CALLS, '')
      const platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 }); platform.clients.push(1, 2)
      initPlatform(platform)
      const connected: string[] = []
      let savedTarget: { server: SshConnection; remoteCwd: string } | undefined
      const service = registerServerSshProjects({ platform, enabled: true, settings: () => DEFAULT_SETTINGS, projectTarget: () => savedTarget,
        onConnected: async (id) => { connected.push(id) } })
      cleanupService = service
      const call = (method: string, ...args: unknown[]): any => platform.handlers[method](1, ...args)
      const connection = { host: '127.0.0.1', port, user: 'fixture', identityFile }
      savedTarget = { server: connection, remoteCwd: remote }
      await call(IPC.sshSave, { ...connection, id: 'fixture', label: 'Fixture' })
      await call(IPC.sshPromptConnect); platform.handlers[IPC.sshPromptConnect](2)
      const connecting = call(IPC.sshConnectProject, 'fixture', connection, remote) as Promise<unknown>
      let connectError: unknown
      void connecting.catch((error) => { connectError = error })
      await vi.waitFor(() => {
        if (connectError) throw connectError
        expect(platform.sent.some((e) => e.channel === IPC.sshPassphraseRequest)).toBe(true)
      }, { timeout: 10_000 })
      const prompt = platform.sent.find((e) => e.channel === IPC.sshPassphraseRequest)!
      expect(prompt.to).toBe(1)
      platform.handlers[IPC.sshPassphraseSubmit](2, prompt.args[0].requestId, 'fixture-only')
      expect(platform.sent.some((e) => e.channel === IPC.sshPassphraseDismiss)).toBe(false)
      await call(IPC.sshPassphraseSubmit, prompt.args[0].requestId, 'fixture-only')
      await connecting
      expect(fs.readFileSync(process.env.NODETERM_TEST_SSH_CALLS, 'utf8').split('\n')).toContain(native === '1' ? '-G' : '-M')
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
        contextPermission: (caller, target) => caller === 'reader-node' && target === 'remote-node',
        pty: { sshRemoteForNode: () => undefined }, ssh: service, workspace: {
          projectIdsForNode: () => savedTarget ? ['fixture'] : [], getNodeForHostAction: (id) => id === 'reader-node' ? { ...node, id } : node,
          relayNodePlacements: () => [{ projectId: 'fixture', node }],
          sshProjectIdForNode: () => 'fixture', projectTargetInfo: () => savedTarget ? { name: 'Fixture', ssh: savedTarget } : null
        } })
      registerTranscriptIpc({ rpcScope: transcripts.rpcScope, isRemoteNode: transcripts.isRemoteNode,
        remoteAgentSupported: transcripts.supported, readRemote: (q) => transcripts!.reader.read(q),
        readRemoteCodexPage: (q, page) => transcripts!.codexReader.readPage(q, page),
        readRemotePage: (q, page) => transcripts!.reader.readPage(q, page), remoteExists: (q) => transcripts!.reader.exists(q) })
      const chat = await call(IPC.chatReadTranscript, sid, remote, 'managed', 'remote-node', 'claude', { maxBytes: 65536 }) as ChatTranscriptResult
      expect(chat.found).toBe(true); expect(JSON.stringify(chat.messages)).toContain('remote conversation')
      expect(JSON.stringify(chat.messages)).not.toContain('system account decoy')
      expect(await platform.handlers[IPC.chatReadTranscript](3, sid, remote, 'managed', 'remote-node', 'claude', { maxBytes: 65536 }))
        .toMatchObject({ found: false, unreadable: true, unreadableReason: 'remote-reader-permission-required' })
      expect(await transcripts.rpcScope(1, () => transcripts!.reader.exists({ sessionId: sid, nodeId: 'remote-node', accountId: 'managed', cwd: remote }))).toBe('present')
      const codexDir = path.join(remoteCodexHome(remote, 'managed'), 'sessions', '2026', '11', '04')
      fs.mkdirSync(codexDir, { recursive: true })
      fs.writeFileSync(path.join(codexDir, `rollout-fixture-${sid}.jsonl`), [
        { type: 'session_meta', payload: { id: sid } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'remote Codex question' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'remote Codex answer' }] } }
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      settings.codexAccounts = [{ id: 'managed', label: 'Codex', host: sshHostKey(connection) }]
      node.agentId = 'codex'
      const codexChat = await call(IPC.chatReadTranscript, sid, remote, 'managed', 'remote-node', 'codex', { maxBytes: 65536 }) as ChatTranscriptResult
      expect(codexChat.found).toBe(true)
      expect(JSON.stringify(codexChat.messages)).toContain('remote Codex question')
      expect(JSON.stringify(codexChat.messages)).toContain('remote Codex answer')
      expect(await platform.handlers[IPC.chatReadTranscript](3, sid, remote, 'managed', 'remote-node', 'codex', { maxBytes: 65536 }))
        .toMatchObject({ found: false, unreadable: true })
      initContextLink({ getTmuxBin: () => null } as unknown as PtyManager, {
        isRemoteNode: transcripts.isRemoteNode, readRemoteTranscript: transcripts.readLinkedTranscript
      })
      await setContextLinks({ 'reader-node': [{ id: 'remote-node', title: 'Remote Codex', agentId: 'codex', sessionId: sid, accountId: 'managed' }] })
      const linked = await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader-node', args: {},
        scope: { signal: new AbortController().signal, verified: () => true } })
      expect(linked).toContain('remote Codex answer')
      expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader-node', args: {} }))
        .not.toContain('remote Codex answer')
      // Exercise the entire publication boundary: real SSH bytes, formatter, verified HTTP
      // caller, and a revoked/recreated edge between the final IO check and res.end.
      let httpScope: RemoteContextReadScope | undefined
      initContextLink({ getTmuxBin: () => null } as unknown as PtyManager, {
        isRemoteNode: transcripts.isRemoteNode,
        readRemoteTranscript: (entry, scope) => { httpScope = scope; return transcripts!.readLinkedTranscript(entry, scope) }
      })
      const map = { 'reader-node': [{ id: 'remote-node', title: 'Remote Codex', agentId: 'codex', sessionId: sid, accountId: 'managed' }] }
      await setContextLinks(map)
      await hookServer.start()
      const authSecret = randomBytes(32); hookServer.setNodeAuthSecret(authSecret)
      const httpRead = async () => {
        const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/context-link/transcript`, {
          method: 'POST', headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(),
            'X-Nodeterm-Node-Token': nodeAuthToken(authSecret, 'reader-node'), 'content-type': 'application/x-www-form-urlencoded' },
          body: 'nodeId=reader-node'
        })
        return response.text()
      }
      expect(await httpRead()).toContain('remote Codex answer')
      const run = service.manager.sshRun.bind(service.manager)
      let revokedBeforeEnd = false
      service.manager.sshRun = async (args) => {
        const result = await run(args)
        let left = 8
        const revoke = () => {
          if (left-- > 0) { queueMicrotask(revoke); return }
          revokedBeforeEnd = httpScope?.signal?.aborted === false
          void setContextLinks({}); void setContextLinks(map)
        }
        queueMicrotask(revoke)
        return result
      }
      const revokedResponse = await httpRead()
      expect(revokedBeforeEnd).toBe(true)
      expect(revokedResponse).not.toContain('remote Codex answer')
      service.manager.sshRun = run
      await setContextLinks({})
      node.agentId = 'claude'
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
      let reconnectError: unknown
      const reconnect = (call(IPC.sshConnectProject, 'fixture', connection, remote) as Promise<unknown>).then(() => { reconnected = true })
      void reconnect.catch((error) => { reconnectError = error })
      await vi.waitFor(async () => {
        if (reconnectError) throw reconnectError
        for (const event of platform.sent.filter((entry) => entry.channel === IPC.sshPassphraseRequest).slice(promptCount)) {
          await call(IPC.sshPassphraseSubmit, event.args[0].requestId, 'fixture-only')
        }
        expect(reconnected).toBe(true)
      }, { timeout: 10_000 })
      await reconnect
      expect(service.manager.connectionKeyFor('fixture')).not.toBe(generation)
      expect(connected).toEqual(['fixture', 'fixture'])
      expect(fs.readFileSync(known, 'utf8')).toBe(`[127.0.0.1]:${port} ${host.public}\n`)
    } finally {
      try {
        try {
          hookServer.stop(); hookServer.clearNodeAuthSecretForTests()
          transcripts?.dispose(); cleanupService?.close()
        } finally {
          resetNativeMuxForTests(); resetPlatformForTests()
          for (const child of children) child.kill(); for (const client of clients) client.end()
          if (cleanupServer?.address()) {
            await new Promise<void>((resolve) => cleanupServer!.close(() => resolve()))
          }
        }
      } finally {
        if (previous === undefined) delete process.env.NODETERM_NATIVE_SSH; else process.env.NODETERM_NATIVE_SSH = previous
        if (previousConfig === undefined) delete process.env.NODETERM_TEST_SSH_CONFIG; else process.env.NODETERM_TEST_SSH_CONFIG = previousConfig
        if (previousCalls === undefined) delete process.env.NODETERM_TEST_SSH_CALLS; else process.env.NODETERM_TEST_SSH_CALLS = previousCalls
      }
    }
  }, 25_000)
})
