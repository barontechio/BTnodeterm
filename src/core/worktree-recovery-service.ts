import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { captureWorktreeGitEvidence, assertWorktreeGitEvidence } from './worktree-git-evidence'
import path from 'node:path'
import { CanvasContentWriter } from './canvas-content-writer'
import { carryLocalNodeExec } from '../shared/node-exec'
import { canvasExecutionBinding } from './canvas-execution-reservations'
import type { WorktreeCanvasAdmission } from './worktree-canvas-admission'
import type { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'
import type { OwnerConfirmationBroker, OwnerPermit } from './owner-confirmation'
import type { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Workspace } from '../shared/types'
import { descendantIds, isAncestorPath, isRemoteSessionNode } from '../shared/worktree'
import { worktreeRecoveryAdmission } from './worktree-recovery-admission'
import { isSafeNodeId } from '../shared/safe-id'
import type { WorktreeRecoveryInspection, WorktreeRecoveryItem, WorktreeRecoveryKeepReply, WorktreeRecoveryList, WorktreeRecoveryRepairReply, WorktreeMissingList } from '../shared/worktree-recovery'
import type { AccountOwner } from './owner-lifetimes'
import type { PtyManager } from './pty-manager'
import type { GitService } from './git-service'
import { withGitRemoteResolver } from './remote-ssh/remote-git'
import type { WorktreeRemovalJournal, WorktreeRemovalRecord } from './worktree-removal-journal'

interface Dependencies {
  journal: WorktreeRemovalJournal
  pty: Pick<PtyManager, 'runWorktreeAction'> & Partial<Pick<PtyManager, 'recycleWorktreeMember' | 'nodeExecutionIdentity'>>
  git: Pick<GitService, 'worktreeList'> & Partial<Pick<GitService, 'worktreeRecoveryDirectories'>>
  repair?: { workspace: WorkspaceStore; admission: WorktreeCanvasAdmission; dispatch: WorktreeRecoveryDispatch; confirmations: Pick<OwnerConfirmationBroker, 'request'> }
}
const item = (row: WorktreeRemovalRecord): WorktreeRecoveryItem => ({ id: row.id, createdAt: row.createdAt,
  phase: row.phase, provenance: row.provenance.kind, projectId: row.projectId, groupId: row.groupId, repoPath: row.repoPath,
  path: row.worktreePath, branch: row.branch, fallbackCwd: row.fallbackCwd, memberIds: row.members.map((member) => member.nodeId), ...(row.repair?.manualStart.length ? { manualStartIds: row.repair.manualStart } : {}) })
const refused = (error: string): WorktreeRecoveryKeepReply => ({ ok: false, outcome: 'refused', error })

/** Owner recovery without Git mutation or command replay. Keeping requires the original inode
 * and linked branch; missing recovery requires absence, acknowledged teardown and durable repair.
 * Observation before any record never invents prior directory or Git-dispatch evidence.
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
    if (row.provenance.kind !== 'recorded-directory') throw new Error('No prior checkout identity was recorded.')
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

  /** ENOENT from another proof (repository, Git metadata) is not checkout absence. Refuse
   * redirected/unsearchable ancestors and ENOTDIR rather than treating failed IO as absence. */
  private missingAncestry(worktreePath: string): { ancestor: string; ancestorStamp: string } | null {
    if (!path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) throw new Error('The checkout path is not canonical.')
    try { fs.lstatSync(worktreePath); return null }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let parent = path.dirname(worktreePath)
    for (let depth = 0; depth < 128; depth++) {
      try {
        const stat = fs.lstatSync(parent, { bigint: true })
        if (!stat.ino || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(parent) !== parent)
          throw new Error('The missing checkout ancestry changed.')
        fs.accessSync(parent, fs.constants.R_OK | fs.constants.X_OK)
        return { ancestor: parent, ancestorStamp: `${stat.dev}:${stat.ino}` }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const next = path.dirname(parent); if (next === parent) break; parent = next
    }
    throw new Error('Checkout absence could not be verified.')
  }

  private directoryMissing(row: WorktreeRemovalRecord): boolean {
    const ancestry = this.missingAncestry(row.worktreePath)
    if (!ancestry) return false
    if (row.provenance.kind === 'observed-missing') {
      assertWorktreeGitEvidence(row.repoPath, row.provenance.git)
      const stat = fs.lstatSync(row.repoPath, { bigint: true })
      if (!stat.isDirectory() || fs.realpathSync.native(row.repoPath) !== row.repoPath ||
        `${stat.dev}:${stat.ino}` !== row.provenance.repoStamp || ancestry.ancestor !== row.provenance.ancestor ||
        ancestry.ancestorStamp !== row.provenance.ancestorStamp) throw new Error('The observed missing-checkout ancestry or repository changed.')
    }
    return true
  }

  private proposeMissing(workspace: Workspace, groupId: string): WorktreeRemovalRecord {
    if (!isSafeNodeId(groupId)) throw new Error('Invalid saved group reference.')
    const hits = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === groupId).map((node) => ({ project, node })))
    if (hits.length !== 1 || hits[0].node.kind !== 'group' || !hits[0].node.worktree) throw new Error('One saved worktree group is required.')
    const { project, node: group } = hits[0]; const binding = group.worktree!
    const ancestry = this.missingAncestry(binding.path)
    if (!ancestry) throw new Error('The checkout is present. No missing-checkout recovery was recorded.')
    const repo = fs.lstatSync(binding.repoPath, { bigint: true })
    if (!repo.isDirectory() || !repo.ino || fs.realpathSync.native(binding.repoPath) !== binding.repoPath)
      throw new Error('The local repository is unavailable or redirected.')
    fs.accessSync(binding.repoPath, fs.constants.R_OK | fs.constants.X_OK)
    if (this.deps.journal.reservedPaths().some((reserved) => isAncestorPath(reserved, binding.path) || isAncestorPath(binding.path, reserved)))
      throw new Error('This checkout already has recovery facts. Inspect that record.')
    const ids = new Set([groupId, ...descendantIds(project.nodes, groupId)])
    if (ids.size > 32) throw new Error('The affected group exceeds recovery capacity.')
    const observedAt = Date.now()
    const row: WorktreeRemovalRecord = { id: randomUUID(), createdAt: observedAt, phase: 'removed', projectId: project.id, groupId,
      repoPath: binding.repoPath, worktreePath: binding.path, branch: binding.branch, fallbackCwd: binding.repoPath,
      provenance: { kind: 'observed-missing', observedAt, ...ancestry, repoStamp: `${repo.dev}:${repo.ino}`, git: captureWorktreeGitEvidence(binding.repoPath) },
      members: project.nodes.filter((node) => ids.has(node.id)).map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project, node) })) }
    this.repairSnapshot(workspace, row)
    return row
  }

  /** Read-only candidates, never auto-recorded facts. The actual action repeats every proof. */
  async discoverMissing(owner: AccountOwner): Promise<WorktreeMissingList> {
    if (!owner.active() || !this.deps.repair) return { ok: false, error: 'Missing-checkout discovery is unavailable.' }
    try {
      const workspace = await this.deps.repair.workspace.load({ sideline: false })
      const candidates: Extract<WorktreeMissingList, { ok: true }>['candidates'] = []
      for (const project of workspace.projects) for (const node of project.nodes) {
        if (candidates.length >= 128) break
        if (node.kind !== 'group' || !node.worktree) continue
        try {
          const row = this.proposeMissing(workspace, node.id)
          candidates.push({ groupId: row.groupId, projectId: row.projectId, branch: row.branch, path: row.worktreePath })
        } catch { /* Unsupported/unavailable identities are never offered as recoverable. */ }
      }
      if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
      return { ok: true, candidates }
    } catch { return { ok: false, error: 'Missing-checkout candidates could not be read.' } }
  }

  private async verifyMissingRepository(row: WorktreeRemovalRecord): Promise<void> {
    if (!this.directoryMissing(row)) throw new Error('The checkout is no longer absent.')
    if (row.provenance.kind !== 'observed-missing' || !this.deps.git.worktreeRecoveryDirectories)
      throw new Error('Git recovery identity inspection is unavailable.')
    const evidence = row.provenance.git
    const directories = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeRecoveryDirectories!(row.repoPath,
      () => assertWorktreeGitEvidence(row.repoPath, evidence)))
    if (!directories || directories.gitDirectory !== evidence.gitDirectory || directories.commonDirectory !== evidence.commonDirectory)
      throw new Error('The approved Git repository route changed.')
    const result = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeList(row.repoPath))
    if (!result.ok || !result.entries.length) throw new Error('The local Git repository cannot be verified.')
    const matches = result.entries.filter((entry) => path.resolve(entry.path) === row.worktreePath)
    if (matches.length > 1 || matches.some((entry) => entry === result.entries[0] || entry.isBare || entry.branch !== row.branch))
      throw new Error('The saved missing-checkout Git association changed.')
    if (!this.directoryMissing(row)) throw new Error('The checkout changed during Git inspection.')
  }

  private repairSnapshot(workspace: Workspace, row: WorktreeRemovalRecord): { projectId: string; nodes: CanvasNodeState[] } {
    const ids = new Set(row.members.map((member) => member.nodeId))
    const projects = workspace.projects.filter((project) => project.id === row.projectId)
    if (projects.length !== 1 || projects[0].unavailable || projects[0].remote || projects[0].ssh || projects[0].handedOffTo)
      throw new Error('Recovery requires one available local project.')
    const project = projects[0]
    if (fs.realpathSync.native(row.fallbackCwd) !== row.fallbackCwd || !fs.statSync(row.fallbackCwd).isDirectory() ||
      isAncestorPath(row.worktreePath, row.fallbackCwd)) throw new Error('The recovery directory is unavailable.')
    worktreeRecoveryAdmission(this.deps.journal)(row.fallbackCwd)
    const admit = worktreeRecoveryAdmission({ reservedPaths: () => [row.worktreePath] })
    const nodes = row.members.map((member) => {
      const hits = workspace.projects.flatMap((candidate) => candidate.nodes.filter((node) => node.id === member.nodeId)
        .map((node) => ({ project: candidate, node })))
      if (hits.length !== 1 || hits[0].project.id !== row.projectId || isRemoteSessionNode(hits[0].node) || hits[0].node.sshFs)
        throw new Error('A recorded recovery member changed project or route.')
      const node = hits[0].node
      if (node.parentId && !ids.has(node.parentId)) throw new Error('A recovery ancestor is outside the recorded member set.')
      const binding = canvasExecutionBinding(project, node)
      if (binding !== member.binding && binding !== row.repair?.members.find((entry) => entry.nodeId === node.id)?.binding &&
        binding !== row.repair?.staged?.find((entry) => entry.nodeId === node.id)?.binding)
        throw new Error('A recorded execution identity changed. Keep the recovery facts for explicit reconciliation.')
      // Agent recovery needs a verified account/runtime conversation adapter, not a guessed resume.
      if (node.agentId || node.agentSessionId || node.accountId || !['group', 'terminal', 'editor', 'diff'].includes(node.kind))
        throw new Error('This recovery identity needs an account/runtime adapter. No session was changed.')
      return node
    })
    const group = nodes.find((node) => node.id === row.groupId)
    if (!group || group.kind !== 'group' || (!row.repair && (!group.worktree || group.worktree.path !== row.worktreePath ||
      group.worktree.repoPath !== row.repoPath || group.worktree.branch !== row.branch)))
      throw new Error('The recorded checkout binding changed.')
    for (const candidate of workspace.projects) {
      if (candidate.remote || candidate.ssh || candidate.handedOffTo) continue
      for (const node of candidate.nodes) {
        if (ids.has(node.id) || isRemoteSessionNode(node)) continue
        const inert = (node.kind === 'editor' || node.kind === 'diff') && node.fileMissing
        for (const reference of [candidate.cwd, inert ? undefined : node.cwd, node.worktree?.path,
          node.worktree?.repoPath, node.runConfig?.projectDir, inert ? undefined : node.filePath]) {
          if (!reference) continue
          if (!path.isAbsolute(reference) && !candidate.cwd) throw new Error('An unrelated local reference cannot be resolved.')
          admit(path.resolve(candidate.cwd ?? path.parse(reference).root, reference))
        }
      }
    }
    return { projectId: project.id, nodes }
  }

  private repairNodes(nodes: CanvasNodeState[], row: WorktreeRemovalRecord, projectCwd: string | undefined): void {
    const inside = (reference: string, base: string | undefined) => {
      if (!path.isAbsolute(reference) && !base) throw new Error('The recorded local reference is ambiguous.')
      try { worktreeRecoveryAdmission({ reservedPaths: () => [row.worktreePath] })(path.resolve(base ?? path.parse(reference).root, reference)); return false }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('worktree-recovery-required:')) return true
        throw error
      }
    }
    for (const node of nodes) {
      if (node.kind === 'terminal' || node.kind === 'group') {
        if (!node.cwd || inside(node.cwd, projectCwd)) node.cwd = row.fallbackCwd
        if (node.pendingLaunch) node.pendingLaunch = { ...node.pendingLaunch, manualOnly: true }
      } else if (node.filePath && inside(node.filePath, node.kind === 'diff' ? node.cwd ?? projectCwd : projectCwd)) node.fileMissing = true
      if (node.worktree) {
        if (node.worktree.path !== row.worktreePath || node.worktree.repoPath !== row.repoPath || node.worktree.branch !== row.branch)
          throw new Error('A nested checkout binding requires separate recovery.')
        delete node.worktree
      }
    }
  }

  /** Explicit physical-owner recovery of an already journaled missing checkout. Never invokes
   * Git mutation, creates a terminal or submits held input. Unsupported agent identities refuse. */
  recover(id: string, owner: AccountOwner): Promise<WorktreeRecoveryRepairReply> { return this.recoverTarget(id, owner, false) }
  recoverMissing(groupId: string, owner: AccountOwner): Promise<WorktreeRecoveryRepairReply> { return this.recoverTarget(groupId, owner, true) }

  private async recoverTarget(id: string, owner: AccountOwner, unrecorded: boolean): Promise<WorktreeRecoveryRepairReply> {
    const refusedRepair = (error: string): WorktreeRecoveryRepairReply => ({ ok: false, outcome: 'refused', error })
    const domain = this.deps.repair
    if (!owner.active()) return refusedRepair('worktree-recovery-owner-required')
    if (!domain || !this.deps.pty.recycleWorktreeMember || !this.deps.pty.nodeExecutionIdentity)
      return refusedRepair('Missing-checkout recovery is unavailable on this host.')
    if (this.pending.has(id) || this.pending.size >= 32) return refusedRepair('Another recovery is still completing.')
    this.pending.add(id)
    let changed = false
    let approval: Extract<OwnerPermit, { ok: true }> | undefined
    try {
      let row = unrecorded ? this.proposeMissing(await domain.workspace.load({ sideline: false }), id) : this.row(id)
      const initialJournal = JSON.stringify(this.deps.journal.list())
      if (unrecorded) await this.verifyMissingRepository(row)
      if (row.phase === 'recovered') return refusedRepair('Metadata is already recovered. Manual start/rebinding remains required.')
      if (!this.directoryMissing(row)) return refusedRepair('The checkout is present or replaced. Inspect it before recovery.')
      const writer = new CanvasContentWriter({ workspaceStore: domain.workspace })
      const before = this.repairSnapshot(await domain.workspace.load({ sideline: false }), row)
      const physical = new Map(before.nodes.filter((node) => node.kind === 'terminal')
        .map((node) => [node.id, this.deps.pty.nodeExecutionIdentity!(node.id)]))
      let expectedRecord = JSON.stringify(row)
      const recordCurrent = () => unrecorded ? JSON.stringify(this.deps.journal.list()) === initialJournal : JSON.stringify(this.row(row.id)) === expectedRecord
      const answer = await domain.confirmations.request({ action: 'recover-worktree',
        requester: { nodeId: row.groupId, projectId: row.projectId, title: row.branch },
        binding: { record: expectedRecord, members: row.members },
        message: `Recover ${before.nodes.length} saved nodes from the missing checkout ${row.worktreePath}?`,
        details: (unrecorded ? 'This checkout was already missing; no prior directory identity or Git deletion is claimed. ' : '') + 'This acknowledges terminal teardown and repairs the recorded paths. Terminals stay blocked for explicit manual start or verified rebinding. No Git deletion is retried and no command is replayed.',
        confirmLabel: 'Recover recorded nodes', danger: true,
        checkCurrent: async () => {
          if (!owner.active() || !this.directoryMissing(row) || !recordCurrent()) return false
          if (unrecorded) await this.verifyMissingRepository(row)
          this.repairSnapshot(await domain.workspace.load({ sideline: false }), row)
          return before.nodes.filter((node) => node.kind === 'terminal').every((node) => this.deps.pty.nodeExecutionIdentity!(node.id) === physical.get(node.id))
        }
      })
      if (!answer.ok) return refusedRepair(`Owner confirmation ${answer.reason}. No recovery action was dispatched.`)
      approval = answer
      if (!(await answer.consume())) return refusedRepair('The approved recovery identity changed or expired.')
      const current = () => {
        try { return owner.active() && answer.current() && this.directoryMissing(row) && recordCurrent() }
        catch { return false }
      }
      await this.deps.pty.runWorktreeAction(row.members.map((member) => member.nodeId), { owner, current, timeoutMs: 120_000 }, async (permit) => {
        const { value: hold } = await writer.edit((fresh) => {
          permit.assertCurrent(); this.repairSnapshot(fresh, row)
          return domain.admission.reservations.hold(fresh, row.members.map((member) => member.nodeId), permit)
        })
        try {
          permit.assertCurrent()
          if (unrecorded) {
            await this.verifyMissingRepository(row); permit.assertCurrent()
            row = await this.deps.journal.observeMissing(row, permit.assertCurrent)
            unrecorded = false; expectedRecord = JSON.stringify(row); changed = true
          }
          if (row.phase === 'prepared') {
            // Actual observed absence, not a retry of the uncertain earlier deletion.
            row = await this.deps.journal.markRemoved(row.id); expectedRecord = JSON.stringify(row); changed = true
          }
          permit.assertCurrent()
          const candidate = structuredClone(await domain.workspace.load({ sideline: false }))
          const captured = this.repairSnapshot(candidate, row)
          const originalNodes = structuredClone(captured.nodes)
          const project = candidate.projects.find((entry) => entry.id === row.projectId)!
          this.repairNodes(captured.nodes, row, project.cwd)
          const plan = row.repair ?? { members: captured.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project, node) })),
            staged: captured.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project,
              carryLocalNodeExec(originalNodes.find((old) => old.id === node.id), node, false)) })),
            manualStart: captured.nodes.filter((node) => node.kind === 'terminal').map((node) => node.id) }
          const terminals = captured.nodes.filter((node) => node.kind === 'terminal').map((node) => node.id)
          if (plan.manualStart.length !== terminals.length || plan.manualStart.some((id) => !terminals.includes(id)) ||
            captured.nodes.some((node) => canvasExecutionBinding(project, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
            throw new Error('The recorded repair plan no longer matches its target identities.')
          row = await this.deps.journal.planRepair(row.id, plan, permit.assertCurrent)
          expectedRecord = JSON.stringify(row); changed = true
          await domain.dispatch.withRecovery(permit, async () => {
            for (const node of captured.nodes.filter((node) => node.kind === 'terminal')) {
              permit.assertCurrent()
              if (this.deps.pty.nodeExecutionIdentity!(node.id) !== physical.get(node.id)) throw new Error('The terminal generation changed.')
              await this.deps.pty.recycleWorktreeMember!(node.id, permit)
            }
          })
          permit.assertCurrent()
          await writer.repairExecution(hold, (fresh) => {
            permit.assertCurrent()
            const snapshot = this.repairSnapshot(fresh, row)
            const project = fresh.projects.find((entry) => entry.id === row.projectId)!
            this.repairNodes(snapshot.nodes, row, project.cwd)
            if (snapshot.nodes.some((node) => canvasExecutionBinding(project, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
              throw new Error('The approved repair plan changed.')
          })
          permit.assertCurrent()
          const durable = this.repairSnapshot(await domain.workspace.load({ sideline: false }), row)
          const location = domain.workspace.projectExecutionLocation(row.projectId)!
          if (durable.nodes.some((node) => canvasExecutionBinding(location, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
            throw new Error('The repaired metadata was not acknowledged.')
          permit.assertCurrent()
          row = await this.deps.journal.markRecovered(row.id); expectedRecord = JSON.stringify(row)
        } finally { hold.release() }
      })
      return { ok: true, outcome: 'recovered', message: 'Missing-checkout metadata recovered. Terminals remain blocked for explicit manual start or rebinding; no command was replayed.' }
    } catch (error) {
      try { this.deps.journal.list() } catch { changed = true }
      return { ok: false, outcome: changed ? 'uncertain' : 'refused', error: `Recovery ${changed ? 'may be partially complete; inspect its status before another action' : 'was refused'}: ${error instanceof Error ? error.message : String(error)}` }
    } finally { approval?.cancel(); this.pending.delete(id) }
  }

  async inspect(id: string, owner: AccountOwner): Promise<WorktreeRecoveryInspection> {
    if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
    let row: WorktreeRemovalRecord
    try { row = this.row(id) } catch (error) { return { ok: false, error: String(error) } }
    let status: 'kept' | 'missing' | 'changed' | 'unavailable' = 'unavailable'
    try { await this.verifyKept(row); status = 'kept' }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      try { status = this.directoryMissing(row) ? 'missing' : code ? 'unavailable' : 'changed' }
      catch { status = 'unavailable' }
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
