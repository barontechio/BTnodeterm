// Experiment: edge (rope/bridge) loss after a burst of `open-agent` on the Server Edition with ONE
// real browser tab attached. Boots a real server (this worktree, or the deployed build when
// EDGE_LOSS_SERVER=deployed names its main.cjs), serves the real renderer bundle to a real headless
// Chromium (Playwright's binary), taps the tab's WebSocket (every canvas:mut / server-change frame
// in, every workspace:save out), fires the burst through the hook server's /control route with the
// real per-node token, and records every write of the project file. Writes a JSON evidence file to
// EDGE_LOSS_OUT. Opt-in (EDGE_LOSS_E2E=1): it needs the Playwright Chromium binary and a built
// out/renderer, and the agents it launches leave their own temp entries behind, so the ordinary
// suite never runs it. Variants: EDGE_LOSS_TABS=2 (the reproduction), EDGE_LOSS_SWITCH=1,
// EDGE_LOSS_GROUP=1, EDGE_LOSS_POST_GROUP=1, EDGE_LOSS_SERVER=deployed (+ EDGE_LOSS_DEPLOYED_MAIN).
// Example: EDGE_LOSS_E2E=1 EDGE_LOSS_TABS=2 EDGE_LOSS_OUT=/tmp/x.json npx vitest run test/server/open-edge-loss.e2e.test.ts
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { hookServer } from '../../src/core/agents/hook-server'
import { initPlatform } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { testTmpDir } from '../../src/core/test-tmp'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { Auth } from '../../src/server/auth'
import { startServer } from '../../src/server/index'
import type { Project, Workspace } from '../../src/shared/types'

const CHROMIUM =
  process.env.NODETERM_TEST_CHROMIUM || '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
const DEPLOYED = process.env.EDGE_LOSS_SERVER === 'deployed' ? process.env.EDGE_LOSS_DEPLOYED_MAIN || '/app/out/server/main.cjs' : ''
const OUT = process.env.EDGE_LOSS_OUT || ''
const GROUP = process.env.EDGE_LOSS_GROUP === '1'
const POST_GROUP = process.env.EDGE_LOSS_POST_GROUP === '1'
/** Alternate the tab between two projects while the burst lands (the field user works in two). */
const SWITCH = process.env.EDGE_LOSS_SWITCH === '1'
/** A second tab on the same project (the solo gate opens: tabs publish their canvas:mut). */
const TABS = Number(process.env.EDGE_LOSS_TABS || '1')
const BURST: Array<{ title: string; at: number }> = [
  { title: 'burst-a', at: 0 },
  { title: 'burst-b', at: 0 },
  { title: 'burst-c', at: 400 },
  { title: 'burst-d', at: 1000 },
  { title: 'burst-e', at: 1000 },
  { title: 'burst-f', at: 1400 },
  { title: 'burst-g', at: 2400 },
  { title: 'burst-h', at: 2800 }
]
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = async (): Promise<number> => {
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const port = (srv.address() as net.AddressInfo).port; srv.close(); await once(srv, 'close'); return port
}
const edgeIds = (p: Pick<Project, 'ropes' | 'bridges' | 'nodes'>) => ({
  nodes: p.nodes.map((n) => n.id), ropes: (p.ropes ?? []).map((e) => e.id), bridges: (p.bridges ?? []).map((e) => e.id)
})

/** The browser-side wire tap, installed before the page's own scripts run. */
const TAP_SCRIPT = `(() => {
  const tap = { frames: [], console: [] }; window.__tap = tap; const t0 = performance.timeOrigin + performance.now();
  const now = () => Math.round(performance.timeOrigin + performance.now() - t0);
  const ids = (p) => ({ id: p.id, nodes: (p.nodes||[]).map(n => n.id), ropes: (p.ropes||[]).map(e => e.id), bridges: (p.bridges||[]).map(e => e.id) });
  const saves = new Map();
  const Orig = window.WebSocket;
  class TapWS extends Orig {
    constructor(...a) { super(...a); this.addEventListener('message', (ev) => { try {
      if (typeof ev.data !== 'string') return; const m = JSON.parse(ev.data);
      if (m.t === 'ev' && m.channel === 'canvas:mut') { const mu = m.args[1]; tap.frames.push({ at: now(), dir: 'in', ch: 'canvas:mut', project: m.args[0], op: mu.op, kind: mu.kind, id: mu.op === 'upsert' ? mu.node.id : mu.op === 'edge-upsert' ? mu.edge.id : mu.id, seq: mu.seq, src: mu.src, origin: mu.origin }) }
      else if (m.t === 'ev' && m.channel === 'workspace:server-change') tap.frames.push({ at: now(), dir: 'in', ch: 'server-change', ...ids(m.args[0]) })
      else if (m.t === 'ev' && m.channel === 'workspace:external-change') tap.frames.push({ at: now(), dir: 'in', ch: 'external-change', ...ids(m.args[0]) })
      else if (m.t === 'res' && saves.has(m.id)) tap.frames.push({ at: now(), dir: 'in', ch: 'workspace:save:res', req: m.id, ok: m.ok, error: m.ok ? undefined : m.error })
    } catch {} }) }
    send(data) { try { if (typeof data === 'string') { const m = JSON.parse(data);
      if (m.t === 'req' && m.method === 'workspace:save') { saves.set(m.id, 1); tap.frames.push({ at: now(), dir: 'out', ch: 'workspace:save', req: m.id, projects: (m.args[0].projects||[]).map(ids) }) }
      else if ((m.t === 'req' || m.t === 'cast') && /^canvas:mut/.test(m.method)) tap.frames.push({ at: now(), dir: 'out', ch: m.method, detail: JSON.stringify(m.args[1]).slice(0, 240) })
    } } catch {} return super.send(data) }
  }
  window.WebSocket = TapWS;
  for (const level of ['warn', 'error', 'log']) { const orig = console[level].bind(console); console[level] = (...a) => { try { const text = a.map(String).join(' '); if (/canvas|workspace|save|edge|rope|bridge|server-change/i.test(text)) tap.console.push({ at: now(), level, text: text.slice(0, 300) }) } catch {} ; orig(...a) } }
})()`

interface Cdp { call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>; events: Array<{ method: string; params: any }> }
async function connectCdp(endpoint: string): Promise<Cdp> {
  const ws = new WebSocket(endpoint); await once(ws, 'open')
  let serial = 0
  const events: Array<{ method: string; params: any }> = []
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id !== undefined) { const w = waiting.get(m.id); waiting.delete(m.id); if (!w) return; m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) }
    else if (m.method) events.push({ method: m.method, params: m.params })
  })
  return {
    events,
    call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++serial; waiting.set(id, { resolve, reject })
      setTimeout(() => { if (waiting.delete(id)) reject(new Error('CDP timeout ' + method)) }, 15_000)
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

function parseEndpointEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line); if (!m) continue
    let v = m[2]!.trim(); if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'")
    out[m[1]!] = v
  }
  return out
}

function post(url: string, headers: Record<string, string>, body: string, extra: http.RequestOptions = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers, ...extra }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject); req.end(body)
  })
}

describe.skipIf(process.env.EDGE_LOSS_E2E !== '1' || !fs.existsSync(CHROMIUM) || !hasTmux || process.platform === 'win32')('edge loss after an open-agent burst with one real browser tab', () => {
  it('keeps every rope and bridge the factory wrote', async () => {
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    const root = testTmpDir('edge-loss-'); const dataDir = path.join(root, 'data'); const cwd = path.join(root, 'project')
    fs.mkdirSync(dataDir); fs.mkdirSync(cwd)
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const seedStore = new WorkspaceStore()
    const source = { id: 'source', kind: 'terminal' as const, agentId: 'codex' as const, title: 'Orchestrator', color: '#000', group: null,
      position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, cwd }
    const frame = { id: 'frame', kind: 'group' as const, title: 'Team', color: '#0a84ff', group: null,
      position: { x: 800, y: 0 }, size: { width: 700, height: 500 } }
    const otherCwd = path.join(root, 'other'); fs.mkdirSync(otherCwd)
    await seedStore.save({ version: 2, activeProjectId: 'p', projects: [
      { id: 'p', name: 'Project', cwd, color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: GROUP ? [frame, source] : [source], bridges: [], ropes: [] },
      ...(SWITCH ? [{ id: 'q', name: 'Other', cwd: otherCwd, color: '#ff9f0a', viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [{ ...source, id: 'other-source', title: 'Other terminal', agentId: undefined, cwd: otherCwd }], bridges: [], ropes: [] }] : [])
    ] })
    const projectFile = path.join(cwd, '.nodeterm', 'project.json')
    // Every write of the project file, as it lands.
    const fileHistory: Array<{ at: number; rev?: number; nodes: string[]; ropes: string[]; bridges: string[] }> = []
    const t0 = Date.now()
    let lastRaw = ''
    const readFile = () => { try { const raw = fs.readFileSync(projectFile, 'utf8'); if (raw === lastRaw) return; lastRaw = raw; const p = JSON.parse(raw); fileHistory.push({ at: Date.now() - t0, rev: p.rev, ...edgeIds(p) }) } catch { /* mid-rename */ } }
    const watcher = fs.watch(path.dirname(projectFile), () => readFile())
    const poll = setInterval(readFile, 20)

    let httpPort = 0; let cookie = ''; let close: () => Promise<void> = async () => {}; let child: ChildProcess | undefined
    const childLog: string[] = []
    if (DEPLOYED) {
      httpPort = await freePort()
      child = spawn(process.execPath, [DEPLOYED, '--data-dir', dataDir, '--port', String(httpPort), '--host', '127.0.0.1',
        '--renderer-dir', path.join(path.dirname(DEPLOYED), '..', 'renderer'), '--canvas-control', '1'],
        { env: { ...process.env, NODETERM_SERVER_PASSWORD: 'fixture-password', NODETERM_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', (d) => childLog.push(String(d))); child.stderr!.on('data', (d) => childLog.push(String(d)))
      for (let i = 0; i < 400; i++) { if (childLog.join('').includes('listening on')) break; await sleep(50) }
      if (!childLog.join('').includes('listening on')) throw new Error('deployed server did not boot: ' + childLog.join(''))
      const login = await post(`http://127.0.0.1:${httpPort}/auth/login`, { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${httpPort}` }, 'password=fixture-password')
      const setCookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('nt_session='))
      if (!setCookie) throw new Error('login failed: ' + login.status + ' ' + login.body.slice(0, 200))
      cookie = setCookie.split(';')[0]!.split('=')[1]!
      close = async () => { child?.kill('SIGTERM'); await sleep(500); child?.kill('SIGKILL') }
    } else {
      const auth = new Auth(dataDir); auth.setPassword('fixture-password'); cookie = auth.createSession()
      const server = await startServer({ dataDir, rendererDir: path.resolve('out/renderer'), host: '127.0.0.1', port: 0,
        headless: false, insecureHttp: false, installHooks: false, licenseEnabled: false, canvasControl: true, controlScope: 'project' })
      httpPort = server.port; close = server.close
    }
    const endpointFile = path.join(dataDir, 'hook-endpoint.env')
    for (let i = 0; i < 200 && !fs.existsSync(endpointFile); i++) await sleep(50)
    const endpoint = parseEndpointEnv(endpointFile)
    const hookPort = Number(endpoint.NODETERM_HOOK_PORT || (DEPLOYED ? 0 : hookServer.getPort()))
    const hookToken = endpoint.NODETERM_HOOK_TOKEN || (DEPLOYED ? '' : hookServer.getToken())
    const nodeTokenFile = path.join(dataDir, 'node-tokens', 'source')
    for (let i = 0; i < 200 && !fs.existsSync(nodeTokenFile); i++) await sleep(50)

    const profile = path.join(root, 'profile')
    const chrome = spawn(CHROMIUM, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-proxy-server',
      '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const devtools = await new Promise<string>((resolve, reject) => {
      let out = ''; chrome.stderr!.on('data', (d) => { out += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(out); if (m) resolve(m[1]!) })
      chrome.on('error', reject); chrome.on('exit', (code) => reject(new Error('chromium exited ' + code)))
    })
    const results: Record<string, unknown> = {}
    try {
      const cdp = await connectCdp(devtools)
      const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
      const origin = `http://127.0.0.1:${httpPort}`
      await cdp.call('Network.enable', {}, sessionId)
      await cdp.call('Page.enable', {}, sessionId)
      await cdp.call('Runtime.enable', {}, sessionId)
      await cdp.call('Network.setCookie', { name: 'nt_session', value: cookie, url: origin + '/' }, sessionId)
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: TAP_SCRIPT }, sessionId)
      await cdp.call('Page.navigate', { url: origin + '/' }, sessionId)
      const evaluate = async (expression: string) => {
        const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
        return r.result?.value
      }
      let mounted = false
      for (let i = 0; i < 400; i++) { if (await evaluate(`document.querySelectorAll('.react-flow__node').length >= 1 && !!window.__tap`)) { mounted = true; break }; await sleep(50) }
      if (!mounted) throw new Error('the tab never showed the canvas: ' + (await evaluate('document.body.innerText.slice(0,300)')))
      // Extra tabs: same browser context (same cookie), same tap, same project on screen.
      const extraEvaluate: Array<(expression: string) => Promise<any>> = []
      for (let t = 1; t < TABS; t++) {
        const { targetId: tid } = await cdp.call('Target.createTarget', { url: 'about:blank' })
        const { sessionId: sid } = await cdp.call('Target.attachToTarget', { targetId: tid, flatten: true })
        await cdp.call('Network.enable', {}, sid); await cdp.call('Page.enable', {}, sid); await cdp.call('Runtime.enable', {}, sid)
        await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: TAP_SCRIPT }, sid)
        await cdp.call('Page.navigate', { url: origin + '/' }, sid)
        const ev = async (expression: string) => { const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value }
        let ok = false
        for (let i = 0; i < 400; i++) { if (await ev(`document.querySelectorAll('.react-flow__node').length >= 1 && !!window.__tap`)) { ok = true; break }; await sleep(50) }
        if (!ok) throw new Error('extra tab never showed the canvas')
        extraEvaluate.push(ev)
      }
      await sleep(1500) // let the tab finish its boot saves

      // ---- the burst ----
      const nodeToken = fs.readFileSync(nodeTokenFile, 'utf8').trim()
      const opened: Array<{ title: string; at: number; status: number; reply: unknown }> = []
      const burstStart = Date.now()
      const switches: Array<{ at: number; to: string; active: string }> = []
      const switcher = SWITCH ? (async () => {
        // Click the other project's tab, then back, every ~700 ms for the length of the burst.
        const names = ['Other', 'Project']
        for (let i = 0; i < 12; i++) {
          await sleep(700)
          const to = names[i % 2]!
          const active = await evaluate(`(() => { const tabs = [...document.querySelectorAll('.tab')]; const t = tabs.find(e => e.querySelector('.tab__name')?.textContent === ${JSON.stringify(to)}); if (t) t.click(); return new Promise(r => setTimeout(() => r(document.querySelector('.tab.active .tab__name')?.textContent ?? ''), 150)) })()`)
          switches.push({ at: Date.now() - burstStart, to, active })
        }
        // End on the project the burst opened into, as the field tab did.
        await evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find(e => e.querySelector('.tab__name')?.textContent === 'Project'); if (t) t.click() })()`)
      })() : Promise.resolve()
      await Promise.all(BURST.map(async ({ title, at }) => {
        await sleep(at)
        const body = new URLSearchParams({ nodeId: 'source', 'arg.agent': 'claude', 'arg.prompt': 'say hello from ' + title, ...(GROUP ? { 'arg.group': 'frame' } : {}) }).toString()
        const res = await post(`http://127.0.0.1:${hookPort}/control/open-agent`, { 'x-nodeterm-hook-token': hookToken, 'x-nodeterm-node-token': nodeToken, 'content-type': 'application/x-www-form-urlencoded' }, body)
        let reply: unknown = res.body; try { reply = JSON.parse(res.body) } catch { /* text */ }
        opened.push({ title, at: Date.now() - burstStart, status: res.status, reply })
      }))
      await switcher
      await sleep(6000) // autosaves, delivery and the settle after the last open
      // ---- the field's second phase: the caller wraps each opened node in its own frame ----
      const grouped: Array<{ id: string; at: number; status: number; reply: unknown }> = []
      const createdForGroup = opened.flatMap((o) => { const r = o.reply as { result?: { ids?: string[] } }; return r?.result?.ids ?? [] })
      if (POST_GROUP) {
        const groupStart = Date.now()
        for (const id of createdForGroup) {
          const body = new URLSearchParams({ nodeId: 'source', 'arg.nodes': id, 'arg.label': 'Team ' + id.slice(-4) }).toString()
          const res = await post(`http://127.0.0.1:${hookPort}/control/group`, { 'x-nodeterm-hook-token': hookToken, 'x-nodeterm-node-token': nodeToken, 'content-type': 'application/x-www-form-urlencoded' }, body)
          let reply: unknown = res.body; try { reply = JSON.parse(res.body) } catch { /* text */ }
          grouped.push({ id, at: Date.now() - groupStart, status: res.status, reply })
          await sleep(150)
        }
        await sleep(6000)
      }
      readFile()
      const final = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Project
      const tap = await evaluate('JSON.stringify(window.__tap)')
      const extraTaps = [] as unknown[]
      for (const ev of extraEvaluate) extraTaps.push(JSON.parse(await ev('JSON.stringify(window.__tap)')))
      const createdIds = opened.flatMap((o) => { const r = o.reply as { ids?: string[]; result?: { ids?: string[] } }; return r?.ids ?? r?.result?.ids ?? [] })
      // Edge ids carry a random tail, so the opener's edges are found by their endpoints.
      const missing = createdIds.map((id) => ({ id, node: final.nodes.some((n) => n.id === id), rope: (final.ropes ?? []).some((e) => e.source === 'source' && e.target === id), bridge: (final.bridges ?? []).some((e) => e.source === 'source' && e.target === id) }))
      Object.assign(results, { server: DEPLOYED || 'worktree', group: GROUP, postGroup: POST_GROUP, switch: SWITCH, tabs: TABS, switches, grouped, opened, extraTaps, createdIds, finalFile: { rev: (final as any).rev, ...edgeIds(final) }, missing, fileHistory, tap: JSON.parse(tap), childLog: childLog.join('').split('\n').filter((l) => /canvas|workspace|save|edge/i.test(l)).slice(0, 50) })
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
      // The claim under test: every open's node AND both its edges are on disk.
      expect(missing.filter((m) => !m.node || !m.rope || !m.bridge), 'nodes whose rope or bridge did not survive on disk').toEqual([])
    } finally {
      if (OUT && !fs.existsSync(OUT)) fs.writeFileSync(OUT, JSON.stringify({ ...results, fileHistory, childLog }, null, 2))
      clearInterval(poll); watcher.close()
      chrome.kill('SIGKILL')
      await close()
    }
  }, 180_000)
})
