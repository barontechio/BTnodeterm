import { Readable } from 'node:stream'
import { transferCommitMarker } from '../core/remote-ssh/strict-file-transfer'
import http from 'node:http'
import WebSocket from 'ws'
import { Auth } from './auth'
import { ServerPlatform } from './platform-server'
import { attachWsServer } from './ws'
import { SESSION_COOKIE } from './http'
import { createServerRemoteTransfers } from './remote-transfers'
import { TransferPrincipals } from './transfer-principals'
import { createHttpHandler } from './http'
import { createHash } from 'node:crypto'
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
describe.skipIf(process.platform !== 'linux')('SSH bulk transfers over encrypted OpenSSH/native and owner HTTP/WebSocket', () => {
  it.each(['0', '1'])('streams exact bytes, ranges and revocation over transport %s', async (native) => {
    const previous = process.env.NODETERM_NATIVE_SSH
    const previousConfig = process.env.NODETERM_TEST_SSH_CONFIG
    const previousCalls = process.env.NODETERM_TEST_SSH_CALLS
    const clients = new Set<Connection>(); const children = new Set<ChildProcess>()
    let cleanupServer: Server | undefined
    let cleanupService: ReturnType<typeof registerServerSshProjects> | undefined
    let transfers: ReturnType<typeof createServerRemoteTransfers> | undefined
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
      const node = {id: 'media', kind: 'video', filePath: path.join(remote, 'movie.mp4')} as CanvasNodeState
      const ownerPlatform = new ServerPlatform({userDataDir: root, appVersion: 'test'})
      initPlatform(ownerPlatform)
      const auth = new Auth(root), authToken = auth.createSession(), otherToken = auth.createSession()
      const principals = new TransferPrincipals(token => auth.validateSession(token))
      let runtime: object = {}
      transfers = createServerRemoteTransfers({platform: ownerPlatform, enabled: true, principals,
        settings: () => DEFAULT_SETTINGS, sessionOf: () => undefined, runtimeIdentity: () => runtime,
        pty: {sshRemoteForNode: () => undefined}, ssh: service,
        workspace: {projectTargetInfo: () => ({name: 'Fixture', ssh: savedTarget!}),
          projectIdsForNode: () => ['fixture'], getNodeForHostAction: () => node}})
      httpServer = http.createServer(createHttpHandler({auth, rendererDir: root,
        remoteTransfers: {transfers: transfers.transfers, principals}}))
      attachWsServer(httpServer, {platform: ownerPlatform, auth,
        onClientAuthenticated: (id, token) => principals.attach(id, token),
        onClientGone: id => transfers!.forgetClient(id), onClientRevoked: id => transfers!.forgetClient(id)})
      await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
      const open = async (token: string) => {
        const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {headers: {
          Cookie: `${SESSION_COOKIE}=${token}`, Origin: origin}})
        sockets.push(ws)
        const messages: any[] = []
        ws.on('message', (data, binary) => {if (!binary) messages.push(JSON.parse(data.toString()))})
        await new Promise<void>((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject)})
        let sequence = 0
        const rpc = async (method: string, ...args: unknown[]) => {
          const id = ++sequence; ws.send(JSON.stringify({t: 'req', id, method, args}))
          await vi.waitFor(() => expect(messages.some(m => m.t === 'res' && m.id === id)).toBe(true), {timeout: 8000})
          const response = messages.find(m => m.t === 'res' && m.id === id)
          expect(response.ok).toBe(true); return response.result
        }
        return {ws, rpc}
      }
      const owner = await open(authToken), other = await open(otherToken)
      const request = (url: string, init: RequestInit = {}, token = authToken) => fetch(origin + url,
        {...init, headers: {Cookie: `${SESSION_COOKIE}=${token}`, Origin: origin, ...init.headers}})
      const prepare = (kind: string, relativePath: string, extra = {}) => owner.rpc(IPC.sshTransferPrepare,
        {kind, projectId: 'fixture', relativePath, ...extra})
      // Bigger than the terminal RPC message limit: bulk bytes never travel on that socket.
      const payload = Buffer.alloc(10 * 1024 * 1024, 0x6b)
      const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
      const name = "quoted ' transfer.bin"
      const upload = await prepare('upload', name, {bytes: payload.length})
      expect(upload.status).toBe('ready')
      expect((await request(upload.url, {method: 'PUT', body: payload}, otherToken)).status).toBe(404)
      const uploaded = await request(upload.url, {method: 'PUT', body: payload})
      expect(uploaded.status).toBe(201)
      expect(await uploaded.json()).toMatchObject({outcome: 'committed', bytes: payload.length, sha256: digest(payload)})
      expect(digest(fs.readFileSync(path.join(remote, name)))).toBe(digest(payload))
      expect((await request(upload.url, {method: 'PUT', body: payload})).status).toBe(503)
      expect((await prepare('upload', name, {bytes: 1})).status).toBe('conflict')
      const revokedUpload = await prepare('upload', 'changed-before-marker.bin', {bytes: 4})
      const beforeMarkerStream = service.stream, beforeMarkerTarget = savedTarget
      let markerBlocked = false
      service.stream = (args, options) => {
        if (!options.input) return beforeMarkerStream(args, options)
        const input = options.input
        return beforeMarkerStream(args, {...options, input: Readable.from((async function* () {
          for await (const chunk of input) {
            if (Buffer.from(chunk).includes(transferCommitMarker(revokedUpload.reference))) {
              markerBlocked = true
              savedTarget = {...beforeMarkerTarget!, remoteCwd: remote + '/changed'}
            }
            yield chunk
          }
        })(), {objectMode: false})})
      }
      try { expect((await request(revokedUpload.url, {method: 'PUT', body: 'body'})).status).toBe(404) }
      finally {service.stream = beforeMarkerStream; savedTarget = beforeMarkerTarget}
      expect(markerBlocked).toBe(true)
      expect(fs.existsSync(path.join(remote, 'changed-before-marker.bin'))).toBe(false)
      const download = await prepare('download', name)
      const downloaded = await request(download.url)
      expect(downloaded.status).toBe(200)
      expect(digest(new Uint8Array(await downloaded.arrayBuffer()))).toBe(digest(payload))
      expect((await request(download.url)).status).toBe(404)
      expect((await prepare('download', '../identity')).status).toBe('unavailable')
      const movie = Buffer.alloc(4096); Buffer.from('000000186674797069736f6d', 'hex').copy(movie)
      fs.writeFileSync(node.filePath!, movie)
      const media = await prepare('media', 'movie.mp4', {nodeId: node.id})
      expect(media.status).toBe('ready')
      const range = await request(media.url, {headers: {Range: 'bytes=4-15'}})
      expect(range.status).toBe(206); expect(range.headers.get('Content-Range')).toBe('bytes 4-15/4096')
      expect(Buffer.from(await range.arrayBuffer())).toEqual(movie.subarray(4, 16))
      expect((await request(media.url, {method: 'HEAD'})).headers.get('Content-Length')).toBe('4096')
      expect((await request(media.url, {headers: {Range: 'bytes=99999-'}})).status).toBe(416)
      expect(await other.rpc(IPC.sshTransferRenew, media.reference)).toBe(false)
      fs.renameSync(node.filePath!, node.filePath! + '.old'); fs.writeFileSync(node.filePath!, movie)
      expect((await request(media.url)).status).toBe(503)
      expect(await owner.rpc(IPC.sshTransferRenew, media.reference)).toBe(false)
      const runtimeRef = await prepare('media', 'movie.mp4', {nodeId: node.id})
      expect(runtimeRef.status).toBe('ready')
      runtime = {}
      expect((await request(runtimeRef.url)).status).toBe(404)
      // Observe a transient source change in the Server adapter BEFORE its guard calls Core.
      // Restoring equivalent state must not resurrect that captured source or its reference.
      const guardRef = await prepare('media', 'movie.mp4', {nodeId: node.id})
      expect(guardRef.status).toBe('ready')
      const originalStream = service.stream, originalRuntime = runtime
      let checked = false
      service.stream = (args, options) => {
        if (!checked) {
          checked = true
          runtime = {}
          expect(options.current()).toBe(false)
          runtime = originalRuntime
          expect(options.current()).toBe(false)
        }
        return originalStream(args, options)
      }
      try { expect((await request(guardRef.url)).status).toBe(503) }
      finally {service.stream = originalStream; runtime = originalRuntime}
      expect(checked).toBe(true)
      expect(await owner.rpc(IPC.sshTransferRenew, guardRef.reference)).toBe(false)
      // An incomplete HTTP request must not publish even when its socket disappears.
      const interrupted = await prepare('upload', 'interrupted.bin', {bytes: 1024 * 1024})
      await new Promise<void>(resolve => {
        const req = http.request(origin + interrupted.url, {method: 'PUT', headers: {
          Cookie: `${SESSION_COOKIE}=${authToken}`, Origin: origin, 'Content-Length': 1024 * 1024}}, res => res.resume())
        req.on('error', () => {}); req.write(Buffer.alloc(16384))
        setTimeout(() => {req.destroy(); resolve()}, 150)
      })
      await vi.waitFor(() => expect(fs.readdirSync(remote).filter(f => f.endsWith('.part'))).toEqual([]))
      expect(fs.existsSync(path.join(remote, 'interrupted.bin'))).toBe(false)
      const abortedDownload = await prepare('download', name)
      await new Promise<void>((resolve, reject) => {
        const req = http.get(origin + abortedDownload.url, {headers: {Cookie: `${SESSION_COOKIE}=${authToken}`}}, res => {
          res.once('data', () => {res.destroy(); resolve()})
          res.on('error', () => {})
        })
        req.on('error', reject)
      })
      expect((await request(abortedDownload.url)).status).toBe(404)
      // Cancellation retains capacity until real channel close; wait for that physical release.
      let changedProject: any
      await vi.waitFor(async () => {
        changedProject = await prepare('download', name)
        expect(changedProject.status).toBe('ready')
      }, {timeout: 5000})
      const originalTarget = savedTarget
      savedTarget = {...savedTarget!, remoteCwd: remote + '/different'}
      expect((await request(changedProject.url)).status).toBe(404)
      savedTarget = originalTarget
      expect((await request(changedProject.url)).status).toBe(404)
      const beforeReconnect = await prepare('download', name)
      const generation = service.manager.connectionKeyFor('fixture')
      await call(IPC.sshDisconnectProject, 'fixture')
      expect((await request(beforeReconnect.url)).status).toBe(404)
      const sentBefore = platform.sent.length
      let reconnected = false, reconnectError: unknown
      const reconnect = call(IPC.sshConnectProject, 'fixture', connection, remote).then(() => {reconnected = true}, (error: unknown) => {reconnectError = error})
      const answered = new Set<string>()
      await vi.waitFor(async () => {
        if (reconnectError) throw reconnectError
        for (const event of platform.sent.slice(sentBefore)) {
          if (event.channel === IPC.sshPassphraseRequest && !answered.has(event.args[0].requestId)) {
            answered.add(event.args[0].requestId)
            await call(IPC.sshPassphraseSubmit, event.args[0].requestId, 'fixture-only')
          }
        }
        expect(reconnected).toBe(true)
      }, {timeout: 10000})
      await reconnect
      expect(service.manager.connectionKeyFor('fixture')).not.toBe(generation)
      expect((await request(beforeReconnect.url)).status).toBe(404)
      const departing = await prepare('download', name)
      owner.ws.close()
      await vi.waitFor(() => expect(ownerPlatform.clientIds()).toHaveLength(1))
      expect((await request(departing.url)).status).toBe(404)
      const again = await open(authToken)
      const revoked = await again.rpc(IPC.sshTransferPrepare, {kind: 'download', projectId: 'fixture', relativePath: name})
      auth.revokeSession(authToken)
      expect(principals.forCookie(authToken)).toBeUndefined()
      expect((await request(revoked.url)).status).toBe(401)
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
        await release(() => transfers?.dispose())
        for (const socket of sockets) socket.terminate()
        if (httpServer) {
          await release(() => vi.waitFor(() => expect(presenceHub.peers()).toHaveLength(0)))
          await release(() => new Promise<void>(resolve => httpServer!.close(() => resolve())))
        }
        await release(() => hookServer.stop())
        await release(() => hookServer.clearNodeAuthSecretForTests())
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
  }, 60_000)
})
