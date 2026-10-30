import fs from 'node:fs'
import path from 'node:path'
import { isSafeNodeId } from '../shared/safe-id'
import type { WorktreeRecoveryInspection, WorktreeRecoveryItem, WorktreeRecoveryKeepReply, WorktreeRecoveryList } from '../shared/worktree-recovery'
import type { AccountOwner } from './owner-lifetimes'
import type { PtyManager } from './pty-manager'
import type { GitService } from './git-service'
import { withGitRemoteResolver } from './remote-ssh/remote-git'
import type { WorktreeRemovalJournal, WorktreeRemovalRecord } from './worktree-removal-journal'

interface Dependencies {
  journal: WorktreeRemovalJournal
  pty: Pick<PtyManager, 'runWorktreeAction'>
  git: Pick<GitService, 'worktreeList'>
}
const item = (row: WorktreeRemovalRecord): WorktreeRecoveryItem => ({ id: row.id, createdAt: row.createdAt,
  phase: row.phase, projectId: row.projectId, groupId: row.groupId, repoPath: row.repoPath,
  path: row.worktreePath, branch: row.branch, fallbackCwd: row.fallbackCwd, memberIds: row.members.map((member) => member.nodeId) })
const refused = (error: string): WorktreeRecoveryKeepReply => ({ ok: false, outcome: 'refused', error })

/** Non-destructive owner recovery only. Keeping a checkout requires the original canonical inode
 * and linked Git branch, rechecked inside the journal FIFO under the actual host node barrier.
 * There is no Git mutation, session input, teardown, canvas edit or replay of the old removal.
 */
export class WorktreeRecoveryService {
  private pending = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  list(owner: AccountOwner): WorktreeRecoveryList {
    if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
    try { return { ok: true, records: this.deps.journal.list().map(item) } }
    catch { return { ok: false, error: 'Worktree recovery state is unavailable. Inspect the host journal before changing it.' } }
  }

  private row(id: string): WorktreeRemovalRecord {
    if (!isSafeNodeId(id)) throw new Error('Invalid recovery reference.')
    const row = this.deps.journal.list().find((candidate) => candidate.id === id)
    if (!row) throw new Error('This recovery is no longer pending. Reload recovery status.')
    return row
  }
  private directoryIntact(row: WorktreeRemovalRecord): void {
    const stat = fs.lstatSync(row.worktreePath, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n || `${stat.dev}:${stat.ino}` !== row.directoryStamp ||
      fs.realpathSync.native(row.worktreePath) !== row.worktreePath || fs.realpathSync.native(row.repoPath) !== row.repoPath ||
      path.resolve(row.worktreePath) !== row.worktreePath) throw new Error('The original worktree directory identity changed.')
  }
  private async verifyKept(row: WorktreeRemovalRecord): Promise<void> {
    this.directoryIntact(row)
    // Recovery facts are local host paths, regardless of which project another UI has selected.
    const listed = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeList(row.repoPath))
    if (!listed.ok) throw Object.assign(new Error('The local Git worktree list is unavailable.'), { code: 'EWORKTREEUNAVAILABLE' })
    const matches = listed.entries.filter((entry) => path.resolve(entry.path) === row.worktreePath)
    if (matches.length !== 1 || matches[0] === listed.entries[0] || matches[0].isBare || matches[0].prunable ||
      matches[0].branch !== row.branch) throw new Error('The original linked checkout and branch could not be verified.')
    this.directoryIntact(row)
  }

  async inspect(id: string, owner: AccountOwner): Promise<WorktreeRecoveryInspection> {
    if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
    let row: WorktreeRemovalRecord
    try { row = this.row(id) } catch (error) { return { ok: false, error: String(error) } }
    let status: 'kept' | 'missing' | 'changed' | 'unavailable' = 'unavailable'
    try { await this.verifyKept(row); status = 'kept' }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      status = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code ? 'unavailable' : 'changed'
    }
    try {
      if (!owner.active() || JSON.stringify(this.row(id)) !== JSON.stringify(row)) return { ok: false, error: 'Recovery changed during inspection. Reload status.' }
      return { ok: true, record: item(row), status }
    } catch { return { ok: false, error: 'Recovery changed during inspection. Reload status.' } }
  }

  /** Authenticated owner click is the fresh approval to KEEP this immutable record's checkout.
   * An agent cannot invoke this entry. Waiting occurs outside workspace and command queues. */
  async keep(id: string, owner: AccountOwner): Promise<WorktreeRecoveryKeepReply> {
    if (!owner.active()) return refused('worktree-recovery-owner-required')
    if (this.pending.has(id) || this.pending.size >= 32) return refused('Another recovery is still completing. Reload status before retrying.')
    let row: WorktreeRemovalRecord
    try {
      row = this.row(id)
      if (row.phase !== 'prepared') return refused('Only an uncertain prepared removal can keep its original checkout. This record needs a different recovery.')
    } catch (error) { return refused(String(error)) }
    const binding = JSON.stringify(row)
    this.pending.add(id); let released = false
    const current = () => {
      try {
        if (!owner.active()) return false
        const fresh = this.deps.journal.list().find((candidate) => candidate.id === id)
        if (released) return !fresh
        if (!fresh || JSON.stringify(fresh) !== binding) return false
        this.directoryIntact(row); return true
      } catch { return false }
    }
    try {
      await this.deps.pty.runWorktreeAction(row.members.map((member) => member.nodeId), { current, owner, timeoutMs: 30_000 }, async (permit) => {
        await this.deps.journal.releaseKept(id, {
          verify: async () => { await this.verifyKept(row); permit.assertCurrent() }, assertCurrent: permit.assertCurrent
        })
        released = true
      })
      return { ok: true, outcome: 'kept', message: `Kept ${row.branch} and its existing directory. Pending recovery restrictions were released; no session was restarted.` }
    } catch (error) {
      let uncertain = released
      try { this.deps.journal.list() } catch { uncertain = true }
      return uncertain ? { ok: false, outcome: 'uncertain', error: 'Keeping the checkout may have completed. Reload recovery state before another action.' } :
        refused(`The checkout was not released: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.pending.delete(id) }
  }
}
