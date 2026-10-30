import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { startServer } from './index'
import { Auth } from './auth'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { hookServer } from '../core/agents/hook-server'
import { testTmpDir } from '../core/test-tmp'
import { IPC } from '../shared/ipc'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import type { RpcRequest } from '../shared/rpc'

const run = promisify(execFile)

describe.skipIf(process.platform === 'win32')('generated CLI through a real Server boot, hook authentication and owner WS', () => {
  it('persists canvas commands, refuses cross-project mutations and individually confirms settings', async () => {
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    const root = testTmpDir('canvas-e2e-'); const dataDir = path.join(root, 'data'); const cwd = path.join(root, 'project')
    fs.mkdirSync(dataDir); fs.mkdirSync(cwd)
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const store = new WorkspaceStore()
    const source = { id: 'source', kind: 'terminal' as const, agentId: 'claude' as const, title: 'Builder', color: '#000', group: null,
      position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, cwd }
    await store.save({ version: 2, activeProjectId: 'p', projects: [
      { id: 'p', name: 'Project', cwd, color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [source] },
      { id: 'other', name: 'Other', color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ ...source, id: 'private' }] }
    ] })
    const auth = new Auth(dataDir); auth.setPassword('fixture-password'); const session = auth.createSession()
    let socket: WebSocket | undefined
    const server = await startServer({ dataDir, rendererDir: path.join(root, 'no-renderer'), host: '127.0.0.1', port: 0,
      headless: false, insecureHttp: false, installHooks: false, licenseEnabled: true, canvasControl: true, controlScope: 'project' })
    try {
      const shim = path.join(dataDir, 'canvas-control', 'nodeterm.sh')
      const env = { ...process.env, NODETERM_CANVAS_CONTROL: '1', NODETERM_NODE_ID: 'source', NODETERM_HOOK_ENDPOINT: hookServer.endpointFilePath() }
      const cli = async (...args: string[]) => (await run('/bin/sh', [shim, ...args], { env, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout
      expect(await cli('capabilities')).toContain('server canvas control: enabled')
      expect(await cli('place', '--nodes', 'source', '--x', '48', '--y', '96')).toContain('placed')
      const saved = (await store.load()).projects.find((p) => p.id === 'p')!
      expect(saved.nodes[0].position).toEqual({ x: 48, y: 96 })
      await expect(cli('place', '--nodes', 'private', '--x', '1', '--y', '2')).rejects.toThrow()
      expect((await store.load()).projects.find((p) => p.id === 'other')!.nodes[0].position).toEqual({ x: 0, y: 0 })
      expect(await cli('show-web', '--url', 'https://example.invalid/demo')).toContain('showing web preview')
      expect((await store.load()).projects.find((p) => p.id === 'p')!.nodes.some((n) => n.kind === 'web' && n.url === 'https://example.invalid/demo')).toBe(true)

      // The hook and control requests use the real, host-minted per-node capability.
      const token = fs.readFileSync(path.join(dataDir, 'node-tokens/source'), 'utf8').trim()
      const hookStatus = await new Promise<number>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: hookServer.getPort(), path: '/hook/claude', method: 'POST',
          headers: { 'x-nodeterm-hook-token': hookServer.getToken(), 'content-type': 'application/x-www-form-urlencoded', 'x-nodeterm-node-token': token } },
          (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)) })
        request.on('error', reject)
        request.end(new URLSearchParams({ nodeId: 'source', payload: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fixture-session', cwd }) }).toString())
      })
      expect(hookStatus).toBe(204)
      // Saved identity and a signed hook are insufficient for terminal input: there is no live
      // verified foreground pane in this fixture. The real CLI must receive a pre-send refusal.
      await expect(cli('write', '--node', 'source', '--text', 'do not dispatch')).rejects.toMatchObject({
        stderr: expect.stringContaining('write-refused:')
      })

      socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie: `nt_session=${session}` } })
      let requestId = 0
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
      const prompts: OwnerConfirmation[] = []
      socket.on('message', (data, binary) => {
        if (binary) return
        const message = JSON.parse(data.toString())
        if (message.t === 'res') {
          const entry = pending.get(message.id); pending.delete(message.id)
          if (message.ok) entry?.resolve(message.result); else entry?.reject(new Error(message.error.message))
        }
        if (message.t === 'ev' && message.channel === IPC.ownerConfirmationRequest) prompts.push(message.args[0])
      })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
      const request = (method: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
        const id = ++requestId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ t: 'req', id, method, args } satisfies RpcRequest))
      })
      expect(await request(IPC.licenseCapabilities)).toMatchObject({ enabled: true, hostContext: 'server' })
      expect(await request(IPC.licenseStatus)).toMatchObject({ active: false })
      expect(await request(IPC.watchLinkCreate, { nodeId: 'source', role: 'viewer', ttlSeconds: 3600, label: 'Fixture', title: 'Builder' })).toEqual({ ok: false, error: 'not-entitled' })
      await request(IPC.ownerConfirmationConnect)
      const changing = cli('settings', '--set', 'gridSize', '--value', '40')
      void changing.catch(() => {})
      await vi.waitFor(() => expect(prompts).toHaveLength(1))
      const prompt = prompts[0]
      expect(prompt.action).toBe('settings')
      const settingsPath = path.join(dataDir, 'settings.json')
      expect(fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')).gridSize : undefined).not.toBe(40)
      await request(IPC.ownerConfirmationDecide, { id: prompt.id, token: prompt.token, proof: prompt.proof, answer: 'approve' })
      expect(await changing).toContain('changed gridSize')
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).gridSize).toBe(40)
    } finally {
      socket?.terminate(); await server.close(); resetPlatformForTests(); vi.unstubAllEnvs()
    }
  }, 30_000)
})
