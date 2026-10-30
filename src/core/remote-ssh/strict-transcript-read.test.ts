import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import { remoteAccountConfigDirAbs } from '../claude-accounts-core'
import { posixQuote } from '../../shared/ssh'
import { parseStrictTranscriptPage, STRICT_TRANSCRIPT_PYTHON, strictTranscriptReadCommand, type StrictTranscriptRead } from './strict-transcript-read'

const run = promisify(execFile)
const sessionId = '7e2f39a0-0be6-4f64-8657-6905c1508571'
const query = (home: string, accountId?: string): StrictTranscriptRead => ({ home, accountId, sessionId, before: null, maxBytes: 64 })
async function execute(command: string): Promise<{ code: number; stdout: string }> {
  try { return { code: 0, stdout: (await run('/bin/sh', ['-c', command], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })).stdout } }
  catch (error) { const result = error as { code?: number; stdout?: string }; return { code: result.code ?? 1, stdout: result.stdout ?? '' } }
}
function fixture(accountId?: string) {
  const home = path.join(testTmpDir('strict-ssh-transcript-'), "owner's home")
  const root = accountId ? path.join(remoteAccountConfigDirAbs(home, accountId), 'projects') : path.join(home, '.claude', 'projects')
  const directory = path.join(root, 'project'); fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${sessionId}.jsonl`)
  return { home, root, directory, file, q: query(home, accountId) }
}
function instrument(q: StrictTranscriptRead, before: string): string {
  return ['python3', '-c', before + '\n' + STRICT_TRANSCRIPT_PYTHON, q.home, q.accountId ?? '', q.sessionId,
    String(q.maxBytes), String(q.before ?? -1)].map(posixQuote).join(' ')
}

describe('strict transcript request and reply bounds', () => {
  it('rejects traversal, shell-injected identifiers and unbounded byte ranges', () => {
    const base = query('/home/fixture')
    for (const patch of [{ home: '../other' }, { home: '/home/line\nbreak' }, { sessionId: '../secret' },
      { accountId: '../other' }, { accountId: 'account;exit' }, { before: -1 }, { maxBytes: 0 }, { maxBytes: 6 * 1024 * 1024 }]) {
      expect(() => strictTranscriptReadCommand({ ...base, ...patch })).toThrow('invalid-query')
    }
  })
  it('accepts only canonical base64 and the exact requested byte window', () => {
    expect(parseStrictTranscriptPage(JSON.stringify({ size: 6, start: 2, data: Buffer.from('cdef').toString('base64') }),
      { before: null, maxBytes: 3 })).toEqual({ size: 6, start: 2, data: Buffer.from('cdef') })
    for (const reply of [{ size: 6, start: 3, data: 'ZGVm' }, { size: 6, start: 2, data: 'ZGVm' },
      { size: 6, start: 2, data: 'Y2RlZg==garbage' }, { size: -1, start: 0, data: '' }]) {
      expect(() => parseStrictTranscriptPage(JSON.stringify(reply), { before: null, maxBytes: 3 })).toThrow()
    }
    expect(() => parseStrictTranscriptPage('x'.repeat(1024), { before: null, maxBytes: 3 })).toThrow('oversized-reply')
  })
})

describe.skipIf(process.platform === 'win32')('real Python descriptor-based remote transcript reader', () => {
  it('reads byte-exact bounded windows, keeping managed accounts separate from the system root', async () => {
    const f = fixture('_managed-account'); const bytes = Buffer.from('one\nαβγ\n' + '0123456789'.repeat(20) + '\n')
    fs.writeFileSync(f.file, bytes)
    const system = path.join(f.home, '.claude', 'projects', 'project'); fs.mkdirSync(system, { recursive: true })
    fs.writeFileSync(path.join(system, `${sessionId}.jsonl`), 'system account content')
    for (const before of [null, 45, 8, 0]) {
      const q = { ...f.q, before }; const result = await execute(strictTranscriptReadCommand(q))
      expect(result.code).toBe(0)
      const parsed = parseStrictTranscriptPage(result.stdout, q)
      const end = before === null ? bytes.length : Math.min(before, bytes.length)
      const base = Math.max(0, end - q.maxBytes); const start = base > 0 ? base - 1 : 0
      expect(parsed).toEqual({ size: bytes.length, start, data: bytes.subarray(start, end) })
    }
  })

  it('reports only a clean miss as absent, and rejects linked, special and ambiguous files', async () => {
    const f = fixture()
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 66, stdout: '' })
    fs.symlinkSync(path.join(f.home, 'missing-private-file'), f.file)
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 67, stdout: '' })
    fs.unlinkSync(f.file); fs.mkdirSync(f.file)
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 67, stdout: '' })
    fs.rmdirSync(f.file); fs.writeFileSync(f.file, 'first')
    const other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, `${sessionId}.jsonl`), 'second')
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 67, stdout: '' })
    const noRoot = query(testTmpDir('strict-ssh-no-account-'))
    expect(await execute(strictTranscriptReadCommand(noRoot))).toEqual({ code: 68, stdout: '' })
  })

  it('never follows a selected account or project directory symlink', async () => {
    const f = fixture('managed'); const outside = testTmpDir('strict-ssh-private-')
    fs.writeFileSync(path.join(outside, `${sessionId}.jsonl`), 'private data')
    fs.rmdirSync(f.directory); fs.symlinkSync(outside, f.directory)
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 67, stdout: '' })
    fs.unlinkSync(f.directory); fs.rmdirSync(f.root)
    fs.symlinkSync(outside, f.root)
    expect(await execute(strictTranscriptReadCommand(f.q))).toEqual({ code: 67, stdout: '' })
  })

  it('refuses a named-file replacement after open, and does not block if it becomes a FIFO before open', async () => {
    for (const mode of ['after', 'fifo', 'symlink', 'missing', 'permission'] as const) {
      const f = fixture(); fs.writeFileSync(f.file, 'original transcript')
      const secret = path.join(f.home, 'secret'); fs.writeFileSync(secret, 'private data')
      const before = `import os, errno
original_open = os.open
def replaced(name, flags, **kw):
    if name == ${JSON.stringify(sessionId + '.jsonl')}:
        file = ${JSON.stringify(f.file)}
        mode = ${JSON.stringify(mode)}
        if mode == 'permission': raise PermissionError(errno.EACCES, 'denied')
        if mode == 'after':
            fd = original_open(name, flags, **kw)
            os.rename(file, file + '.opened')
            with open(file, 'w') as out: out.write('replacement')
            return fd
        os.unlink(file)
        if mode == 'missing': return original_open(name, flags, **kw)
        if mode == 'fifo': os.mkfifo(file)
        else: os.symlink(${JSON.stringify(secret)}, file)
    return original_open(name, flags, **kw)
os.open = replaced
os.supports_dir_fd.add(replaced)`
      expect(await execute(instrument(f.q, before))).toEqual({ code: mode === 'missing' || mode === 'permission' ? 68 : 67, stdout: '' })
    }
  })

  it('does not call a replaced account tree a clean miss', async () => {
    const f = fixture()
    const before = `import os
original_list = os.listdir
def replaced(fd):
    names = original_list(fd)
    os.rename(${JSON.stringify(f.root)}, ${JSON.stringify(f.root + '.old')})
    os.mkdir(${JSON.stringify(f.root)})
    return names
os.listdir = replaced`
    expect(await execute(instrument(f.q, before))).toEqual({ code: 67, stdout: '' })
  })
})
