// Publication-boundary schedules reproduced by the independent phase-2 review.
import { beforeAll, afterAll, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { hookServer } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { testTmpDir } from '../core/test-tmp'
import { initContextLink, setContextLinks, handleContextLinkRequest } from '../core/context-link'
import { createServerRemoteTranscripts } from './remote-transcripts'
import { DEFAULT_SETTINGS } from '../shared/types'
const sid = '7e2f39a0-0be6-4f64-8657-6905c1508571'
const linked = {id:'target', title:'Target', agentId:'claude', sessionId:sid}
let secret: Buffer
let api: any
let afterRead = () => {}
let edge = true
let scope: any
const raw = JSON.stringify({ type:'user', message:{role:'user',content:'SECRET-CONTEXT-REVIEW'}})+'\n'
const result = {code:0, stdout:JSON.stringify({start:0,size:Buffer.byteLength(raw),data:Buffer.from(raw).toString('base64')})}
const conn = {host:'fixture',user:'fixture'}
const target:any = {id:'target',kind:'terminal',agentId:'claude',agentSessionId:sid,cwd:'/repo'}
const caller:any = {...target,id:'caller',agentSessionId:'caller-session'}
let runtime = sid, callerRuntime='caller-session', gen='g1', ids=['p']
let queued: (()=>void)|undefined
let holdQueue=false
let io: (()=>void)|undefined
let holdIO=false
let calls=0
const resumeQueue = () => queued?.()
const resumeIO = () => io?.()
beforeAll(async()=>{
 resetPlatformForTests()
 const platform=fakePlatform({userDataDir:testTmpDir('http-')}); initPlatform(platform)
 api=createServerRemoteTranscripts({platform,enabled:true,settings:()=>DEFAULT_SETTINGS,
 sessionOf:(id)=>id==='caller'?callerRuntime:runtime,
 contextPermission:(c,t)=>edge && c==='caller' && t==='target',
 pty:{sshRemoteForNode:()=>undefined}, workspace:{
 projectIdsForNode:()=>ids,getNodeForHostAction:(id)=>id==='caller'?caller:target,
 relayNodePlacements:()=>[],sshProjectIdForNode:()=> 'p',projectTargetInfo:()=>({name:'Project',ssh:{server:conn,remoteCwd:'/repo'}})},
 ssh:{refForProject:()=>({conn,controlPath:'/fixture',remoteCwd:'/repo'}),manager:{connectionKeyFor:()=>gen,
 remoteHomeForControlPath:()=>'/fixture',sshRun:async()=>{calls++; if(holdIO)await new Promise<void>(r=>{io=r});afterRead();return result}},
 withQueuedExecutionCheck:async(current,work,options)=>{if(holdQueue)await new Promise<void>(r=>{queued=r});if(!current()||options?.signal?.aborted)throw Error('stale');return work()}}})
 initContextLink({getTmuxBin:()=>null} as any,{isRemoteNode:()=>true,readRemoteTranscript:(n,s)=>{scope=s;return api.readLinkedTranscript(n,s)}})
 await setContextLinks({caller:[linked]})
 await hookServer.start()
})
afterAll(async()=>{await setContextLinks({});api.dispose();hookServer.stop();hookServer.clearNodeAuthSecretForTests();resetPlatformForTests()})
async function post(token?:string,signal?:AbortSignal,body='nodeId=caller&arg.node=target'){
 const res=await fetch(`http://127.0.0.1:${hookServer.getPort()}/context-link/transcript`,{method:'POST',signal,
 headers:{'X-Nodeterm-Hook-Token':hookServer.getToken(),'content-type':'application/x-www-form-urlencoded',...(token?{'X-Nodeterm-Node-Token':token}:{})},body})
 return {status:res.status,text:await res.text()}
}
function fresh(){secret=randomBytes(32);hookServer.setNodeAuthSecret(secret);edge=true;afterRead=()=>{};return nodeAuthToken(secret,'caller')}
const tick=()=>new Promise(r=>setTimeout(r,1))
it('real HTTP accepts valid proof but not missing, forged, or another node proof/body arguments',async()=>{
 const token=fresh();expect((await post(token)).text).toContain('SECRET-CONTEXT-REVIEW')
 expect((await post()).text).not.toContain('SECRET-CONTEXT-REVIEW')
 expect((await post(nodeAuthToken(secret,'other'))).status).toBe(403)
 expect((await post(undefined,undefined,'nodeId=caller&arg.verified=true&arg.callerId=caller')).text).not.toContain('SECRET-CONTEXT-REVIEW')
 expect(scope.signal.aborted).toBe(true);expect(scope.verified()).toBe(false)
})
it.each(['edge','caller-runtime','caller-saved','target-runtime','target-saved','account','endpoint','connection','project','abort'])(
 'queued HTTP refuses %s before dispatch',async(change)=>{
 const token=fresh();holdQueue=true;queued=undefined;const controller=new AbortController();const before=calls
 const response=post(token,controller.signal).catch(()=>({text:''}));while(!queued)await tick()
 const old={...target},oldCaller={...caller};
 if(change==='edge')edge=false
 if(change==='caller-runtime')callerRuntime='new'
 if(change==='caller-saved')caller.agentSessionId='new'
 if(change==='target-runtime')runtime='new'
 if(change==='target-saved')target.agentSessionId='new'
 if(change==='account')target.accountId='missing'
 if(change==='endpoint')conn.host='changed'
 if(change==='connection')gen='g2'
 if(change==='project')ids=['p','other']
 if(change==='abort'){controller.abort();while(!scope.signal.aborted)await tick()}
 resumeQueue();expect((await response).text).not.toContain('SECRET-CONTEXT-REVIEW');expect(calls).toBe(before)
 Object.keys(target).forEach(k=>delete target[k]);Object.assign(target,old);Object.assign(caller,oldCaller)
 runtime=sid;callerRuntime='caller-session';conn.host='fixture';gen='g1';ids=['p'];holdQueue=false
})
it('HTTP abort after dispatch rejects late IO and reused scope',async()=>{
 const token=fresh();holdIO=true;io=undefined;const controller=new AbortController()
 const response=post(token,controller.signal).catch(()=>({text:''}));while(!io)await tick()
 controller.abort();while(!scope.signal.aborted)await tick();resumeIO()
 expect((await response).text).not.toContain('SECRET-CONTEXT-REVIEW')
 expect(await api.readLinkedTranscript(linked,scope)).toBeNull();holdIO=false
})
it.each(['proof','proof-restored','edge','edge-recreated','caller','caller-saved','target','target-saved','account','endpoint','connection','project'])('probes %s revocation between last IO authorization and real HTTP response',async(change)=>{
 const observations:any[]=[]
 for(let hops=0;hops<24;hops++){
  const token=fresh();let beforeEnd=false
  afterRead=()=>{let left=hops;const next=()=>{if(left-->0){queueMicrotask(next);return}beforeEnd=!scope.signal.aborted; if(change==='proof')hookServer.setNodeAuthSecret(randomBytes(32)); if(change==='proof-restored'){hookServer.setNodeAuthSecret(randomBytes(32));hookServer.setNodeAuthSecret(secret)}; if(change==='edge')edge=false; if(change==='edge-recreated'){void setContextLinks({});void setContextLinks({caller:[linked]})}; if(change==='caller')callerRuntime='changed'; if(change==='caller-saved')caller.agentSessionId='changed'; if(change==='target')runtime='changed'; if(change==='target-saved')target.agentSessionId='changed'; if(change==='account')target.accountId='missing'; if(change==='endpoint')conn.host='changed'; if(change==='project')ids=['p','other']; if(change==='connection')gen='g2'};queueMicrotask(next)}
  const answer=await post(token)
  if(beforeEnd&&answer.text.includes('SECRET-CONTEXT-REVIEW'))observations.push(hops); callerRuntime='caller-session';runtime=sid;gen='g1';caller.agentSessionId='caller-session';target.agentSessionId=sid;delete target.accountId;conn.host='fixture';ids=['p']; await setContextLinks({caller:[linked]})
 }
 console.log(change, 'REVOKED BEFORE RESPONSE BUT CONTENT DELIVERED, MICROTASK OFFSETS:',observations)
 expect(observations).toEqual([])
})

it('HTTP deadline ends authorization before detached application work resumes',async()=>{
 const token=fresh();let release!:()=>void;let late!:Promise<string>;let requestScope:any
 const held=new Promise<void>(r=>{release=r})
 hookServer.setContextLinkHandler((req)=>{requestScope=req.scope;late=held.then(()=>handleContextLinkRequest(req));return late})
 try{
  const answer=await post(token)
  expect(answer.text).toContain('Could not read linked context.')
  expect(requestScope.signal.aborted).toBe(true);expect(requestScope.verified()).toBe(false)
  const before=calls;release();expect(await late).not.toContain('SECRET-CONTEXT-REVIEW');expect(calls).toBe(before)
 }finally{release();hookServer.setContextLinkHandler(handleContextLinkRequest)}
},35000)
