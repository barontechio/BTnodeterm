import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { testTmpDir } from './test-tmp'
import type { PtyManager } from './pty-manager'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { WorkspaceStore } from './workspace-store'
import { registerDevelopmentPreviewService } from '../server/development-preview-service'
import { IPC } from '../shared/ipc'
import type { DevelopmentPreviewRecord } from '../shared/development-preview'
import { parseApprovedDevelopmentServices } from './development-preview-authority'
import { createHttpHandler } from '../server/http'
import { attachWsServer } from '../server/ws'
import { ServerPlatform } from '../server/platform-server'
import { Auth } from '../server/auth'

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()
const tmuxSocket = `preview-${process.pid}-${Math.random().toString(36).slice(2)}`
afterAll(() => { if (hasTmux) { try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }) } catch { /* absent */ } } })

it('requires exact approved commands and refuses management, privileged and arbitrary targets', () => {
  const base = { projectId: 'p', nodeId: 'n', port: 3000, argv: ['node', '/app/vite.js'] }
  expect(parseApprovedDevelopmentServices(JSON.stringify([base]))).toEqual([base])
  for (const change of [{ port: 80 }, { port: 9229 }, { port: 60000 }, { argv: ['node', '--inspect=3000', 'app.js'] }, { argv: ['chromium', '--remote-debugging-port=3000'] }, { argv: [] }]) {
    expect(() => parseApprovedDevelopmentServices(JSON.stringify([{ ...base, ...change }]))).toThrow()
  }
})

describe.skipIf(process.platform !== 'linux' || !hasTmux)('real local tmux development gateway', () => {
  it('discovers an approved process, verifies its accepted socket, relays HTTP/HMR and revokes on generation change', async () => {
    const root = testTmpDir('preview-real-')
    const ready = path.join(root, 'ready.json')
    const script = path.join(root, 'dev.cjs')
    // Probe a free non-ephemeral port; the child refuses if an unrelated process wins the bind.
    let port = 18000
    for (; port < 18100; port++) {
      const probe = net.createServer()
      const free = await new Promise<boolean>(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))) })
      if (free) break
    }
    const wsPath = require.resolve('ws')
    fs.writeFileSync(script, `const http=require('node:http');const fs=require('node:fs');const {WebSocketServer}=require(${JSON.stringify(wsPath)}); const s=http.createServer((q,r)=>r.end('real app'));const w=new WebSocketServer({server:s});w.on('connection',c=>c.on('message',d=>c.send(d)));s.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid})));`)
    execFileSync('tmux', ['-L', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'nt-web', `${process.execPath} ${script}`])
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(ready)).toBe(true)
    const { pid } = JSON.parse(fs.readFileSync(ready, 'utf8'))
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    let generation: object | undefined = {}
    let owner = true
    const wrapper = path.join(root, 'tmux-wrapper')
    fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$2" = node-terminal ]; then shift 2; exec tmux -L '${tmuxSocket}' "$@"; fi
echo 'no server running' >&2
exit 1
`, { mode: 0o700 })
    const platform = fakePlatform({ userDataDir: root, isOwnerClient: id => owner && id === 1 })
    resetPlatformForTests(); initPlatform(platform)
    const workspace = new WorkspaceStore()
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Preview', color: '#6ac4dc',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'web', kind: 'terminal', title: 'dev', group: null,
        color: '#6ac4dc', size: { width: 720, height: 520 }, position: { x: 0, y: 0 } }] }] })
    const service = registerDevelopmentPreviewService({ platform, workspace,
      pty: { getTmuxBin: () => wrapper, nodeExecutionIdentity: () => generation } as unknown as PtyManager,
      config: { origin: 'https://preview.example.net', approved: [{ projectId: 'p', nodeId: 'web', port, argv }] },
      appOrigin: 'https://app.example.com', managementPorts: () => [] })
    const transport = service.transport!
    const list = (projectId = 'p') => platform.handlers[IPC.developmentPreviewList](1, { projectId, nodeId: 'web' }) as Promise<DevelopmentPreviewRecord[]>
    const open = (id: string) => platform.handlers[IPC.developmentPreviewOpen](1, id) as Promise<string>
    const auth = new Auth(root)
    const gateway = http.createServer(createHttpHandler({ auth, rendererDir: root, publicOrigin: 'https://app.example.com', developmentPreviews: transport }))
    const appSockets = attachWsServer(gateway, { auth, platform: new ServerPlatform({ userDataDir: root, appVersion: 'test' }), publicOrigin: 'https://app.example.com', developmentPreviews: transport })
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
    const gatewayPort = (gateway.address() as net.AddressInfo).port
    let ws: WebSocket | undefined
    try {
      expect(() => platform.handlers[IPC.developmentPreviewList](2, { projectId: 'p', nodeId: 'web' })).toThrow('owner-required')
      expect(await list('other')).toEqual([])
      const records = await list()
      expect(records).toHaveLength(1)
      const origin = await open(records[0].id)
      const host = new URL(origin).host
      const reserved = await new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: gatewayPort, path: '/login', headers: { host: 'unknown.preview.example.net:444' } }, res => { res.resume(); resolve(res.statusCode!) }).on('error', reject)
      })
      expect(reserved).toBe(403)
      const response = await new Promise<{ body: string; csp: string; cors: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: gatewayPort, headers: { host, origin: 'null' } }, res => {
          let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ body, csp: String(res.headers['content-security-policy']), cors: String(res.headers['access-control-allow-origin']) }))
        }).on('error', reject)
      })
      expect(response.body).toBe('real app')
      expect(response.csp).toContain('sandbox allow-scripts allow-forms'); expect(response.csp).not.toContain('allow-same-origin')
      expect(response.cors).toBe('null')
      ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, { headers: { host, origin: 'null' } })
      await once(ws, 'open')
      const reply = once(ws, 'message'); ws.send('hmr'); expect((await reply)[0].toString()).toBe('hmr')
      const closed = once(ws, 'close'); generation = {}; await closed
      await expect(open(records[0].id)).rejects.toThrow()
      const newer = await list()
      expect(newer).toHaveLength(1)
      fs.unlinkSync(ready)
      execFileSync('tmux', ['-L', tmuxSocket, 'respawn-pane', '-k', '-t', 'nt-web:0.0', `${process.execPath} ${script}`])
      for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(JSON.parse(fs.readFileSync(ready, 'utf8')).pid).not.toBe(pid)
      await expect(open(newer[0].id)).rejects.toThrow()
      const finalRecords = await list()
      const finalOrigin = await open(finalRecords[0].id)
      ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, { headers: { host: new URL(finalOrigin).host, origin: 'null' } })
      await once(ws, 'open')
      const departed = once(ws, 'close'); service.forgetClient(1); await departed
      await expect(open(finalRecords[0].id)).rejects.toThrow()
      owner = false
      expect(() => list()).toThrow('owner-required')
    } finally {
      ws?.terminate(); service.stop(); appSockets.close(); gateway.closeAllConnections()
      await new Promise<void>(resolve => gateway.close(() => resolve()))
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-session', '-t', '=nt-web'])
      resetPlatformForTests()
    }
  }, 20_000)
})
