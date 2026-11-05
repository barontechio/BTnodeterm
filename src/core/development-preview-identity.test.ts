import { it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { testTmpDir } from './test-tmp'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { WorkspaceStore } from './workspace-store'
import { PtyManager } from './pty-manager'
import { registerDevelopmentPreviewService } from '../server/development-preview-service'
import { IPC } from '../shared/ipc'
import type { DevelopmentPreviewRecord } from '../shared/development-preview'

const supported = process.platform === 'linux' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    execFileSync('script', ['--version'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()

// Adapted from the independent retry71a9 reproducer. Manager, attached tmux client,
// processes and sockets are real; only native node-pty Session registration is seeded.
it.skipIf(!supported).each(['tmux', 'zellij', 'raw', 'argv', 'argv-middle', 'argv-two-empty'])(
  'refuses foreign socket/unsupported %s and preserves exact empty argv', async backend => {
    expect(process.env.TMUX_TMPDIR).toBeTruthy()
    expect(process.env.TMUX_TMPDIR).not.toBe('/tmp')
    const emptyArgs = backend.startsWith('argv')
    const root = testTmpDir('preview-35bc-regression-')
    const script = path.join(root, 'app.cjs'), ready = path.join(root, 'ready')
    let port = 19000
    for (; port < 19100; port++) {
      const server = net.createServer()
      const free = await new Promise<boolean>(resolve => {
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
      })
      if (free) break
    }
    fs.writeFileSync(script, "const fs=require('fs');const [ready,port]=process.argv.slice(2);require('http').createServer((q,r)=>r.end('fixture-service')).listen(Number(port),'127.0.0.1',()=>fs.writeFileSync(ready,String(process.pid)))")
    const node = `identity-${process.pid}`, session = `nt-${node}`
    const run = (socket: string, args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { stdio: 'pipe' })
    let service: ReturnType<typeof registerDevelopmentPreviewService> | undefined
    let gateway: http.Server | undefined
    let client: ReturnType<typeof spawn> | undefined
    try {
      if (!emptyArgs) run('node-terminal', ['new-session', '-d', '-s', session, 'sleep 60'])
      const suffix = backend === 'argv-middle' ? ['', 'middle'] : backend === 'argv-two-empty' ? ['', ''] : emptyArgs ? [''] : []
      run(emptyArgs ? 'node-terminal' : 'nodeterm-rmt', ['new-session', '-d', '-s', session, process.execPath, script, ready, String(port), ...suffix])
      for (let i = 0; i < 100 && (!fs.existsSync(ready) || !fs.readFileSync(ready, 'utf8')); i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const pid = Number(fs.readFileSync(ready, 'utf8'))
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      argv.pop()
      if (emptyArgs) expect(argv).toContain('')
      const platform = fakePlatform({ userDataDir: root, isOwnerClient: id => id === 1 })
      resetPlatformForTests(); initPlatform(platform)
      const workspace = new WorkspaceStore()
      await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'p', color: '#aaa',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: node, kind: 'terminal', title: 'n', group: null,
          color: '#aaa', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }] }] })
      client = spawn('script', ['-q', '-c', `tmux -L node-terminal attach-session -t ${session}`, '/dev/null'],
        { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TERM: 'xterm' } })
      let clientPid = 0
      for (let i = 0; i < 100 && !clientPid; i++) {
        clientPid = Number(run('node-terminal', ['list-clients', '-t', session, '-F', '#{client_pid}']).toString().trim())
        if (!clientPid) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(clientPid).toBeGreaterThan(0)
      const pty = new PtyManager()
      const internal = pty as unknown as { tmuxPath: string; sessions: Map<string, unknown> }
      internal.tmuxPath = 'tmux'
      internal.sessions.set('fixture', { nodeId: node, persistKey: node, tmuxBacked: backend !== 'raw',
        zellij: backend === 'zellij', proc: { pid: clientPid } })
      const compose = (approved: string[]) => registerDevelopmentPreviewService({ platform, workspace, pty,
        config: { origin: 'https://preview.example.net', approved: [{ projectId: 'p', nodeId: node, port, argv: approved }] },
        appOrigin: 'https://app.example.com', managementPorts: () => [] })
      const list = () => platform.handlers[IPC.developmentPreviewList](1, { projectId: 'p', nodeId: node }) as Promise<DevelopmentPreviewRecord[]>
      service = compose(argv.filter(Boolean))
      expect(await list()).toEqual([])
      if (!emptyArgs) return
      service.stop()
      service = compose(argv)
      const exact = await list()
      expect(exact).toHaveLength(1)
      const origin = await platform.handlers[IPC.developmentPreviewOpen](1, exact[0].id) as string
      gateway = http.createServer((req, res) => { void service!.transport!.handle(req, res) })
      gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: (gateway!.address() as net.AddressInfo).port, headers: { host: new URL(origin).host } }, res => {
          let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve(text))
        }).on('error', reject)
      })
      expect(body).toBe('fixture-service')
    } finally {
      client?.stdin?.end(); client?.kill(); service?.stop(); gateway?.closeAllConnections()
      if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()))
      for (const socket of ['node-terminal', 'nodeterm-rmt']) {
        try { run(socket, ['kill-session', '-t', `=${session}`]) } catch { /* absent */ }
      }
      resetPlatformForTests()
    }
  }, 20_000)
