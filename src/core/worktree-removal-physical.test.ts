import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { DEFAULT_SETTINGS } from '../shared/types'
import { codexHomeForAccount } from './codex-accounts-core'
import { assertRemovalProtectedPaths, captureRemovalAccountPaths, captureManagedReferences } from './worktree-removal-physical'

const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) { child.kill(); await once(child, 'exit') } }
  vi.restoreAllMocks()
})
async function processAt(cwd: string) {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.on('data', chunk => { process.chdir(chunk.toString().trim()); process.stdout.write('changed') })"], { cwd, stdio: 'pipe' })
  children.push(child); await once(child.stdout, 'data'); return child
}
describe.skipIf(process.platform !== 'linux')('actual managed process references', () => {
  it('refuses a real nonmember cwd inside the checkout and pins member cwd changes', async () => {
    const root = testTmpDir('removal-proc-'); const checkout = path.join(root, 'checkout'); fs.mkdirSync(checkout)
    const child = await processAt(checkout)
    expect(() => captureManagedReferences([{ pid: child.pid!, member: false }], checkout)).toThrow('nonmember-reference')
    const current = captureManagedReferences([{ pid: child.pid!, member: true }], checkout)
    current()
    child.stdin.write(root + '\n'); await once(child.stdout, 'data')
    expect(current).toThrow('runtime-changed')
  })
  it('does not turn an inaccessible managed reference into absence', async () => {
    const root = testTmpDir('removal-proc-'); const child = await processAt(root)
    const current = captureManagedReferences([{ pid: child.pid!, member: true }], root)
    const original = fs.readlinkSync
    vi.spyOn(fs, 'readlinkSync').mockImplementation((...args: Parameters<typeof fs.readlinkSync>) => {
      if (args[0] === `/proc/${child.pid}/cwd`) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return original(...args)
    })
    expect(current).toThrow('denied')
  })
})


it('protects actual Codex short homes and refuses failed account-source reads rather than accepting an empty inventory', () => {
  const root = testTmpDir('removal-accounts-'); const settings = structuredClone(DEFAULT_SETTINGS)
  settings.codexAccounts = [{ id: 'managed', label: 'Managed' }]
  let unavailable = false
  const proof = captureRemovalAccountPaths(() => { if (unavailable) throw new Error('settings unavailable'); return settings }, root)
  const home = codexHomeForAccount(root, 'managed')
  expect(proof.paths).toContain(home)
  expect(() => assertRemovalProtectedPaths(path.dirname(home), proof.paths)).toThrow('protected-root')
  unavailable = true
  expect(proof.assertCurrent).toThrow('settings unavailable')
})
