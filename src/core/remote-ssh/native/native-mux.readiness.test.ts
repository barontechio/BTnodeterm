import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Server, type Connection } from 'ssh2'
import { testTmpDir } from '../../test-tmp'
import { NativeMux } from './native-mux'
import { runSshArgv, startNativeMaster } from './native-invoke'
import { ed25519KeyPair } from './test-keys'
import type { ResolvedHost } from './ssh-config'
import { checkMasterArgs } from '../control-master'
import { SshProjectManager } from '../ssh-project'
import type { SshProjectStatusEvent } from '../../../shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return {promise, resolve, reject}
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function peer(failure?: 'host-key' | 'authentication') {
  const root = testTmpDir('native-readiness-')
  const host = ed25519KeyPair()
  const key = ed25519KeyPair({passphrase: 'fixture-passphrase', cipher: 'aes256-cbc', rounds: 1})
  const signed = deferred<() => void>()
  const clients = new Set<Connection>()
  const server = new Server({hostKeys: [host.private]}, client => {
    clients.add(client); client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      if (!ctx.signature) return ctx.accept()
      signed.resolve(() => failure === 'authentication' ? ctx.reject(['publickey']) : ctx.accept())
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const identityFile = path.join(root, 'identity'), known = path.join(root, 'known_hosts')
  await fs.writeFile(identityFile, key.private, {mode: 0o600})
  await fs.writeFile(known, `[127.0.0.1]:${port} ${(failure === 'host-key' ? ed25519KeyPair() : host).public}\n`)
  const resolved: ResolvedHost = {hostname: '127.0.0.1', port, user: 'fixture', identityFiles: [identityFile],
    identitiesOnly: true, userKnownHostsFiles: [known], globalKnownHostsFiles: [], strictHostKeyChecking: 'yes'}
  const target = {host: '127.0.0.1', user: 'fixture', port, identityFile}
  const mux = new NativeMux({resolveHost: async () => resolved, defaultAgent: () => undefined,
    askPassphrase: async () => 'fixture-passphrase'})
  cleanup.push(async () => {
    mux.exitAll()
    await Promise.all([...clients].map(client => new Promise<void>(resolve => {
      client.once('close', resolve); client.end()
    })))
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {root, mux, target, resolved, signed}
}

it('keeps pending configuration registered but never reports it usable', async () => {
  const configuration = deferred<ResolvedHost>()
  const mux = new NativeMux({resolveHost: () => configuration.promise, defaultAgent: () => undefined})
  const pending = mux.master('/fixture/readiness', {host: 'unused.invalid', user: 'fixture', port: 22}, {})
  const settled = pending.catch(() => undefined)
  try {
    expect(mux.hasMaster('/fixture/readiness')).toBe(true)
    expect(mux.check('/fixture/readiness')).toBe(false)
  } finally {
    configuration.reject(new Error('fixture stops before any socket'))
    await settled; mux.exitAll()
  }
})

describe('authenticated readiness over a real encrypted-key SSH peer', () => {
  it('answers check only after signed authentication succeeds', async () => {
    const f = await peer(), cp = path.join(f.root, 'master')
    const pending = f.mux.master(cp, f.target, {})
    const release = await f.signed.promise
    expect(f.mux.hasMaster(cp)).toBe(true)
    expect(f.mux.check(cp)).toBe(false)
    expect((await runSshArgv(f.mux, checkMasterArgs(f.target, cp))).code).toBe(255)
    release(); await pending
    expect(f.mux.check(cp)).toBe(true)
    expect((await runSshArgv(f.mux, checkMasterArgs(f.target, cp))).code).toBe(0)
    await f.mux.exit(cp)
    expect(f.mux.check(cp)).toBe(false)
  })

  it('a cancelled authenticating connection cannot become usable after its auth callback', async () => {
    const f = await peer(), cp = path.join(f.root, 'master')
    const pending = f.mux.master(cp, f.target, {}).catch(() => undefined)
    const release = await f.signed.promise
    const closed = f.mux.exit(cp)
    release(); await pending; await closed
    expect(f.mux.hasMaster(cp)).toBe(false)
    expect(f.mux.check(cp)).toBe(false)
  })

  it('a retired configuration callback cannot mark or remove its pending replacement', async () => {
    const oldConfig = deferred<ResolvedHost>(), newConfig = deferred<ResolvedHost>()
    let calls = 0
    const mux = new NativeMux({resolveHost: () => ++calls === 1 ? oldConfig.promise : newConfig.promise})
    const cp = '/fixture/replaced', target = {host: 'unused.invalid', user: 'fixture', port: 22}
    const old = mux.master(cp, target, {}).catch(() => undefined)
    mux.exitAll()
    const replacement = mux.master(cp, target, {}).catch(() => undefined)
    try {
      oldConfig.reject(new Error('late original configuration failure')); await old
      expect(mux.hasMaster(cp)).toBe(true)
      expect(mux.check(cp)).toBe(false)
    } finally {
      newConfig.reject(new Error('replacement fixture ends without network')); await replacement; mux.exitAll()
    }
  })

  it.each(['host-key', 'authentication'] as const)('project connect never publishes usable/connected after real %s failure', async failure => {
    const f = await peer(failure)
    const statuses: SshProjectStatusEvent[] = []
    const manager = new SshProjectManager({userDataDir: f.root,
      spawnMaster: args => startNativeMaster(f.mux, args),
      run: async (args, stdin, timeoutMs) => {
        const result = await runSshArgv(f.mux, args, {stdin, timeoutMs})
        return {code: result.code ?? 255, stdout: result.stdout.toString()}
      },
      runScp: async () => ({code: 255}), getHook: () => ({port: 0, token: 'fixture', version: 'fixture'}),
      onStatus: event => statuses.push(event), masterAbsent: async cp => !f.mux.hasMaster(cp)})
    cleanup.push(async () => { manager.disconnectAll() })
    const connecting = manager.connect('readiness-fixture', f.target, '/fixture')
    const rejected = expect(connecting).rejects.toThrow()
    if (failure === 'authentication') (await f.signed.promise)()
    await rejected
    expect(statuses.some(event => event.status === 'connected' || !!event.masterControlPath)).toBe(false)
  })
})
