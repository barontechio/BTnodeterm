import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SshFs, sshReadCheckedArgs } from './ssh-fs'
import { testTmpDir } from './test-tmp'

const run = promisify(execFile)
describe.skipIf(process.platform === 'win32')('checked SSH reads under a real POSIX shell', () => {
  const ref = { conn: { host: 'fixture', user: 'fixture' }, controlPath: '/unused' }
  const reader = () => new SshFs(async (args) => {
    try { return { code: 0, stdout: (await run('/bin/sh', ['-c', args.at(-1)!])).stdout } }
    catch (error) { const failed = error as { code: number; stdout?: string }; return { code: failed.code, stdout: failed.stdout ?? '' } }
  })
  it('reads content and proves missing files even when intermediate directories are absent', async () => {
    const directory = testTmpDir('checked-ssh-read-'); const file = path.join(directory, 'spaces and $literal')
    fs.writeFileSync(file, 'kept content')
    expect(await reader().readTextChecked(ref, file)).toEqual({ status: 'ok', content: 'kept content' })
    expect(await reader().readTextChecked(ref, path.join(directory, 'missing/.nodeterm/project.json'))).toEqual({ status: 'absent' })
    expect(await reader().readTextChecked(ref, directory)).toEqual({ status: 'error' })
    fs.symlinkSync(path.join(directory, 'missing'), path.join(directory, 'broken'))
    expect(await reader().readTextChecked(ref, path.join(directory, 'broken'))).toEqual({ status: 'error' })
    expect(sshReadCheckedArgs(ref.conn, ref.controlPath, file).at(-1)).toContain('exit 66')
  })
  it.skipIf(process.platform !== 'linux')('keeps a real read failure distinct from absence', async () => {
    // Linux exposes a regular proc entry whose read at offset zero fails; root is not exempt.
    expect(await reader().readTextChecked(ref, '/proc/self/mem')).toEqual({ status: 'error' })
  })
})
