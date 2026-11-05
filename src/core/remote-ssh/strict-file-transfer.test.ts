import { describe, it, expect, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { testTmpDir } from '../test-tmp'
import { transferFileCommand, transferCommitMarker, parseTransferStat, STRICT_FILE_TRANSFER_PYTHON, type TransferFileQuery } from './strict-file-transfer'

function run(query: TransferFileQuery, body?: Buffer): Promise<{code: number; output: Buffer}> {
  return new Promise(resolve => {
    const child = execFile('sh', ['-c', transferFileCommand(query)], {encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 5000}, (error, stdout) => {
      resolve({code: typeof error?.code === 'number' ? error.code : error ? 255 : 0, output: stdout})
    })
    child.stdin!.on('error', () => {})
    child.stdin!.end(query.operation === 'create' && body ? Buffer.concat([body, transferCommitMarker(query.nonce!)]) : body)
  })
}
const stat = async (root: string, relativePath: string) => {
  const result = await run({root, relativePath, operation: 'stat'})
  expect(result.code).toBe(0)
  return parseTransferStat(result.output.toString())
}

describe.skipIf(process.platform !== 'linux')('descriptor-scoped remote file transfer helper', () => {
  it('creates exact quoted-path bytes and recovers a durable receipt without a sidecar', async () => {
    const root = testTmpDir('remote-transfer-'), relativePath = "quote ' and \\ bytes.bin"
    const before = await stat(root, relativePath), body = randomBytes(65537), nonce = randomBytes(16).toString('hex')
    const created = await run({root, relativePath, operation: 'create', identity: before.identity, bytes: body.length, nonce}, body)
    expect(JSON.parse(created.output.toString())).toEqual({outcome: 'committed', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex')})
    expect(await fs.readFile(path.join(root, relativePath))).toEqual(body)
    expect(await fs.readdir(root)).toEqual([relativePath])
    const recovered = await run({root, relativePath, operation: 'receipt', identity: before.identity, nonce})
    expect(JSON.parse(recovered.output.toString()).outcome).toBe('committed')
    const wrong = await run({root, relativePath, operation: 'receipt', identity: before.identity, nonce: randomBytes(16).toString('hex')})
    expect(JSON.parse(wrong.output.toString()).outcome).toBe('unknown')
  })

  it.each([3, 5])('refuses input of %s bytes for an exact four-byte upload and cleans temporary content', async length => {
    const root = testTmpDir('remote-transfer-short-'), relativePath = 'new.bin'
    const before = await stat(root, relativePath)
    const result = await run({root, relativePath, operation: 'create', identity: before.identity, bytes: 4, nonce: randomBytes(16).toString('hex')}, Buffer.alloc(length))
    expect(JSON.parse(result.output.toString()).outcome).toBe('not-written')
    expect(await fs.readdir(root)).toEqual([])
  })

  it.each(['kill', 'rename'])('keeps unpublished bytes anonymous across %s', async action => {
    const root = testTmpDir('remote-transfer-anonymous-'), relativePath = 'new.bin'
    const before = await stat(root, relativePath), nonce = randomBytes(16).toString('hex')
    const moved = path.join(testTmpDir('remote-transfer-moved-'), 'root')
    const child = spawn('sh', ['-c', transferFileCommand({root, relativePath, operation: 'create',
      identity: before.identity, bytes: 131072, nonce})], {stdio: ['pipe', 'pipe', 'pipe']})
    const closed = new Promise(resolve => child.once('close', resolve))
    child.stdin.on('error', () => {}); child.stdout.resume(); child.stderr.resume()
    try {
      child.stdin.write(Buffer.alloc(65536))
      await vi.waitFor(async () => {
        const links = await Promise.all((await fs.readdir(`/proc/${child.pid}/fd`)).map(async fd => {
          try { return await fs.readlink(`/proc/${child.pid}/fd/${fd}`) } catch { return '' }
        }))
        expect(links.some(link => link.startsWith(root + '/') && link.endsWith(' (deleted)'))).toBe(true)
      })
      expect(await fs.readdir(root)).toEqual([])
      if (action === 'kill') child.kill('SIGKILL')
      else {
        await fs.rename(root, moved); await fs.mkdir(root)
        child.stdin.end(Buffer.concat([Buffer.alloc(65536), transferCommitMarker(nonce)]))
      }
      await closed
      expect(await fs.readdir(root)).toEqual([])
      if (action === 'rename') expect(await fs.readdir(moved)).toEqual([])
    } finally { child.kill('SIGKILL'); await closed }
  })

  // This is the explicitly approved descriptor-authority contract, NOT a claim that pathname
  // validation and linkat are atomic. Keep the reviewer's original external repro unchanged.
  it.each([['before-check', 'root'], ['after-check', 'root'], ['before-check', 'parent'], ['after-check', 'parent']] as const)('handles a directory move %s/%s under descriptor authority', async (timing, target) => {
    const root = testTmpDir('remote-transfer-namespace-')
    const moved = path.join(testTmpDir('remote-transfer-retired-'), 'original')
    const directory = target === 'root' ? root : path.join(root, 'parent')
    if (target === 'parent') await fs.mkdir(directory)
    const relativePath = target === 'root' ? 'new.bin' : 'parent/new.bin'
    const body = Buffer.from('exact body'), nonce = randomBytes(16).toString('hex')
    const before = await stat(root, relativePath)
    const query: TransferFileQuery = {root, relativePath, operation: 'create', identity: before.identity, bytes: body.length, nonce}
    const marker = timing === 'before-check' ? 'os.fsync(content); os.fsync(parent); directories_current()' : "try: os.link('/proc/self/fd/'"
    const at = STRICT_FILE_TRANSFER_PYTHON.split('\n').findIndex(line => line.includes(marker)) + 1
    expect(at).toBeGreaterThan(0)
    // sys.settrace schedules the external actor at the syscall boundary while executing the
    // original production helper body. No product branch/hook or altered link implementation.
    const wrapper = `import sys, os, json
source = json.loads(sys.argv[2])
root, moved = sys.argv[3], sys.argv[4]
def trace(frame, event, arg):
    if event == 'line' and frame.f_code.co_filename == '<original-helper>' and frame.f_lineno == ${at}:
        os.rename(root, moved)
        os.mkdir(root)
    return trace
sys.settrace(trace)
exec(compile(source, '<original-helper>', 'exec'))
`
    const result = await new Promise<{code: number; output: Buffer}>(resolve => {
      const child = execFile('python3', ['-c', wrapper, JSON.stringify(query), JSON.stringify(STRICT_FILE_TRANSFER_PYTHON), directory, moved],
        {encoding: 'buffer', timeout: 5000, maxBuffer: 32768}, (error, output) => resolve({code: error ? 255 : 0, output}))
      child.stdin!.on('error', () => {})
      child.stdin!.end(Buffer.concat([body, transferCommitMarker(nonce)]))
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output.toString()).outcome).toBe(timing === 'before-check' ? 'not-written' : 'unknown')
    expect(await fs.readdir(directory)).toEqual([]) // never publishes into the replacement namespace
    expect(String((await fs.stat(moved)).ino)).toBe(before.identity.parents.at(-1)![1])
    if (timing === 'before-check') expect(await fs.readdir(moved)).toEqual([])
    else {
      expect(await fs.readdir(moved)).toEqual(['new.bin'])
      expect(await fs.readFile(path.join(moved, 'new.bin'))).toEqual(body)
    }
  })

  it('cannot overwrite a file created after preparation', async () => {
    const root = testTmpDir('remote-transfer-conflict-'), relativePath = 'existing'
    const before = await stat(root, relativePath)
    await fs.writeFile(path.join(root, relativePath), 'keep')
    const result = await run({root, relativePath, operation: 'create', identity: before.identity, bytes: 4, nonce: randomBytes(16).toString('hex')}, Buffer.from('lose'))
    expect(JSON.parse(result.output.toString()).outcome).toBe('conflict')
    expect(await fs.readFile(path.join(root, relativePath), 'utf8')).toBe('keep')
  })

  it('streams only a selected range after an identity-matching header', async () => {
    const root = testTmpDir('remote-transfer-range-'), relativePath = 'range.bin'
    const body = randomBytes(65537)
    await fs.writeFile(path.join(root, relativePath), body)
    const before = await stat(root, relativePath)
    const read = await run({root, relativePath, operation: 'read', identity: before.identity, offset: 17, length: 65520})
    expect(read.code).toBe(0)
    const newline = read.output.indexOf(10)
    expect(JSON.parse(read.output.subarray(0, newline).toString())).toEqual({ok: true, bytes: 65520, identity: before.identity})
    expect(read.output.subarray(newline + 1)).toEqual(body.subarray(17))
    await fs.rename(path.join(root, relativePath), path.join(root, 'old'))
    await fs.writeFile(path.join(root, relativePath), body)
    const replaced = await run({root, relativePath, operation: 'read', identity: before.identity, offset: 0, length: 1})
    expect(replaced.code).not.toBe(0)
    expect(replaced.output.length).toBe(0)
  })

  it('rejects symlink ancestors and leaves their targets untouched', async () => {
    const root = testTmpDir('remote-transfer-links-'), outside = testTmpDir('remote-transfer-outside-')
    await fs.writeFile(path.join(outside, 'secret'), 'private')
    await fs.symlink(outside, path.join(root, 'escape'))
    const result = await run({root, relativePath: 'escape/secret', operation: 'stat'})
    expect(result.code).not.toBe(0)
    expect(result.output.length).toBe(0)
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('private')
  })
})
