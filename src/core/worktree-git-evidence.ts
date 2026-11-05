import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Private evidence only: no file contents or command text are persisted or sent to clients. */
export interface WorktreeGitEvidence { gitDirectory: string; commonDirectory: string; fingerprint: string }
const fail = () => new Error('The approved Git repository or linked metadata changed or cannot be verified.')

/** Bounded synchronous evidence, usable at the actual effect dispatch with no intervening await.
 * It is not an OS filesystem lock. Supported Git markers/common-dir metadata must be canonical,
 * regular and stable throughout this read; redirects, oversized inventories and special files refuse.
 */
export function captureWorktreeGitEvidence(repo: string, includePrimaryHead = false): WorktreeGitEvidence {
  const facts: unknown[] = []; let bytes = 0
  const directory = (name: string) => {
    const stat = fs.lstatSync(name, { bigint: true })
    if (!stat.isDirectory() || !stat.ino || fs.realpathSync.native(name) !== name) throw fail()
    facts.push([name, 'directory', `${stat.dev}:${stat.ino}`])
  }
  const file = (name: string, optional = false): string | undefined => {
    let fd: number | undefined
    try {
      fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      const before = fs.fstatSync(fd, { bigint: true }); const named = fs.lstatSync(name, { bigint: true })
      const stamp = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
      if (!before.isFile() || !before.ino || !named.isFile() || stamp(before) !== stamp(named) ||
        before.size > 65536n || bytes + Number(before.size) > 512 * 1024) throw fail()
      const buffer = Buffer.alloc(Number(before.size) + 1)
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0)
      if (count !== Number(before.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) ||
        stamp(fs.lstatSync(name, { bigint: true })) !== stamp(before)) throw fail()
      bytes += count
      const content = buffer.subarray(0, count)
      facts.push([name, 'file', stamp(before), createHash('sha256').update(content).digest('hex')])
      return content.toString('utf8')
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { facts.push([name, 'absent']); return undefined }
      throw fail()
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  const marker = path.join(repo, '.git'); const stat = fs.lstatSync(marker)
  let gitDirectory: string
  if (stat.isDirectory()) { directory(marker); gitDirectory = marker }
  else {
    const content = file(marker)!
    const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(content)
    if (!match) throw fail()
    gitDirectory = path.resolve(repo, match[1]); directory(gitDirectory)
  }
  const common = file(path.join(gitDirectory, 'commondir'), true)
  if (common !== undefined && !/^[^\0\r\n]+\r?\n?$/.test(common)) throw fail()
  const commonDirectory = common === undefined ? gitDirectory : path.resolve(gitDirectory, common.trimEnd())
  directory(commonDirectory)
  file(path.join(commonDirectory, 'config'))
  file(path.join(gitDirectory, 'HEAD'))
  // A saved repository may itself be a linked checkout. The adopted merge target comes
  // from the primary checkout, whose HEAD must remain part of the original approval.
  if (includePrimaryHead && commonDirectory !== gitDirectory) file(path.join(commonDirectory, 'HEAD'))
  const inventory = path.join(commonDirectory, 'worktrees')
  let names: string[] = []
  try { directory(inventory); names = fs.readdirSync(inventory).sort() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    facts.push([inventory, 'absent'])
  }
  if (names.length > 128) throw fail()
  facts.push([inventory, 'entries', names])
  for (const name of names) {
    const admin = path.join(inventory, name); directory(admin)
    file(path.join(admin, 'gitdir')); file(path.join(admin, 'commondir')); file(path.join(admin, 'HEAD'))
    file(path.join(admin, 'locked'), true)
  }
  return { gitDirectory, commonDirectory, fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex') }
}
export function assertWorktreeGitEvidence(repo: string, expected: WorktreeGitEvidence, includePrimaryHead = false): void {
  const actual = captureWorktreeGitEvidence(repo, includePrimaryHead)
  if (actual.gitDirectory !== expected.gitDirectory || actual.commonDirectory !== expected.commonDirectory ||
    actual.fingerprint !== expected.fingerprint) throw fail()
}
