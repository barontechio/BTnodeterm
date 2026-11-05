// Disposable headless Chromium proof. Uses CDP to inject push into the REAL worker, not a
// provider/OS delivery claim. Run: node scripts/web-push/browser-proof.cjs /absolute/evidence/dir
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const root = path.resolve(__dirname, '../..')
const dir = process.argv[2]
if (!dir || !path.isAbsolute(dir)) throw new Error('Supply an absolute evidence directory')
fs.mkdirSync(dir, { recursive: true })
const profile = fs.mkdtempSync(path.join(dir, 'chromium-profile-'))
const binary = process.env.NODETERM_TEST_CHROMIUM || '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
let browser, server, ws
const watchdog = setTimeout(() => { console.error('Browser proof exceeded 30 seconds'); process.exitCode = 1; browser?.kill(); ws?.close(); server?.closeAllConnections(); server?.close() }, 30000)
;(async () => {
  const worker = fs.readFileSync(path.join(root, 'src/renderer/public/web-push-sw.js'))
  server = http.createServer((q, r) => {
    r.setHeader('Content-Type', q.url === '/web-push-sw.js' ? 'text/javascript' : 'text/html')
    r.end(q.url === '/web-push-sw.js' ? worker : '<!doctype html><title>Disposable Web Push proof</title>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const origin = 'http://127.0.0.1:' + server.address().port
  browser = spawn(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'])
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''
    browser.stderr.on('data', x => { stderr += x; const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]) })
    browser.on('error', reject); browser.on('exit', c => reject(new Error('Browser exited: ' + c)))
  })
  ws = new WebSocket(endpoint); await new Promise(r => ws.once('open', r))
  let seq = 0
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    const listener = raw => { const m = JSON.parse(raw); if (m.id !== id) return; ws.off('message', listener); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) }
    ws.on('message', listener); ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const attach = async targetId => (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId
  const evaluate = async (sessionId, expression) => { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value }
  const { targetId } = await call('Target.createTarget', { url: origin })
  const sessionId = await attach(targetId)
  await call('Page.enable', {}, sessionId)
  await call('Page.navigate', { url: origin }, sessionId)
  await call('Browser.setPermission', { origin, permission: { name: 'notifications' }, setting: 'granted' })
  await evaluate(sessionId, `(async()=>{await navigator.serviceWorker.register('/web-push-sw.js',{scope:'/'}); const r=await navigator.serviceWorker.ready; return r.active.scriptURL})()`)
  const workerTarget = (await call('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url === origin + '/web-push-sw.js')
  assert(workerTarget, 'Real Service Worker target')
  const workerSession = await attach(workerTarget.targetId)
  // Close the only page belonging to the app origin. Worker evaluation below has no page.
  await call('Target.closeTarget', { targetId })
  const noPage = !(await call('Target.getTargets')).targetInfos.some(t => t.type === 'page' && t.url.startsWith(origin))
  assert(noPage)
  const noticeId = '12345678-1234-1234-1234-123456789abc'
  // CDP's deliverPushMessage needs a browser PushSubscription in recent Chromium. A native
  // PushEvent dispatched in the worker exercises the same real handler without FCM traffic.
  const shown = await evaluate(workerSession, `(async()=>{
    let completion; const waitUntil=promise=>{completion=promise};
    const e=new PushEvent('push',{data:JSON.stringify({v:1,noticeId:'${noticeId}',kind:'done'})});
    Object.defineProperty(e,'waitUntil',{value:waitUntil}); self.dispatchEvent(e); await completion;
    const notices=await self.registration.getNotifications(); return notices.map(n=>({title:n.title,body:n.body,data:n.data}));
  })()`)
  assert.deepEqual(shown, [{ title: 'nodeterm', body: 'An agent has finished a turn.', data: { noticeId } }])
  const result = { status: 'PASS', browser: await call('Browser.getVersion'), noApplicationPageAtPush: noPage, realServiceWorker: workerTarget.url, realPersistentNotifications: shown,
    limits: 'CDP permission grant and synthetic PushEvent in real worker; no PushSubscription/provider/OS delivery and no physical notification click. Disposable profile; production script unmodified.' }
  fs.writeFileSync(path.join(dir, 'browser-result.json'), JSON.stringify(result, null, 2))
  console.log('PASS: real Service Worker displays persistent notification with no application page (synthetic PushEvent).')
  await call('Browser.close')
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => { clearTimeout(watchdog); ws?.close(); browser?.kill(); server?.closeAllConnections(); if (server) await new Promise(r => server.close(r)) })
