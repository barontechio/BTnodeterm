import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initWorktreeRecovery } from './worktree-recovery'
import { testTmpDir } from './test-tmp'

describe('owning-core worktree recovery boot', () => {
  it('loads missing recovery state without writing a file or changing ordinary directory admission', async () => {
    const root = fs.realpathSync(testTmpDir('worktree-recovery-boot-')); const setWorktreeRecoveryAdmission = vi.fn()
    const journal = await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission }, () => true)
    expect(journal!.list()).toEqual([])
    expect(fs.existsSync(path.join(root, 'worktree-removals.json'))).toBe(false)
    const admit = setWorktreeRecoveryAdmission.mock.calls[0][0] as (cwd: string) => void
    expect(() => admit('/not/required/to/exist')).not.toThrow()
  })

  it('keeps corrupt recovery facts and installs a refusal without failing boot', async () => {
    const root = fs.realpathSync(testTmpDir('worktree-recovery-corrupt-')); const file = path.join(root, 'worktree-removals.json')
    fs.writeFileSync(file, '{broken'); const setWorktreeRecoveryAdmission = vi.fn()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission }, () => true)
      const admit = setWorktreeRecoveryAdmission.mock.calls[0][0] as (cwd: string) => void
      expect(() => admit(root)).toThrow('journal-unavailable')
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
      expect(warning).toHaveBeenCalledOnce()
    } finally { warning.mockRestore() }
  })

  it('leaves recovery ownership with the actual owner and invalidates a later loss', async () => {
    const root = fs.realpathSync(testTmpDir('worktree-recovery-owner-')); const setWorktreeRecoveryAdmission = vi.fn()
    expect(await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission }, () => false)).toBeNull()
    expect(setWorktreeRecoveryAdmission).not.toHaveBeenCalled()
    let owner = true
    await initWorktreeRecovery(root, { setWorktreeRecoveryAdmission }, () => owner)
    const admit = setWorktreeRecoveryAdmission.mock.calls[0][0] as (cwd: string) => void
    owner = false; expect(() => admit(root)).toThrow('owner-required')
    owner = true; expect(() => admit(root)).toThrow('journal-unavailable')
  })
})
