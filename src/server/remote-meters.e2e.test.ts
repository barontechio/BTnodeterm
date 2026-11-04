import http from 'node:http'
import WebSocket from 'ws'
import { Auth } from './auth'
import { ServerPlatform } from './platform-server'
import { attachWsServer } from './ws'
import { SESSION_COOKIE } from './http'
import { createServerRemoteMeters } from './remote-meters'
import { presenceHub } from '../core/presence/hub'
import { hookServer } from '../core/agents/hook-server'
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
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import { IPC } from '../shared/ipc'
import { registerServerSshProjects } from './ssh-projects'
import { createServerRemoteTranscripts } from './remote-transcripts'
import { remoteCodexHome } from '../core/codex-accounts-core'
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
describe.skipIf(process.platform === 'win32')('SSH meters over encrypted OpenSSH/native and owner WebSocket', () => {
  it.each(['0', '1'])('scopes continuous account meters to the real owner lifetime over transport %s', async (native) => {
    const previous = process.env.NODETERM_NATIVE_SSH
    const previousConfig = process.env.NODETERM_TEST_SSH_CONFIG
    const previousCalls = process.env.NODETERM_TEST_SSH_CALLS
    const clients = new Set<Connection>(); const children = new Set<ChildProcess>()
    let cleanupServer: Server | undefined
    let cleanupService: ReturnType<typeof registerServerSshProjects> | undefined
    let transcripts: ReturnType<typeof createServerRemoteTranscripts> | undefined
    let meters: ReturnType<typeof createServerRemoteMeters> | undefined
    let httpServer: http.Server | undefined
    const sockets: WebSocket[] = []
    let bodyFailed = false
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
      fs.writeFileSync(config, `Host *\n  UserKnownHostsFile ${known}\n  GlobalKnownHostsFile ${known}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n`)
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
      const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
      const history = path.join(remote, '.nodeterm', 'claude-accounts', 'managed', 'projects', 'repo')
      fs.mkdirSync(history, { recursive: true })
      const usage = (tokens: number) => JSON.stringify({ type: 'assistant', message: {
        model: 'claude-sonnet-4', usage: { input_tokens: tokens } } }) + '\n'
      const transcript = path.join(history, `${sid}.jsonl`)
      fs.writeFileSync(transcript, usage(123))
      const decoy = path.join(remote, '.claude', 'projects', 'repo'); fs.mkdirSync(decoy, { recursive: true })
      fs.writeFileSync(path.join(decoy, `${sid}.jsonl`), usage(999999))
      const settings = structuredClone(DEFAULT_SETTINGS)
      settings.claudeAccounts = [{ id: 'managed', label: 'Remote account', host: sshHostKey(connection), createdAt: 1 }]
      settings.codexAccounts = [{ id: 'managed', label: 'Remote Codex', host: sshHostKey(connection) }]
      const node = { id: 'remote-node', kind: 'terminal', agentId: 'claude', accountId: 'managed', agentSessionId: sid,
        title: 'Remote', cwd: remote, color: '#000', group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } } as CanvasNodeState
      const ownerPlatform = new ServerPlatform({ userDataDir: root, appVersion: 'test' })
      initPlatform(ownerPlatform)
      let runtime: object = {}
      transcripts = createServerRemoteTranscripts({ platform: ownerPlatform, enabled: true, settings: () => settings,
        sessionOf: () => sid, runtimeIdentity: () => runtime, pty: { sshRemoteForNode: () => undefined }, ssh: service,
        workspace: { projectIdsForNode: () => ['fixture'], getNodeForHostAction: () => node,
          relayNodePlacements: () => [{ projectId: 'fixture', node }], sshProjectIdForNode: () => 'fixture',
          projectTargetInfo: () => ({ name: 'Fixture', ssh: savedTarget! }) } })
      meters = createServerRemoteMeters(ownerPlatform, transcripts.captureMeter)
      const auth = new Auth(root), authToken = auth.createSession()
      httpServer = http.createServer((_q, res) => res.end())
      const revoked: number[] = []
      attachWsServer(httpServer, { platform: ownerPlatform, auth, onClientGone: id => meters!.forgetClient(id),
        onClientRevoked: id => { revoked.push(id); meters!.forgetClient(id) } })
      await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve))
      const ownerPort = (httpServer.address() as AddressInfo).port
      const open = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${ownerPort}/ws`, { headers: {
          Cookie: `${SESSION_COOKIE}=${authToken}`, Origin: `http://127.0.0.1:${ownerPort}` } })
        sockets.push(ws)
        const messages: any[] = []
        ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())) })
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
        let sequence = 0
        const rpc = async (method: string, ...args: unknown[]) => {
          const id = ++sequence; ws.send(JSON.stringify({ t: 'req', id, method, args }))
          await vi.waitFor(() => expect(messages.some(m => m.t === 'res' && m.id === id)).toBe(true))
          const response = messages.find(m => m.t === 'res' && m.id === id)
          expect(response.ok).toBe(true); return response.result
        }
        return { ws, rpc, messages, updates: () => messages.filter(m => m.channel === IPC.contextRemoteUpdate).map(m => m.args[0]) }
      }
      const owner = await open(), other = await open()
      const started = await owner.rpc(IPC.contextRemoteStart, 'remote-node')
      expect(started.status).toBe('started')
      expect(await other.rpc(IPC.contextRemoteRenew, started.leaseId)).toBe(false)
      const observe = async (tokens: number, leaseId: string) => {
        await vi.waitFor(async () => {
          expect(await owner.rpc(IPC.contextRemoteRenew, leaseId)).toBe(true)
          expect(owner.updates().at(-1)?.usage?.usedTokens).toBe(tokens)
        }, { timeout: 8_000, interval: 250 })
      }
      await observe(123, started.leaseId)
      expect(other.updates()).toEqual([])
      // Full replacement/truncation uses the new snapshot only; no old meter carry survives.
      fs.writeFileSync(transcript, usage(456))
      await observe(456, started.leaseId)
      const oldRuntime = runtime; runtime = {}
      expect(await owner.rpc(IPC.contextRemoteRenew, started.leaseId)).toBe(false)
      expect(owner.updates().at(-1)?.status).toBe('invalidated')
      runtime = oldRuntime // restoring fields does not revive the old lease
      expect(await owner.rpc(IPC.contextRemoteRenew, started.leaseId)).toBe(false)
      // Same saved node, different harness: use the existing Codex parser and managed remote home.
      node.agentId = 'codex'; runtime = {}
      const codexRoot = path.join(remoteCodexHome(remote, 'managed'), 'sessions', '2026', '11', '04')
      fs.mkdirSync(codexRoot, { recursive: true })
      fs.writeFileSync(path.join(codexRoot, `rollout-${sid}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n' +
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }) + '\n' +
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
          last_token_usage: { input_tokens: 789 }, total_token_usage: { input_tokens: 99999 }, model_context_window: 200000 } } }) + '\n')
      const codex = await owner.rpc(IPC.contextRemoteStart, 'remote-node')
      await observe(789, codex.leaseId)
      expect(owner.updates().at(-1)?.usage.windowSource).toBe('transcript')
      owner.ws.close()
      await vi.waitFor(() => expect(ownerPlatform.clientIds()).toHaveLength(1))
      const reconnected = await open()
      expect(await reconnected.rpc(IPC.contextRemoteRenew, codex.leaseId)).toBe(false)
      expect((await reconnected.rpc(IPC.contextRemoteStart, 'remote-node')).status).toBe('started')
      auth.revokeSession(authToken)
      expect(revoked).toHaveLength(2) // synchronous; does not wait for close acknowledgement
      await vi.waitFor(() => expect(ownerPlatform.clientIds()).toHaveLength(0))
      expect(fs.readFileSync(known, 'utf8')).toBe(`[127.0.0.1]:${port} ${host.public}\n`)
    } catch (error) {
      bodyFailed = true
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      const release = async (action: () => unknown): Promise<void> => {
        try { await action() } catch (error) { cleanupErrors.push(error) }
      }
      try {
        await release(() => meters?.dispose())
        for (const socket of sockets) socket.terminate()
        if (httpServer) {
          await release(() => vi.waitFor(() => expect(presenceHub.peers()).toHaveLength(0)))
          await release(() => new Promise<void>(resolve => httpServer!.close(() => resolve())))
        }
        await release(() => hookServer.stop())
        await release(() => hookServer.clearNodeAuthSecretForTests())
        await release(() => transcripts?.dispose())
        await release(() => cleanupService?.close())
        await release(() => resetNativeMuxForTests())
        await release(() => resetPlatformForTests())
        for (const child of children) await release(() => child.kill())
        for (const client of clients) await release(() => client.end())
        await release(async () => {
          if (cleanupServer?.address()) {
            await new Promise<void>((resolve) => cleanupServer!.close(() => resolve()))
          }
        })
      } finally {
        if (previous === undefined) delete process.env.NODETERM_NATIVE_SSH; else process.env.NODETERM_NATIVE_SSH = previous
        if (previousConfig === undefined) delete process.env.NODETERM_TEST_SSH_CONFIG; else process.env.NODETERM_TEST_SSH_CONFIG = previousConfig
        if (previousCalls === undefined) delete process.env.NODETERM_TEST_SSH_CALLS; else process.env.NODETERM_TEST_SSH_CALLS = previousCalls
      }
      if (cleanupErrors.length) {
        const error = new AggregateError(cleanupErrors, 'SSH fixture cleanup failed')
        if (bodyFailed) console.error(error)
        else throw error
      }
    }
  }, 25_000)
})
