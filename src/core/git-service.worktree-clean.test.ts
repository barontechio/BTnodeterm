import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService } from './git-service'
import { setGitRemoteResolver } from './remote-ssh/remote-git'
import { testTmpDir } from './test-tmp'

const injected = vi.hoisted(() => ({ afterReply: undefined as undefined | ((args: readonly string[]) => void), removes: 0 }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { promisify } = await import('node:util')
  const realRun = promisify(actual.execFile)
  const exec = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args)
  Object.defineProperty(exec, promisify.custom, { value: async (...args: Parameters<typeof realRun>) => {
    const argv = args[1] as readonly string[]
    if (argv[0] === 'worktree' && argv[1] === 'remove') injected.removes++
    const result = await realRun(...args)
    injected.afterReply?.(argv)
    return result
  } })
  return { ...actual, execFile: exec }
})

describe('clean host worktree removal against real Git', () => {
  let repo: string; let checkout: string; let root: string
  const service = new GitService()
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const proof = (directory = checkout) => {
    const stat = fs.lstatSync(directory, { bigint: true })
    return { directoryStamp: `${stat.dev}:${stat.ino}`, assertCurrent() {} }
  }
  let approved: ReturnType<typeof proof>
  const remove = (branch = 'feature') => service.worktreeRemoveClean(repo, checkout, branch, true, approved)
  beforeEach(() => {
    injected.afterReply = undefined; injected.removes = 0
    root = fs.realpathSync(testTmpDir('worktree-clean-')); repo = path.join(root, 'repo'); checkout = path.join(root, 'checkout')
    fs.mkdirSync(repo)
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    fs.writeFileSync(path.join(repo, 'tracked'), 'base'); git('add', 'tracked'); git('commit', '-m', 'base')
    git('worktree', 'add', '-b', 'feature', checkout)
    approved = proof()
  })
  afterEach(() => { setGitRemoteResolver(null); vi.restoreAllMocks() })

  it('preserves modified tracked and untracked files, without deleting the branch', async () => {
    fs.writeFileSync(path.join(checkout, 'tracked'), 'unfinished work')
    expect(await remove()).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('unfinished work')
    fs.writeFileSync(path.join(checkout, 'tracked'), 'base')
    fs.writeFileSync(path.join(checkout, 'untracked'), 'keep this too')
    expect(await remove()).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(checkout, 'untracked'), 'utf8')).toBe('keep this too')
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('refuses locked, changed-branch and primary checkouts without side effects', async () => {
    git('worktree', 'lock', checkout)
    expect(await remove()).toMatchObject({ ok: false })
    git('worktree', 'unlock', checkout)
    expect(await remove('another-branch')).toMatchObject({ ok: false })
    expect(await service.worktreeRemoveClean(checkout, repo, 'main', true, proof(repo))).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(repo, 'tracked'), 'utf8')).toBe('base')
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('base')
  })

  it('removes a clean checkout and retains a branch with unmerged commits', async () => {
    fs.writeFileSync(path.join(checkout, 'tracked'), 'committed feature')
    execFileSync('git', ['-C', checkout, 'commit', '-am', 'feature'], { stdio: 'ignore' })
    const result = await remove()
    expect(result).toMatchObject({ ok: true, worktreeGone: true })
    expect(result.message).toContain('kept')
    expect(fs.existsSync(checkout)).toBe(false)
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('removes a clean merged checkout and deletes only its expected branch', async () => {
    expect(await remove()).toMatchObject({ ok: true, worktreeGone: true })
    expect(fs.existsSync(checkout)).toBe(false)
    expect(git('branch', '--list', 'feature')).toBe('')
    expect(fs.readFileSync(path.join(repo, 'tracked'), 'utf8')).toBe('base')
  })

  it('refuses missing and redirected paths without inferring permission to prune or delete', async () => {
    fs.renameSync(checkout, path.join(root, 'parked'))
    expect(await remove()).toMatchObject({ ok: false })
    if (process.platform !== 'win32') {
      const other = path.join(root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep'), 'owned elsewhere')
      fs.symlinkSync(other, checkout)
      expect(await remove()).toMatchObject({ ok: false })
      expect(fs.readFileSync(path.join(other, 'keep'), 'utf8')).toBe('owned elsewhere')
    }
    expect(git('worktree', 'list', '--porcelain')).toContain(checkout)
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('shows that raw no-force Git discards ignored data, while the guarded path preserves all ignored entries', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.env\ncache/\n')
    fs.writeFileSync(path.join(checkout, '.env'), 'private settings')
    fs.mkdirSync(path.join(checkout, 'cache'))
    fs.writeFileSync(path.join(checkout, 'cache', 'data'), 'valuable data')
    expect(await remove()).toMatchObject({ ok: false, message: expect.stringContaining('Ignored files') })
    expect(fs.readFileSync(path.join(checkout, '.env'), 'utf8')).toBe('private settings')
    expect(fs.readFileSync(path.join(checkout, 'cache', 'data'), 'utf8')).toBe('valuable data')
    git('worktree', 'remove', '--', checkout)
    expect(fs.existsSync(checkout)).toBe(false)
  })

  it('refuses a replacement inode rather than approving the directory found at invocation time', async () => {
    fs.renameSync(checkout, path.join(root, 'original'))
    fs.mkdirSync(checkout)
    fs.writeFileSync(path.join(checkout, 'keep'), 'replacement')
    expect(await remove()).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(checkout, 'keep'), 'utf8')).toBe('replacement')
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('checks owner dispatch freshness after asynchronous Git inspection and before deletion', async () => {
    let checks = 0
    approved.assertCurrent = () => { if (++checks >= 5) throw new Error('owner expired') }
    expect(await remove()).toMatchObject({ ok: false })
    expect(checks).toBeGreaterThanOrEqual(5)
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('base')
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('rechecks the approved inode at the final dispatch after the ignored-file probe', async () => {
    let checks = 0
    approved.assertCurrent = () => {
      if (++checks !== 5) return
      fs.renameSync(checkout, path.join(root, 'original'))
      fs.mkdirSync(checkout)
      fs.writeFileSync(path.join(checkout, 'keep'), 'replacement')
    }
    expect(await remove()).toMatchObject({ ok: false })
    expect(checks).toBe(5)
    expect(fs.readFileSync(path.join(checkout, 'keep'), 'utf8')).toBe('replacement')
    expect(fs.readFileSync(path.join(root, 'original', 'tracked'), 'utf8')).toBe('base')
  })

  it('refuses a same-inode branch switch after ignored-file inspection', async () => {
    injected.afterReply = (args) => {
      if (args[0] === 'ls-files') execFileSync('git', ['-C', checkout, 'switch', '-c', 'replacement'], { stdio: 'ignore' })
    }
    expect(await remove()).toMatchObject({ ok: false })
    expect(injected.removes).toBe(0)
    expect(fs.existsSync(checkout)).toBe(true)
    expect(git('branch', '--list', 'feature')).toContain('feature')
    expect(git('branch', '--list', 'replacement')).toContain('replacement')
  })

  it('preserves uncertainty when removal succeeds, its reply is lost and absence cannot be proved', async () => {
    const originalStat = fs.promises.stat
    let removed = false
    vi.spyOn(fs.promises, 'stat').mockImplementation((...args: Parameters<typeof originalStat>) => {
      if (removed && args[0] === checkout) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
      return originalStat(...args)
    })
    injected.afterReply = (args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') { removed = true; throw new Error('lost reply') }
    }
    const result = await remove()
    expect(result).toMatchObject({ ok: false, recoveryRequired: true, message: expect.stringContaining('do not retry') })
    expect(result.worktreeGone).toBeUndefined()
    expect(result.message).not.toContain('Nothing was intentionally discarded')
    expect(injected.removes).toBe(1)
    expect(fs.existsSync(checkout)).toBe(false)
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('refuses a branch switch at the last owner check before subprocess dispatch', async () => {
    let checks = 0
    approved.assertCurrent = () => {
      if (++checks === 5) execFileSync('git', ['-C', checkout, 'switch', '-c', 'replacement'], { stdio: 'ignore' })
    }
    expect(await remove()).toMatchObject({ ok: false })
    expect(injected.removes).toBe(0)
    expect(fs.existsSync(checkout)).toBe(true)
  })

  it('records verified absence after a lost reply without repeating removal or deleting the branch', async () => {
    injected.afterReply = (args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('lost reply')
    }
    expect(await remove()).toMatchObject({ ok: false, recoveryRequired: true, worktreeGone: true })
    expect(injected.removes).toBe(1)
    expect(fs.existsSync(checkout)).toBe(false)
    expect(git('branch', '--list', 'feature')).toContain('feature')
  })

  it('refuses a remotely routed repository before local filesystem checks', async () => {
    setGitRemoteResolver((cwd) => cwd === repo ? { conn: { host: '127.0.0.1', user: 'fixture', port: 65_536 }, controlPath: '/unused' } : undefined)
    expect(await remove()).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('base')
  })
})
