import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import { RemoteTransfers, type TransferCaller } from './remote-transfers'
import { OwnerLifetimes } from './owner-lifetimes'
import { testTmpDir } from './test-tmp'
import { streamSshCommand } from './remote-ssh/ssh-bulk-stream'
import { SshChildGate } from './remote-ssh/ssh-child-gate'
import { childArgs } from './remote-ssh/control-master'
import { parseSshArgv } from './remote-ssh/native/ssh-argv'

const cleanup: Array<() => void> = []
afterEach(() => { for (const run of cleanup.splice(0)) run() })
function fixture(afterResult?: (result: {code: number; interrupted: boolean}) => void) {
  const root = testTmpDir('remote-transfer-core-')
  const owners = new OwnerLifetimes()
  const caller: TransferCaller = {owner: owners.get(1, () => true), principal: {current: () => true}}
  let generation = 1, lostReceipt = false, dispatched = 0
  const gate = new SshChildGate(2)
  const service = new RemoteTransfers(request => {
    const captured = generation
    return {root, relativePath: request.relativePath, path: path.join(root, request.relativePath), current: () => generation === captured,
      stream: (command, options) => streamSshCommand(gate, childArgs({host: 'fixture.invalid', user: 'fixture'}, '/fixture/core', command),
        lostReceipt && command.includes('"operation":"create"') ? {...options, consume: async output => { for await (const _ of output) { /* simulate lost receipt */ } }} : options,
        args => {
          dispatched++
          const parsed = parseSshArgv(args)
          if (parsed.kind !== 'exec') throw new Error('invalid fixture')
          const child = spawn('sh', ['-c', parsed.command!], {stdio: ['pipe', 'pipe', 'pipe']})
          return {stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
            closed: new Promise<number>(resolve => child.once('close', code => resolve(code ?? 255))), cancel: () => { child.kill('SIGKILL') }}
        }).then(result => { afterResult?.(result); return result })}
  })
  cleanup.push(() => { service.dispose(); owners.dispose() })
  return {root, caller, owners, service, change: () => generation++, restore: () => { generation = 1 }, loseReceipt: () => { lostReceipt = true }, dispatched: () => dispatched}
}

describe.skipIf(process.platform !== 'linux')('remote transfer reference authority with actual descriptor helper', () => {
  it('uploads once and resolves a lost response from the inode receipt without replaying the body', async () => {
    const f = fixture()
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'upload', relativePath: 'new.bin', bytes: 5})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    f.loseReceipt()
    const result = await f.service.upload(ready.reference, f.caller.principal, Readable.from([Buffer.from('hello')]), new AbortController().signal)
    expect(result.outcome).toBe('unknown')
    expect(await fs.readFile(path.join(f.root, 'new.bin'), 'utf8')).toBe('hello')
    expect((await f.service.status(f.caller, ready.reference)).outcome).toBe('committed')
    expect((await f.service.upload(ready.reference, f.caller.principal, Readable.from(['other']), new AbortController().signal)).outcome).toBe('unavailable')
    expect(await fs.readFile(path.join(f.root, 'new.bin'), 'utf8')).toBe('hello')
  })

  it.each(['source', 'owner'])('does not publish when %s expires before the commit marker', async reason => {
    const f = fixture()
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'upload', relativePath: 'new.bin', bytes: 5})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    const body = Readable.from((async function* () {
      yield Buffer.from('hello')
      if (reason === 'owner') f.owners.forget(1)
      else f.change()
    })())
    expect((await f.service.upload(ready.reference, f.caller.principal, body, new AbortController().signal)).outcome).not.toBe('committed')
    expect(await fs.readdir(f.root)).toEqual([])
  })

  it('refuses another cookie principal, owner departure and a changed generation before dispatch', async () => {
    const f = fixture()
    await fs.writeFile(path.join(f.root, 'data'), 'private')
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'download', relativePath: 'data'})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    const before = f.dispatched()
    const consume = async () => { throw new Error('must not publish') }
    expect(await f.service.download(ready.reference, {current: () => true}, 0, 7, consume, new AbortController().signal)).toBe(false)
    f.change()
    expect(await f.service.download(ready.reference, f.caller.principal, 0, 7, consume, new AbortController().signal)).toBe(false)
    expect(f.dispatched()).toBe(before)
    const next = await f.service.prepare(f.caller, {projectId: 'p', kind: 'download', relativePath: 'data'})
    expect(next.status).toBe('ready'); if (next.status !== 'ready') return
    f.owners.forget(1)
    expect(f.service.info(next.reference, f.caller.principal)).toBeNull()
  })

  it('checks media signature and serves immutable repeatable ranges', async () => {
    const f = fixture()
    await fs.writeFile(path.join(f.root, 'bad.mp4'), '<html>not media</html>')
    expect((await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'bad.mp4', nodeId: 'video'})).status).toBe('unavailable')
    const body = Buffer.from('0000ftyp1234567890abcdef')
    await fs.writeFile(path.join(f.root, 'good.mp4'), body)
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'good.mp4', nodeId: 'video'})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    for (const offset of [4, 9]) {
      const chunks: Buffer[] = []
      const ok = await f.service.download(ready.reference, f.caller.principal, offset, 4, async stream => {
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      }, new AbortController().signal)
      expect(ok).toBe(true); expect(Buffer.concat(chunks)).toEqual(body.subarray(offset, offset + 4))
    }
    await fs.rename(path.join(f.root, 'good.mp4'), path.join(f.root, 'original'))
    await fs.writeFile(path.join(f.root, 'good.mp4'), body)
    let published = false
    expect(await f.service.download(ready.reference, f.caller.principal, 0, 4, async () => { published = true }, new AbortController().signal)).toBe(false)
    expect(published).toBe(false)
  })
})

// Independent review schedules. Expectations state the required safe behavior.
describe.skipIf(process.platform !== 'linux')('reference invalidation schedules', () => {
  it('permanently revokes media after the publication guard observes a stale source', async () => {
    const f = fixture()
    await fs.writeFile(path.join(f.root, 'movie.mp4'), '0000ftyp1234567890abcdef')
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'movie.mp4', nodeId: 'v'})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    const ok = await f.service.download(ready.reference, f.caller.principal, 0, 4, async (body, current) => {
      f.change()
      expect(current()).toBe(false) // actually observed invalidation, not an unseen ABA
      f.restore()
      body.destroy()
      throw new Error('publication refused')
    }, new AbortController().signal)
    expect(ok).toBe(false)
    const renewed = f.service.renew(f.caller, ready.reference)
    const republished = await f.service.download(ready.reference, f.caller.principal, 0, 4, async body => {for await (const _ of body) {}}, new AbortController().signal)
    expect(renewed).toBe(false)
    expect(republished).toBe(false)
    expect(f.service.info(ready.reference, f.caller.principal)).toBeNull()
  })
  it('permanently revokes media after an immutable file replacement is detected', async () => {
    const f = fixture()
    const p = path.join(f.root, 'movie.mp4')
    await fs.writeFile(p, '0000ftyp1234567890abcdef')
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'movie.mp4', nodeId: 'v'})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    await fs.rename(p, p + '.old'); await fs.writeFile(p, '0000ftyp1234567890abcdef')
    expect(await f.service.download(ready.reference, f.caller.principal, 0, 4, async () => {throw new Error('must not publish')}, new AbortController().signal)).toBe(false)
    expect(f.service.renew(f.caller, ready.reference)).toBe(false)
  })
  it('preserves valid media after ordinary caller cancellation', async () => {
    const f = fixture()
    await fs.writeFile(path.join(f.root, 'movie.mp4'), '0000ftyp1234567890abcdef')
    const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'movie.mp4', nodeId: 'v'})
    expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
    const cancelled = new AbortController(); cancelled.abort()
    const consume = async (body: Readable) => { for await (const _ of body) {} }
    expect(await f.service.download(ready.reference, f.caller.principal, 0, 4, consume, cancelled.signal)).toBe(false)
    expect(f.service.renew(f.caller, ready.reference)).toBe(true)
    expect(await f.service.download(ready.reference, f.caller.principal, 0, 4, consume, new AbortController().signal)).toBe(true)
  })

})

it.skipIf(process.platform !== 'linux')('does not revive an observed immutable-read failure when cancellation arrives before Core handles its result', async () => {
  const cancelled = new AbortController()
  let arm = false
  const f = fixture(result => {
    if (arm && result.code === 68) {
      cancelled.abort()
    }
  })
  const p = path.join(f.root, 'movie.mp4')
  await fs.writeFile(p, '0000ftyp1234567890abcdef')
  const ready = await f.service.prepare(f.caller, {projectId: 'p', kind: 'media', relativePath: 'movie.mp4', nodeId: 'v'})
  expect(ready.status).toBe('ready'); if (ready.status !== 'ready') return
  await fs.rename(p, p + '.old'); await fs.writeFile(p, '0000ftyp1234567890abcdef')
  arm = true
  const consume = async (body: Readable) => { for await (const _ of body) {} }
  expect(await f.service.download(ready.reference, f.caller.principal, 0, 4, consume, cancelled.signal)).toBe(false)
  expect(cancelled.signal.aborted).toBe(true)
  arm = false
  const renewed = f.service.renew(f.caller, ready.reference)
  expect(renewed).toBe(false)
})
