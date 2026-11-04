// Real Chromium + IndexedDB + native WebSocket + production hosted-team protocol.
// Token issuer and core dispatch are explicit fixtures; no private backend/deployment claimed.
// NODE_PATH=$PWD/node_modules NODETERM_TEST_CHROMIUM=/path/to/chrome node test/browser-team/run.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const http = require('node:http'), { spawn } = require('node:child_process'), { once } = require('node:events')
const assert = require('node:assert/strict'), { build } = require('esbuild'), WS = require('ws')
const repo = path.resolve(__dirname, '../..')
const chromium = process.env.NODETERM_TEST_CHROMIUM || '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
if (!fs.existsSync(chromium)) throw new Error('Set NODETERM_TEST_CHROMIUM to the isolated test browser executable')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-browser-team-35bc-'))
const wait = async (read, description) => {
  for (let i = 0; i < 200; i++) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('Timed out: ' + description)
}
;(async () => {
  await build({ stdin: { contents: `export {createHostedService} from './src/core/relay/hosted-service';export {registerBrowserJoin} from './src/server/browser-join';export {browserTeamConnectPolicy} from './src/server/browser-join-policy';export {fakePlatform} from './src/core/platform-fake';export {IPC} from './src/shared/ipc';`, resolveDir: repo }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(temp, 'host.cjs') })
  const { createHostedService, registerBrowserJoin, browserTeamConnectPolicy, fakePlatform, IPC } = require(path.join(temp, 'host.cjs'))
  const browserSource = `
    import {createBrowserTeamJoin} from './src/renderer/bridge/browser-team/join';
    import {BrowserTeamStore} from './src/renderer/bridge/browser-team/store';
    import {decodeJoinCode} from './src/core/relay/join-code';
    const store=new BrowserTeamStore(undefined,'team-fixture');
    const original=store.update.bind(store);
    let mode='',release=()=>{};
    store.update=async(...args)=>{if(args[1].deviceToken&&mode==='fail-token')throw Error('fixture-quota');if(args[1].approvedAt){if(mode==='fail')throw Error('fixture-quota');if(mode==='hold')await new Promise(r=>release=r)}return original(...args)};
    const state={approved:false,closed:false,sas:null,frames:[],id:null,mode:(value)=>{mode=value},release:()=>release()};
    const broker={request:async(method,...args)=>{const res=await fetch('/broker',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});const result=await res.json();if(result.error)throw Error(result.error);return result.value}};
    const api=createBrowserTeamJoin(broker,{store});
    state.prepare=async()=>{const record=await store.prepare(decodeJoinCode(window.code),window.code);return {publicKey:record.publicKey,deviceId:record.deviceId}};
    state.connect=async()=>{state.approved=false;state.closed=false;state.sas=null;state.frames=[];state.id=await api.relayClient.connect(window.code);api.relayClient.onSas(state.id,sas=>state.sas=sas);api.relayClient.onApproved(state.id,()=>state.approved=true);api.relayClient.onClosed(state.id,reason=>{state.closed=true;state.reason=reason});api.relayClient.onFrame(state.id,json=>state.frames.push(JSON.parse(json)));return state.id};
    state.confirm=()=>api.relayClient.confirm(state.id);
    state.disconnect=()=>api.relayClient.disconnect(state.id);
    state.bookmarks=()=>api.relayHosted.bookmarks();
    state.forget=async()=>api.relayHosted.removeBookmark(decodeJoinCode(window.code).hostId);
    let serial=0;
    state.rpc=async(method,...args)=>{const id=++serial;api.relayClient.send(state.id,JSON.stringify({t:'req',id,method,args}));for(let i=0;i<200;i++){const found=state.frames.find(frame=>frame.t==='res'&&frame.id===id);if(found)return found;await new Promise(r=>setTimeout(r,10))}throw Error('RPC timeout '+method)};
    window.fixture=state;
  `
  const browserBundle = await build({ stdin: { contents: browserSource, resolveDir: repo }, bundle: true, platform: 'browser', format: 'iife', write: false, tsconfig: path.join(repo, 'tsconfig.web.json') })
  const js = browserBundle.outputFiles[0].text
  const listeners = [], sinks = new Map(), dispatched = []
  let serial = 0, code = '', service, chrome, cdp, deviceMints = 0, joinMints = 0
  const platform = fakePlatform({ isOwnerClient: id => id === 1 })
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end('window.code=' + JSON.stringify(code) + ';\n' + js); return }
      if (req.url === '/broker') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 32768) throw Error('oversized') }
        const { method, args } = JSON.parse(body)
        if (!['browser-join:device', 'browser-join:token'].includes(method)) throw Error('unknown broker method')
        const value = await platform.handlers[method](1, ...args)
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value })); return
      }
      res.setHeader('content-type', 'text/html')
      res.setHeader('Content-Security-Policy', `default-src 'self'; ${browserTeamConnectPolicy(relayUrl)}`)
      res.end('<script src="/bundle.js"></script>')
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port, url = `http://127.0.0.1:${port}`
  const relayServer = http.createServer()
  relayServer.listen(0, '127.0.0.1'); await once(relayServer, 'listening')
  const relayUrl = `ws://127.0.0.1:${relayServer.address().port}/relay`
  const wsServer = new WS.WebSocketServer({ server: relayServer, path: '/relay' })
  wsServer.on('connection', socket => {
    const listener = listeners.shift()
    if (!listener) { socket.close(); return }
    listener.attach(socket)
  })
  const transport = () => {
    let socket, message, closed, ended = false
    const wire = {
      get bufferedAmount() { return socket?.bufferedAmount ?? 0 },
      send(data) { socket?.send(data, { binary: typeof data !== 'string' }) },
      close() { if (!ended) { ended = true; socket?.close(); closed?.() } },
      onMessage(cb) { message = cb }, onClose(cb) { closed = cb }
    }
    listeners.push({ attach(ws) {
      socket = ws
      if (ended) { ws.close(); return }
      ws.on('message', (data, binary) => message?.(binary ? data : data.toString()))
      ws.on('close', () => { if (!ended) { ended = true; closed?.() } })
      ws.on('error', () => wire.close())
    } })
    return wire
  }
  const issuer = async input => {
    const target = String(input)
    if (target.endsWith('/challenge')) return new Response('{}', { status: 404 })
    if (target.endsWith('/device')) { deviceMints++; return Response.json({ deviceToken: `device-${deviceMints}` }) }
    if (target.endsWith('/join')) { joinMints++; return Response.json({ pairingToken: 'fixture', relayEndpoint: relayUrl }) }
    return Response.json({ pairingToken: 'fixture', hostId: 'fixture-host', exp: 0 })
  }
  registerBrowserJoin(platform, { apiBase: 'https://fixture.invalid', relayEndpoint: relayUrl, fetch: issuer })
  service = createHostedService({ dataDir: path.join(temp, 'host'), apiBase: 'https://fixture.invalid', relayUrl,
    deviceId: 'fixture-host', hostLabel: 'fixture', transport, fetch: issuer,
    projectsOfNode: id => [id === 'other' ? 'Q' : 'P'], nodeOfSession: id => id === 'shared-session' ? 'shared' : undefined,
    projectCwd: () => '/fixture', attach: {
      attach: sink => { const id = ++serial; sinks.set(id, sink); return id },
      detach: id => sinks.delete(id),
      cast: (_id, method) => dispatched.push(method),
      dispatch: async (_id, req) => {
        dispatched.push(req.method)
        const result = req.method === IPC.workspaceLoad ? { projects: [{ id: 'P', nodes: [] }, { id: 'Q', nodes: [] }], activeProjectId: 'P' }
          : req.method === IPC.ptyCreate ? { sessionId: 'shared-session', fresh: false } : true
        return { t: 'res', id: req.id, ok: true, result }
      }
    } })
  try {
    await service.init(); await service.share('P', true); await service.start()
    await wait(() => service.info(), 'host key loaded')
    code = service.joinCode()
    chrome = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-proxy-server', '--user-data-dir=' + path.join(temp, 'profile'), '--remote-debugging-port=0', 'about:blank'])
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      chrome.stderr.on('data', data => { output += data; const found = output.match(/DevTools listening on (ws:\/\/\S+)/); if (found) resolve(found[1]) })
      chrome.on('error', reject); chrome.on('exit', code => reject(Error('Chromium exited ' + code)))
    })
    cdp = new WS(endpoint); await once(cdp, 'open')
    let commandId = 0
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++commandId
      const timer = setTimeout(() => { cdp.off('message', receive); reject(Error('CDP timeout: ' + method)) }, 10000)
      const receive = raw => { const message = JSON.parse(raw); if (message.id !== id) return; clearTimeout(timer); cdp.off('message', receive); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result) }
      cdp.on('message', receive); cdp.send(JSON.stringify({ id, method, params, sessionId }))
    })
    const page = async (context) => {
      const browserContextId = context ?? (await call('Target.createBrowserContext')).browserContextId
      const { targetId } = await call('Target.createTarget', { url, browserContextId })
      const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
      const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
        return result.result.value
      }
      await wait(() => evaluate('!!window.fixture'), 'browser module')
      evaluate.context = browserContextId
      return evaluate
    }
    const owner = await page(), ownerIdentity = await owner('fixture.prepare()')
    await service.addOwner(ownerIdentity.publicKey, 'Browser owner')
    await owner('fixture.connect()'); await wait(() => owner('!!fixture.sas'), 'owner SAS')
    assert.equal(await owner('fixture.approved'), false)
    await owner('fixture.confirm()'); await wait(() => owner('fixture.approved'), 'owner approved')
    assert.equal((await owner('fixture.rpc("relay:hosted:self")')).result.role, 'owner')
    const sibling = await page(owner.context)
    const beforeBusy = deviceMints
    assert.match(await sibling('fixture.connect().then(()=>"unexpected",e=>e.message)'), /E_JOIN_BUSY/)
    assert.equal(deviceMints, beforeBusy)
    const results = []
    for (const role of ['viewer', 'commenter']) {
      const peer = await page(); const identity = await peer('fixture.prepare()')
      await wait(() => service.status().scheduler?.idle, 'idle relay listener')
      await peer('fixture.connect()'); await wait(() => peer('!!fixture.sas'), role + ' SAS')
      assert.equal(await peer('fixture.approved'), false)
      await peer('fixture.confirm()')
      const pending = await wait(() => service.status().pending.find(p => p.peerKeyB64 === identity.publicKey), 'host pending approval')
      assert.equal((await owner(`fixture.rpc("relay:hosted:approve",${JSON.stringify(pending.pendingId)},${JSON.stringify(role)})`)).ok, true)
      await wait(() => peer('fixture.approved'), role + ' opened')
      assert.equal((await peer('fixture.rpc("relay:hosted:self")')).result.role, role)
      const workspace = await peer(`fixture.rpc(${JSON.stringify(IPC.workspaceLoad)})`)
      assert.deepEqual(workspace.result.projects.map(project => project.id), ['P'])
      const denied = await peer(`fixture.rpc(${JSON.stringify(IPC.settingsSave)},{})`)
      assert.equal(denied.ok, false)
      const brokerDenied = await peer('fixture.rpc("browser-join:token","forged")')
      assert.equal(brokerDenied.ok, false)
      const before = dispatched.length
      const comment = await peer(`fixture.rpc(${JSON.stringify(IPC.boardLogAppend)},"P",{id:"comment-1",ts:1,text:"hello",kind:"comment",author:{name:"Browser",color:"#fff"}})`)
      assert.equal(comment.ok, role === 'commenter')
      if (role === 'viewer') assert.equal(dispatched.length, before)
      for (const sink of sinks.values()) {
        sink.sendText(JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'shared', state: 'working' }] }))
        sink.sendText(JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'other', state: 'working' }] }))
      }
      await wait(() => peer('fixture.frames.some(f=>f.t==="ev"&&f.args?.[0]?.nodeId==="shared")'), 'shared event')
      assert.equal(await peer('fixture.frames.some(f=>f.t==="ev"&&f.args?.[0]?.nodeId==="other")'), false)
      const mints = deviceMints
      await peer('fixture.disconnect()'); await wait(() => service.status().scheduler?.idle, 'reconnect listener')
      await peer('fixture.connect()'); await wait(() => peer('fixture.approved'), 'durable reconnect')
      assert.equal(deviceMints, mints)
      assert.equal(await peer('fixture.sas'), null)
      await service.remove(identity.publicKey, true)
      await wait(() => peer('fixture.closed'), 'revocation closes live socket')
      await wait(async () => !(await peer('fixture.bookmarks()'))[0].approved, 'revocation clears pin')
      results.push({ role, workspace: workspace.result.projects.map(p => p.id), reconnect: true, revoked: true })
    }
    for (const mode of ['fail', 'hold']) {
      const peer = await page(), identity = await peer('fixture.prepare()')
      await peer(`fixture.mode(${JSON.stringify(mode)})`)
      await wait(() => service.status().scheduler?.idle, 'persistence listener')
      await peer('fixture.connect()'); await wait(() => peer('!!fixture.sas'), 'persistence SAS'); await peer('fixture.confirm()')
      const pending = await wait(() => service.status().pending.find(p => p.peerKeyB64 === identity.publicKey), 'persistence pending')
      await owner(`fixture.rpc("relay:hosted:approve",${JSON.stringify(pending.pendingId)},"viewer")`)
      if (mode === 'hold') {
        await new Promise(r => setTimeout(r, 100)); assert.equal(await peer('fixture.approved'), false)
        await peer('fixture.disconnect();fixture.release()')
      }
      await wait(() => peer('fixture.closed'), 'persistence refusal closes')
      assert.equal(await peer('fixture.approved'), false)
      assert.equal((await peer('fixture.bookmarks()'))[0].approved, false)
    }
    const diskFailure = await page()
    await diskFailure('fixture.mode("fail-token")')
    const beforeDisk = deviceMints, beforeJoin = joinMints
    assert.match(await diskFailure('fixture.connect().then(()=>"unexpected",e=>e.message)'), /fixture-quota/)
    assert.match(await diskFailure('fixture.connect().then(()=>"unexpected",e=>e.message)'), /E_JOIN_KEY_LOCKED/)
    assert.equal(deviceMints, beforeDisk + 1); assert.equal(joinMints, beforeJoin)
    assert.equal((await owner('fixture.rpc("browser-join:token","forged")')).ok, false)
    await sibling('fixture.forget()')
    await wait(() => owner('fixture.closed'), 'cross-tab forget closes owner')
    assert.deepEqual(await owner('fixture.bookmarks()'), [])
    const report = { csp: browserTeamConnectPolicy(relayUrl), separateRelayOrigin: new URL(url).host !== new URL(relayUrl).host, results, crossTabLock: 'refused', crossTabForget: 'closed', tokenWriteFailure: 'blocked-no-remint', persistenceFailure: 'refused', closeDuringPin: 'refused', deviceMints, joinMints, browser: await call('Browser.getVersion') }
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ evidence: temp, ...report }, null, 2))
    await call('Browser.close')
  } finally {
    cdp?.close(); chrome?.kill(); service?.stop()
    for (const socket of wsServer.clients) socket.terminate()
    wsServer.close(); relayServer.closeAllConnections(); await new Promise(resolve => relayServer.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); console.error('Evidence directory:', temp); process.exitCode = 1 })
