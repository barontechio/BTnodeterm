// Run only an EXTRACTED Server candidate, using a fresh private home and environment.
// node scripts/smoke-server-package.mjs /absolute/extracted/package /absolute/new/evidence
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const [rootArg, evidenceArg] = process.argv.slice(2)
assert(rootArg && evidenceArg && path.isAbsolute(rootArg) && path.isAbsolute(evidenceArg), 'Supply absolute package and new evidence directories')
const root = await fs.realpath(rootArg)
const evidence = path.resolve(evidenceArg)
assert(evidence !== root && !evidence.startsWith(root + path.sep), 'Evidence must be outside the package')
await fs.mkdir(evidence, { mode: 0o700 }) // Fail rather than reuse another smoke environment.
const dirs = Object.fromEntries(['home', 'data', 'tmp', 'tmux', 'profile', 'config', 'cache'].map(k => [k, path.join(evidence, k)]))
for (const dir of Object.values(dirs)) await fs.mkdir(dir, { mode: 0o700 })
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
assert.equal(pkg.version, '0.5.0-bt.1')
assert.equal(pkg.nodeTermUpdates, 'disabled')
const require = createRequire(path.join(root, 'package.json'))
for (const name of ['ws', 'node-pty', 'ssh2', 'smart-whisper']) {
  const resolved = await fs.realpath(require.resolve(name))
  assert(resolved.startsWith(root + path.sep), 'Dependency must resolve within extracted package: ' + name)
}
for (const binary of ['node-pty/build/Release/pty.node', 'smart-whisper/build/Release/smart-whisper.node']) {
  assert((await fs.stat(path.join(root, 'node_modules', binary))).isFile(), 'Missing packaged native binary: ' + binary)
}
const WebSocket = require('ws')
// Chromium's process-singleton socket must fit sockaddr_un even when evidence paths
// are long. Give only the browser a fresh short private temp directory, after all
// package validation that can reject before starting any processes.
const browserTmp = await fs.mkdtemp('/tmp/bt1-browser-')
const password = randomBytes(24).toString('hex')
// Construct from an allowlist: never inherit account homes, hook endpoints, SSH agent,
// proxy/auth tokens, NODE_OPTIONS, browser settings or application flags.
const env = { PATH: path.dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/sh',
  HOME: dirs.home, USERPROFILE: dirs.home, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
  XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, TMUX_TMPDIR: dirs.tmux,
  NODETERM_DATA_DIR: dirs.data, NODETERM_HOST: '127.0.0.1', NODETERM_PORT: '0',
  NODETERM_SERVER_PASSWORD: password }
let server, browser, ws, cdp, persistKey
let totalBudgetExceeded = false
const serverDiagnostics = { stderrBytes: 0, stderrLines: 0, warningLines: 0, errorLines: 0 }
const runtimeErrors = []
const result = { status: 'RUNNING', version: pkg.version, platform: process.platform,
  architecture: process.arch, node: process.version, nodeAbi: process.versions.modules,
  privateEnvironment: true, packageRoot: root,
  limits: 'Local extracted-package HTTP/WS and disposable Chromium UI smoke; no provider/OS/device push, production deployment, SSH target or Desktop certification.' }
// This is an explicit total budget; individual phase deadlines are upper bounds
// within it. Report its expiry directly rather than attributing it to a later phase.
const watchdog = setTimeout(() => { totalBudgetExceeded = true; server?.kill('SIGTERM'); browser?.kill('SIGTERM') }, 60000)
watchdog.unref()
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000) })]) }
  finally { clearTimeout(timer) }
  if (child.exitCode === null && child.signalCode === null) await exited
}
try {
  server = spawn('/bin/sh', [path.join(root, 'start-server.sh')], { cwd: dirs.home, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  server.stdout.on('data', chunk => { output += chunk })
  // Store no raw boot logs: setup URLs and hook tokens are private even in a disposable run.
  let stderrTail = ''
  const countDiagnostic = line => {
    if (!line) return
    serverDiagnostics.stderrLines++
    if (/warn|degrad/i.test(line)) serverDiagnostics.warningLines++
    if (/error|fail|refus|unavailable/i.test(line)) serverDiagnostics.errorLines++
  }
  server.stderr.on('data', chunk => {
    serverDiagnostics.stderrBytes += chunk.length
    const lines = (stderrTail + chunk.toString()).split('\n')
    stderrTail = lines.pop()
    for (const line of lines) countDiagnostic(line)
  })
  server.stderr.on('end', () => { countDiagnostic(stderrTail); stderrTail = '' })
  const port = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('No package listener within 25s')), 25000)
    const poll = setInterval(() => {
      const match = output.match(/listening on http 127\.0\.0\.1:(\d+)/)
      if (match) { clearTimeout(deadline); clearInterval(poll); resolve(Number(match[1])) }
    }, 50)
    server.once('error', reject)
    server.once('exit', () => { clearTimeout(deadline); clearInterval(poll); reject(new Error('Server exited before readiness')) })
  })
  const origin = `http://127.0.0.1:${port}`
  result.loopbackPort = port
  const login = await fetch(origin + '/login')
  assert.equal(login.status, 200)
  assert.match(await login.text(), /Sign in/)
  const res = await fetch(origin + '/auth/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ password }) })
  assert.equal(res.status, 303)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  const page = await fetch(origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /id="root"/)
  const capability = await fetch(origin + '/auth/web-push/capability', { headers: { cookie } })
  assert.equal(capability.status, 200)
  assert.equal((await capability.json()).available, false)
  assert.equal(await fs.stat(path.join(dirs.data, 'web-push.json')).then(() => true, () => false), false)
  result.loginAndAuthenticatedHtml = 'PASS'
  result.webPushDefaultOff = 'PASS'
  ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { cookie } })
  await once(ws, 'open')
  const rpc = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Workspace RPC timeout')), 5000)
    ws.on('message', (data, binary) => {
      if (binary) return
      const message = JSON.parse(data.toString())
      if (message.id !== 1 || message.t !== 'res') return
      clearTimeout(timer); resolve(message)
    })
    ws.send(JSON.stringify({ t: 'req', id: 1, method: 'workspace:load', args: [] }))
  })
  assert.equal(rpc.ok, true)
  result.authenticatedWorkspaceRpc = 'PASS'
  persistKey = 'bt1-smoke-' + randomBytes(8).toString('hex')
  const marker = 'BT1_PTY_OK_' + randomBytes(8).toString('hex')
  await new Promise((resolve, reject) => {
    let sessionId, output = ''
    const timer = setTimeout(() => reject(new Error('Packaged PTY echo timeout')), 10000)
    const listener = (data, binary) => {
      if (binary) {
        if (data[0] !== 1 || data.length < 3) return
        const len = data.readUInt16BE(1)
        if (data.subarray(3, 3 + len).toString() !== sessionId) return
        output += data.subarray(3 + len).toString()
        if (!output.includes(marker)) return
        clearTimeout(timer); ws.off('message', listener)
        ws.send(JSON.stringify({ t: 'cast', method: 'pty:destroy', args: [persistKey] }))
        resolve()
        return
      }
      const message = JSON.parse(data.toString())
      if (message.t !== 'res' || message.id !== 2) return
      if (!message.ok) { clearTimeout(timer); ws.off('message', listener); reject(new Error('Packaged PTY creation refused')); return }
      sessionId = message.result.sessionId
      // Split marker ensures shell input echo alone cannot satisfy the output assertion.
      ws.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: [sessionId, `printf '%s%s\\n' '${marker.slice(0, 10)}' '${marker.slice(10)}'\r`] }))
    }
    ws.on('message', listener)
    ws.send(JSON.stringify({ t: 'req', id: 2, method: 'pty:create', args: [{ cols: 80, rows: 24, cwd: dirs.home, persistKey }] }))
  })
  result.packagedNativePtyRoundTrip = 'PASS'
  ws.close()
  const chromium = process.env.NODETERM_TEST_CHROMIUM || '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
  browser = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--user-data-dir=' + dirs.profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'],
  { env: { ...env, TMPDIR: browserTmp, TMP: browserTmp, TEMP: browserTmp }, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Chromium startup timeout')), 10000)
    browser.stderr.on('data', chunk => { text += chunk; const m = text.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]) } })
    browser.once('error', reject)
    browser.once('exit', () => { clearTimeout(timer); reject(new Error('Chromium exited before CDP')) })
  })
  cdp = new WebSocket(endpoint)
  await once(cdp, 'open')
  cdp.on('message', raw => {
    const message = JSON.parse(raw)
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text)
  })
  let seq = 0
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { cdp.off('message', listener); reject(new Error('CDP timeout: ' + method)) }, 10000)
    const listener = raw => {
      const message = JSON.parse(raw)
      if (message.id !== id) return
      clearTimeout(timer); cdp.off('message', listener)
      message.error ? reject(new Error(message.error.message)) : resolve(message.result)
    }
    cdp.on('message', listener)
    cdp.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  await call('Network.enable', {}, sessionId)
  const split = cookie.indexOf('=')
  await call('Network.setCookie', { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, httpOnly: true }, sessionId)
  await call('Page.enable', {}, sessionId)
  await call('Runtime.enable', {}, sessionId)
  await call('Page.navigate', { url: origin }, sessionId)
  let ui
  for (let i = 0; i < 100; i++) {
    const evaluation = await call('Runtime.evaluate', { expression: `({title:document.title,rootChildren:document.querySelector('#root')?.children.length||0,bridge:!!window.nodeTerminal,text:document.body.innerText.slice(0,500)})`, returnByValue: true }, sessionId)
    ui = evaluation.result.value
    if (ui.bridge && ui.rootChildren > 0 && ui.text.trim().length > 0) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(ui?.bridge && ui.rootChildren > 0 && ui.text.trim().length > 0, 'Renderer must mount through the real browser bridge')
  assert.equal(runtimeErrors.length, 0, 'Browser must mount without uncaught JavaScript exceptions')
  result.browserUi = { status: 'PASS', ...ui, browser: await call('Browser.getVersion') }
  const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId)
  await fs.writeFile(path.join(evidence, 'ui.png'), Buffer.from(screenshot.data, 'base64'))
  result.status = 'PASS'
} catch (error) {
  result.status = 'FAIL'
  result.error = error.message
  process.exitCode = 1
} finally {
  cdp?.terminate(); ws?.terminate()
  await stop(browser)
  await fs.rm(browserTmp, { recursive: true, force: true })
  await stop(server)
  // A failure before the destroy cast may leave this one session alive. The private
  // TMUX_TMPDIR plus exact random session name keeps cleanup outside the live namespace.
  if (persistKey) {
    try { execFileSync('tmux', ['-L', 'node-terminal', 'kill-session', '-t', '=nt-' + persistKey], { env, stdio: 'ignore', timeout: 5000 }) } catch {}
  }
  clearTimeout(watchdog)
  result.serverExit = { code: server?.exitCode, signal: server?.signalCode }
  result.serverDiagnostics = serverDiagnostics
  if (totalBudgetExceeded) {
    result.status = 'FAIL'
    result.error = 'Smoke exceeded the explicit total budget of 60 seconds'
    process.exitCode = 1
  }
  if (result.status === 'PASS' && server?.exitCode !== 0) {
    result.status = 'FAIL'
    result.error = 'Server did not shut down cleanly'
    process.exitCode = 1
  }
  result.runtimeErrors = [...new Set(runtimeErrors)]
  await fs.writeFile(path.join(evidence, 'smoke.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: result.status, version: result.version, evidence, error: result.error }))
}
