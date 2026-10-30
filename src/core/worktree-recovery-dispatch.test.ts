import { describe, expect, it } from 'vitest'
import { NodeExecutionCoordinator, type NodeExecutionBatchPermit } from './node-execution'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import { OwnerLifetimes } from './owner-lifetimes'

function fixture() {
  const blocked = new Set(['member', 'other'])
  const dispatch = new WorktreeRecoveryDispatch({ isNodePending: (id) => blocked.has(id) })
  const coordinator = new NodeExecutionCoordinator()
  coordinator.setDispatchAdmission((id, permit) => dispatch.assertAllowed(id, permit))
  return { blocked, dispatch, coordinator }
}
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
describe('pending worktree member dispatch', () => {
  it('refuses direct and ordinarily claimed dispatch, including a worktree action label', async () => {
    const { coordinator } = fixture()
    expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
    coordinator.assertAllowed('outside')
    for (const kind of ['write', 'restart', 'account', 'branch', 'worktree'] as const) {
      await expect(coordinator.runMany(['member'], kind, { current: () => true }, () => coordinator.assertAllowed('member')))
        .rejects.toThrow('recovery-required')
    }
  })

  it('allows only the explicitly registered real permit and its members for the awaited recovery', async () => {
    const { dispatch, coordinator } = fixture()
    await coordinator.runMany(['member'], 'worktree', { current: () => true }, async (permit) => {
      await dispatch.withRecovery(permit, () => {
        coordinator.assertAllowed('member')
        expect(() => coordinator.assertAllowed('other')).toThrow('recovery-required')
        expect(() => coordinator.backend(() => coordinator.assertAllowed('member'))).toThrow('busy')
      })
      expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
    })
    expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
  })

  it('cannot turn a different action permit into recovery or retain a grant after throwing', async () => {
    const { dispatch, coordinator } = fixture()
    await coordinator.runMany(['member'], 'write', { current: () => true }, async (permit) => {
      await expect(dispatch.withRecovery(permit, () => {})).rejects.toThrow('invalid-permit')
      expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
    })
    await coordinator.runMany(['member'], 'worktree', { current: () => true }, async (permit) => {
      await expect(dispatch.withRecovery(permit, () => { throw new Error('kill acknowledgement lost') })).rejects.toThrow('acknowledgement')
      expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
    })
  })

  it('cannot substitute a structurally identical permit for the one held by the real dispatch context', async () => {
    const { dispatch, coordinator } = fixture()
    await coordinator.runMany(['member'], 'worktree', { current: () => true }, async (actual) => {
      const lookalike: NodeExecutionBatchPermit = { ...actual }
      await dispatch.withRecovery(lookalike, () => {
        expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
      })
      expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
    })
  })

  it('retains the physical claim after owner departure but refuses further recovery dispatch', async () => {
    const { dispatch, coordinator } = fixture(); const owners = new OwnerLifetimes()
    const started = deferred(); const done = deferred()
    const work = coordinator.runMany(['member'], 'worktree', { current: () => true, owner: owners.get(1, () => true) },
      (permit) => dispatch.withRecovery(permit, async () => {
        coordinator.assertAllowed('member'); started.resolve(); await done.promise
        coordinator.assertAllowed('member')
      }))
    void work.catch(() => {}); await started.promise; owners.forget(1)
    expect(coordinator.isBusy('member')).toBe(true)
    done.resolve(); await expect(work).rejects.toThrow('expired')
    expect(coordinator.isBusy('member')).toBe(false)
    expect(() => coordinator.assertAllowed('member')).toThrow('recovery-required')
  })

  it('refuses detached application continuations and resumes ordinary dispatch only after recovery facts clear', async () => {
    const { blocked, dispatch, coordinator } = fixture(); const resume = deferred(); let late!: Promise<void>
    await coordinator.runMany(['member'], 'worktree', { current: () => true }, (permit) => dispatch.withRecovery(permit, () => {
      late = resume.promise.then(() => coordinator.assertAllowed('member'))
    }))
    void late.catch(() => {}); blocked.delete('member'); resume.resolve()
    await expect(late).rejects.toThrow('expired')
    expect(() => coordinator.assertAllowed('member')).not.toThrow()
    expect(() => coordinator.assertAllowed('other')).toThrow('recovery-required')
  })
})
