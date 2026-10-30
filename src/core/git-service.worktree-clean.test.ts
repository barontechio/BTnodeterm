import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'
import { setGitRemoteResolver } from './remote-ssh/remote-git'
import { testTmpDir } from './test-tmp'

describe('clean host worktree removal against real Git', () => {
  let repo: string; let checkout: string; let root: string
  const service = new GitService()
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const remove = (branch = 'feature') => service.worktreeRemoveClean(repo, checkout, branch, true)
  beforeEach(() => {
    root = fs.realpathSync(testTmpDir('worktree-clean-')); repo = path.join(root, 'repo'); checkout = path.join(root, 'checkout')
    fs.mkdirSync(repo)
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    fs.writeFileSync(path.join(repo, 'tracked'), 'base'); git('add', 'tracked'); git('commit', '-m', 'base')
    git('worktree', 'add', '-b', 'feature', checkout)
  })
  afterEach(() => setGitRemoteResolver(null))

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
    expect(await service.worktreeRemoveClean(checkout, repo, 'main', true)).toMatchObject({ ok: false })
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

  it('refuses a remotely routed repository before local filesystem checks', async () => {
    setGitRemoteResolver((cwd) => cwd === repo ? { conn: { host: '127.0.0.1', user: 'fixture', port: 65_536 }, controlPath: '/unused' } : undefined)
    expect(await remove()).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('base')
  })
})
