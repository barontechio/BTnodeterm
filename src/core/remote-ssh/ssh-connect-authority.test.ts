import { describe, it, expect, vi } from 'vitest'
import { SshProjectManager, type SshProjectRunners } from './ssh-project'
import { testTmpDir } from '../test-tmp'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const endpoint = { host: 'fixture.invalid', user: 'fixture' }
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
function make(overrides: Partial<SshProjectRunners> = {}) {
 const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), exited: () => true, stderr: () => 'Permission denied (publickey).' }))
 const onStatus = vi.fn()
 const manager = new SshProjectManager({ userDataDir: '/fixture', spawnMaster, onStatus,
 run: async () => ({ code: 0, stdout: '' }), runScp: async () => ({code: 0}), getHook: () => ({ port: 0, token: '', version: '1' }), ...overrides })
 return { manager, spawnMaster, onStatus }
}
describe('connect authority through setup and publication', () => {
 it('allows recovery after failed authentication left no OpenSSH socket', async () => {
   const dir = testTmpDir('ssh-absent-auth-')
   const config = path.join(dir, 'config'); fs.writeFileSync(config, 'Host *\n  UserKnownHostsFile '+dir+'/known\n  GlobalKnownHostsFile '+dir+'/known\n')
   let absentCode = 0
   try { execFileSync('ssh', ['-F', config, '-o', 'BatchMode=yes', '-S', path.join(dir, 'absent.sock'), '-O', 'exit', 'fixture.invalid'], {stdio:'pipe',timeout:2000}) } catch(e) { absentCode = (e as {status:number}).status }
   expect(absentCode).toBe(255)
   let failing = true
   const f = make({masterAbsent: async (cp: string) => {try {await fs.promises.lstat(cp);return false} catch(e) {return (e as NodeJS.ErrnoException).code==='ENOENT'}}, run: async () => ({code: failing ? absentCode : 0, stdout:''})})
   try {
    await expect(f.manager.connect('p', endpoint)).rejects.toThrow('Permission denied')
    await f.manager.disconnect('p', {final:true}) // explicit retry while socket remains absent
    failing = false // corrected credential / recovered host
    await f.manager.connect('p', endpoint)
    expect(f.spawnMaster).toHaveBeenCalledTimes(2)
   } finally { f.manager.disconnectAll(); fs.rmSync(dir,{recursive:true,force:true}) }
 })
 it('does not dispatch or publish connected after scope expires during setup IO', async () => {
   const gate = deferred(); let entered = false; let active = true; const commands: string[][] = []
   const f = make({run: async (args: string[]) => {
     commands.push(args)
     if (args.some(a => a.includes('printf %s "$HOME"'))) { entered = true; await gate.promise }
     return {code:0,stdout:''}
   }})
   const connecting = f.manager.connect('p', endpoint, undefined, {current: () => active})
   try {
    await vi.waitFor(() => expect(entered).toBe(true)); active = false; const before = commands.length; gate.release()
    const result = await connecting.then(() => 'resolved', () => 'rejected')
    expect(f.manager.refForProject('p')).toBeUndefined()
    expect(commands.slice(before).filter(a=>a.includes('-O')).every(a=>a[1]==='exit')).toBe(true)
    expect({result, connected: f.onStatus.mock.calls.some(([e]) => e.status === 'connected'), laterCommands:commands.slice(before).filter(a=>!a.includes('-O')).length}).toEqual({result:'rejected', connected:false,laterCommands:0})
   } finally { gate.release(); f.manager.disconnectAll() }
 })
 it('cancels before spawn when authority expires during ensureAgent', async () => {
   const gate = deferred(); let entered = false; let active = true
   const f = make({ensureAgent: async () => { entered=true; await gate.promise }})
   const pending = f.manager.connect('p',endpoint,undefined,{current:()=>active})
   const rejected = expect(pending).rejects.toThrow('cancelled')
   await vi.waitFor(()=>expect(entered).toBe(true)); active=false; gate.release(); await rejected
   expect(f.spawnMaster).not.toHaveBeenCalled(); f.manager.disconnectAll()
 })
 it('does not close a shared connection when a reuse requester expires', async () => {
   const gate = deferred()
   let holdCheck = false
   let entered = false
   let active = true
   const commands: string[][] = []
   const f = make({run: async (args) => {
     commands.push(args)
     if (holdCheck && args.includes('-O') && args.includes('check')) {
       entered = true
       await gate.promise
     }
     return {code: 0, stdout: ''}
   }})
   try {
     await f.manager.connect('p', endpoint)
     const original = f.manager.refForProject('p')
     holdCheck = true
     const before = commands.length
     const pending = f.manager.connect('p', endpoint, undefined, {current: () => active})
     const rejected = expect(pending).rejects.toThrow('cancelled')
     await vi.waitFor(() => expect(entered).toBe(true))
     active = false
     gate.release()
     await rejected
     expect(f.manager.refForProject('p')).toEqual(original)
     expect(commands.slice(before).some(args => args.includes('-O') && args.includes('exit'))).toBe(false)
   } finally { gate.release(); f.manager.disconnectAll() }
 })
 it('does not publish tunnel repair after a reuse requester expires', async () => {
   const gate = deferred()
   let active = true
   let hookEnabled = false
   let entered = false
   const f = make({getHook: () => ({port: hookEnabled ? 1234 : 0, token: 'fixture', version: '1'})})
   try {
     await f.manager.connect('p', endpoint)
     const original = f.manager.refForProject('p')
     const hooks = (f.manager as unknown as {remoteHooks: {tunnelAlive: (...args: unknown[]) => Promise<{alive: boolean}>}}).remoteHooks
     vi.spyOn(hooks, 'tunnelAlive').mockImplementation(async () => {
       entered = true
       await gate.promise
       return {alive: true}
     })
     hookEnabled = true
     const before = f.onStatus.mock.calls.length
     const pending = f.manager.connect('p', endpoint, undefined, {current: () => active})
     const rejected = expect(pending).rejects.toThrow('cancelled')
     await vi.waitFor(() => expect(entered).toBe(true))
     active = false
     gate.release()
     await rejected
     expect(f.onStatus.mock.calls.slice(before).filter(([event]) => event.status === 'connected')).toHaveLength(0)
     expect(f.manager.refForProject('p')).toEqual(original)
   } finally { gate.release(); f.manager.disconnectAll() }
 })
 it('does not publish connected from a cancelled attempt while its exit is held', async () => {
   const checkGate=deferred(), exitGate=deferred(); let checking=false, exiting=false
   const f=make({run:async(args:string[])=>{
     if(args.includes('-O') && args.includes('check') && !checking) {checking=true; await checkGate.promise}
     if(args.includes('-O') && args.includes('exit')) {exiting=true; await exitGate.promise}
     return {code:0,stdout:''}
   }})
   const initial=f.manager.connect('p',endpoint).catch(()=>undefined)
   await vi.waitFor(()=>expect(checking).toBe(true))
   const closing=f.manager.disconnect('p',{final:true})
   try {
     await vi.waitFor(()=>expect(exiting).toBe(true)); checkGate.release(); await initial
     expect(f.onStatus.mock.calls.filter(([e])=>e.status==='connected')).toHaveLength(0)
   } finally {checkGate.release();exitGate.release();await closing;f.manager.disconnectAll()}
 })

})
