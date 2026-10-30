import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { worktreeRecoveryAdmission } from './worktree-recovery-admission'
import { testTmpDir } from './test-tmp'

afterEach(() => vi.restoreAllMocks())
describe('physical backend admission from worktree recovery facts', () => {
  it('costs no path resolution without reserved roots and refuses an unavailable journal', () => {
    const realpath = vi.spyOn(fs.realpathSync, 'native')
    worktreeRecoveryAdmission({ reservedPaths: () => [] })('/does/not/exist')
    expect(realpath).not.toHaveBeenCalled()
    expect(() => worktreeRecoveryAdmission({ reservedPaths: () => { throw new Error('journal-unavailable') } })('/repo')).toThrow('journal-unavailable')
  })

  it('blocks a missing checkout and its descendants while preserving the parent and siblings', () => {
    const root = fs.realpathSync(testTmpDir('worktree-admission-')); const checkout = path.join(root, 'checkout')
    const admit = worktreeRecoveryAdmission({ reservedPaths: () => [checkout] })
    expect(() => admit(checkout)).toThrow('recovery-required')
    expect(() => admit(path.join(checkout, 'nested', 'terminal'))).toThrow('recovery-required')
    expect(() => admit(root)).not.toThrow()
    expect(() => admit(path.join(root, 'checkout-other'))).not.toThrow()
  })

  it.skipIf(process.platform === 'win32')('resolves both existing parent aliases and dangling aliases to a removed checkout', () => {
    const root = fs.realpathSync(testTmpDir('worktree-admission-alias-')); const checkout = path.join(root, 'checkout')
    const alias = path.join(root, 'alias'); const parentAlias = path.join(root, 'parent-alias')
    fs.symlinkSync('checkout', alias); fs.symlinkSync(root, parentAlias)
    const admit = worktreeRecoveryAdmission({ reservedPaths: () => [checkout] })
    expect(() => admit(path.join(alias, 'nested'))).toThrow('recovery-required')
    expect(() => admit(path.join(parentAlias, 'checkout', 'nested'))).toThrow('recovery-required')
    expect(() => admit(path.join(parentAlias, 'other'))).not.toThrow()
  })

  it.skipIf(process.platform === 'win32')('refuses unresolved symlink cycles instead of using a lexical fallback', () => {
    const root = fs.realpathSync(testTmpDir('worktree-admission-cycle-'))
    fs.symlinkSync('second', path.join(root, 'first')); fs.symlinkSync('first', path.join(root, 'second'))
    const admit = worktreeRecoveryAdmission({ reservedPaths: () => [path.join(root, 'checkout')] })
    expect(() => admit(path.join(root, 'first', 'nested'))).toThrow('unverifiable')
  })

  it('refuses permission failures and bounded-resolution exhaustion', () => {
    const root = fs.realpathSync(testTmpDir('worktree-admission-error-'))
    const admit = worktreeRecoveryAdmission({ reservedPaths: () => [path.join(root, 'checkout')] })
    const resolution = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw Object.assign(new Error('permission'), { code: 'EACCES' }) })
    expect(() => admit(path.join(root, 'other'))).toThrow('unverifiable'); resolution.mockRestore()
    expect(() => admit(path.join(root, ...Array.from({ length: 140 }, () => 'nested')))).toThrow('unverifiable')
  })
})
