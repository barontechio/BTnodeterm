import fs from 'node:fs'
import os from 'node:os'
import { platform } from './platform'
import { appDataProjectRoot } from './workspace-store'
import { projectSettingsPath } from './project-settings-files'
import { parseProjectSettingsFile } from '../shared/project-settings'
import { manualFileStamp } from './worktree-manual-shell'
import { manualCreateBinding, manualProcessBirth } from './worktree-manual-shell'
import { localNodePtyOptions, HEADLESS_COLS, HEADLESS_ROWS } from '../shared/node-pty-options'
import type { WorktreeRecoveryResumeReply } from '../shared/worktree-recovery'
import type { WorktreeManualResume } from './worktree-removal-journal'
import { randomUUID } from 'node:crypto'
import { readRegularFileNoFollow } from './read-regular-file'
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
import { descendantIds, isAncestorPath, isRemoteSessionNode, isValidGitRef } from '../shared/worktree'
import { worktreeRecoveryAdmission } from './worktree-recovery-admission'
import { isSafeNodeId } from '../shared/safe-id'
import type { WorktreeRecoveryInspection, WorktreeRecoveryItem, WorktreeRecoveryKeepReply, WorktreeRecoveryList, WorktreeRecoveryRepairReply, WorktreeMissingList, WorktreeRecoveryRebindReply } from '../shared/worktree-recovery'
import type { AccountOwner } from './owner-lifetimes'
import type { PtyManager } from './pty-manager'
import type { GitService } from './git-service'
import { withGitRemoteResolver } from './remote-ssh/remote-git'
import type { WorktreeRemovalJournal, WorktreeRemovalRecord, WorktreeRebindPlan } from './worktree-removal-journal'

interface Dependencies {
  journal: WorktreeRemovalJournal
  pty: Pick<PtyManager, 'runWorktreeAction'> & Partial<Pick<PtyManager, 'recycleWorktreeMember' | 'nodeExecutionIdentity' |
    'runNodeActions' | 'prepareManualShell' | 'createManualShell' | 'publishManualShellReady' | 'prepareWorktreeRemoval'>>
  git: Pick<GitService, 'worktreeList'> & Partial<Pick<GitService, 'worktreeRecoveryDirectories' | 'worktreeRemoveClean'>>
  repair?: { workspace: WorkspaceStore; admission: WorktreeCanvasAdmission; dispatch: WorktreeRecoveryDispatch; confirmations: Pick<OwnerConfirmationBroker, 'request'> }
}
const item = (row: WorktreeRemovalRecord): WorktreeRecoveryItem => ({ id: row.id, createdAt: row.createdAt,
  phase: row.phase, pathRestricted: row.rebind?.state !== 'bound', provenance: row.provenance.kind, projectId: row.projectId, groupId: row.groupId, repoPath: row.repoPath,
  path: row.worktreePath, branch: row.branch, fallbackCwd: row.fallbackCwd, memberIds: row.members.map((member) => member.nodeId), ...(row.repair?.manualStart.length ? { manualStartIds: row.repair.manualStart } : {}) })
const refused = (error: string): WorktreeRecoveryKeepReply => ({ ok: false, outcome: 'refused', error })

/** Owner recovery without Git mutation or command replay. Keeping requires the original inode
 * and linked branch; missing recovery requires absence, acknowledged teardown and durable repair.
 * Observation before any record never invents prior directory or Git-dispatch evidence.
 */
export class WorktreeRecoveryService {
  private pending = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  private publicItem(row: WorktreeRemovalRecord): WorktreeRecoveryItem {
    return { ...item(row), manualActiveIds: row.repair?.manualStart.filter((id) => this.deps.repair?.dispatch.manualSessionActive(id)) ?? [] }
  }

  list(owner: AccountOwner): WorktreeRecoveryList {
    if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
    try { return { ok: true, records: this.deps.journal.list().map((row) => this.publicItem(row)) } }
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

  private repairSnapshot(workspace: Workspace, row: WorktreeRemovalRecord, rebinding = false): { projectId: string; nodes: CanvasNodeState[] } {
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
      const accepted = rebinding ? [row.repair?.members, row.rebind?.members, row.rebind?.staged]
        : [row.members, row.repair?.members, row.repair?.staged]
      if (!accepted.some((members) => members?.find((entry) => entry.nodeId === node.id)?.binding === binding))
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

  async discoverRemoval(owner: AccountOwner): Promise<WorktreeMissingList> {
    if (!owner.active() || !this.deps.repair || !this.deps.pty.prepareWorktreeRemoval || !this.deps.git.worktreeRemoveClean)
      return { ok: false, error: 'worktree-removal-unavailable' }
    try {
      const workspace = await this.deps.repair.workspace.load({ sideline: false })
      const records = this.deps.journal.list()
      const candidates = workspace.projects.filter((p) => !p.remote && !p.ssh && !p.handedOffTo && !p.unavailable)
        .flatMap((p) => p.nodes.filter((n) => n.kind === 'group' && n.worktree?.createdByApp &&
          !records.some((r) => isAncestorPath(r.worktreePath, n.worktree!.path) || isAncestorPath(n.worktree!.path, r.worktreePath)))
          .map((n) => ({ groupId: n.id, projectId: p.id, branch: n.worktree!.branch, path: n.worktree!.path }))).slice(0, 128)
      if (!owner.active()) return { ok: false, error: 'worktree-recovery-owner-required' }
      return { ok: true, candidates }
    } catch { return { ok: false, error: 'worktree-removal-discovery-unavailable' } }
  }

  /** Additive owner-only clean removal. The legacy Desktop dirty/force workflow is separate. */
  async removeClean(groupId: string, owner: AccountOwner): Promise<WorktreeRecoveryRepairReply> {
    const domain = this.deps.repair
    if (!owner.active() || !domain || !this.deps.pty.prepareWorktreeRemoval || !this.deps.pty.recycleWorktreeMember ||
      !this.deps.git.worktreeRemoveClean) return { ok: false, outcome: 'refused', error: 'worktree-removal-unavailable' }
    if (!isSafeNodeId(groupId) || this.pending.has(groupId) || this.pending.size >= 32)
      return { ok: false, outcome: 'refused', error: 'worktree-removal-busy-or-invalid' }
    this.pending.add(groupId)
    let changed = false; let consumed = false; let approval: Extract<OwnerPermit, { ok: true }> | undefined
    try {
      const workspace = structuredClone(await domain.workspace.load({ sideline: false }))
      const hits = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === groupId).map((node) => ({ project, node })))
      if (hits.length !== 1 || hits[0].node.kind !== 'group' || !hits[0].node.worktree?.createdByApp)
        throw new Error('worktree-removal-app-created-group-required')
      const { project, node: group } = hits[0]; const binding = group.worktree!
      if (this.deps.journal.list().some((row) => isAncestorPath(row.worktreePath, binding.path) || isAncestorPath(binding.path, row.worktreePath)))
        throw new Error('worktree-removal-history-overlap')
      const protect = () => {
        const roots = [binding.repoPath, os.homedir(), platform().userDataDir, process.cwd(), process.execPath,
          path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 'unknown'}`),
          ...['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMUX_TMPDIR']
            .map((key) => process.env[key]).filter((value): value is string => !!value)]
        if (path.parse(binding.path).root === binding.path) throw new Error('worktree-removal-protected-root')
        const admit = worktreeRecoveryAdmission({ reservedPaths: () => [binding.path] })
        for (const root of roots) {
          try { admit(root) } catch { throw new Error('worktree-removal-protected-root') }
        }
      }
      protect()
      const stat = fs.lstatSync(binding.path, { bigint: true })
      const ids = new Set([groupId, ...descendantIds(project.nodes, groupId)])
      if (ids.size > 32) throw new Error('worktree-removal-member-capacity')
      let row: WorktreeRemovalRecord = { id: randomUUID(), createdAt: Date.now(), phase: 'prepared', provenance: { kind: 'recorded-directory' },
        projectId: project.id, groupId, repoPath: binding.repoPath, worktreePath: binding.path, branch: binding.branch,
        fallbackCwd: binding.repoPath, directoryStamp: `${stat.dev}:${stat.ino}`,
        members: project.nodes.filter((node) => ids.has(node.id)).map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project, node) })) }
      const captured = this.repairSnapshot(workspace, row)
      const terminals = captured.nodes.filter((node) => node.kind === 'terminal').map((node) => node.id)
      await this.verifyKept(row)
      const repoEvidence = captureWorktreeGitEvidence(row.repoPath)
      const checkoutEvidence = captureWorktreeGitEvidence(row.worktreePath)
      const settingsCurrent = domain.workspace.captureProjectSpawnSettings(project.id)
      // Pre-validate without the settings reader's corrupt-file sidelining behavior.
      const settingsRoot = project.storeInAppData ? appDataProjectRoot(project.id) : project.cwd
      if (settingsRoot) {
        const file = projectSettingsPath(settingsRoot)
        try {
          manualFileStamp(file)
          if (parseProjectSettingsFile(fs.readFileSync(file, 'utf8')).status !== 'ok') throw new Error('worktree-removal-settings-unverifiable')
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const settings = await domain.workspace.readProjectSettings(project.id); settingsCurrent()
      if (!settings || settings.conflict) throw new Error('worktree-removal-settings-unverifiable')
      if (settings.shared?.setup?.archiveScript || settings.local?.setup?.archiveScript)
        throw new Error('worktree-removal-archive-hook-unsupported')
      const physical = await this.deps.pty.prepareWorktreeRemoval(terminals, row.worktreePath)
      // Saved cold identities and live unpersisted identities cannot be inferred from a cwd hint.
      const saved = workspace.projects.flatMap((p) => p.nodes.filter((n) => n.kind === 'terminal').map((node) => ({ project: p, node })))
      if (saved.some(({ project: p, node }) => p.remote || p.ssh || p.handedOffTo || isRemoteSessionNode(node) || node.agentId || node.accountId || node.agentSessionId || !physical.nodeIds.includes(node.id)) ||
        physical.nodeIds.some((id) => saved.filter(({ node }) => node.id === id).length !== 1))
        throw new Error('worktree-removal-saved-runtime-unverifiable')
      const canvasSignature = () => JSON.stringify(domain.workspace.linkProjectEntries()?.map((entry) => {
        const location = domain.workspace.projectExecutionLocation(entry.id)
        const nodes = domain.workspace.getProjectNodesForHostAction(entry.id)
        if (!location || !nodes) throw new Error('worktree-removal-canvas-unavailable')
        return [location, nodes.map((node) => [node.id, canvasExecutionBinding(location, node)])]
      }))
      const originalCanvas = canvasSignature()
      let expectedJournal = JSON.stringify(this.deps.journal.list())
      const current = () => {
        try { settingsCurrent(); return owner.active() && (!consumed || approval?.current() === true) && JSON.stringify(this.deps.journal.list()) === expectedJournal }
        catch { return false }
      }
      const beforeGit = () => {
        if (!current() || canvasSignature() !== originalCanvas) throw new Error('worktree-removal-approval-changed')
        protect(); this.directoryIntact(row); physical.assertCurrent()
        assertWorktreeGitEvidence(row.repoPath, repoEvidence); assertWorktreeGitEvidence(row.worktreePath, checkoutEvidence)
      }
      beforeGit()
      const answer = await domain.confirmations.request({ action: 'remove-worktree',
        requester: { nodeId: groupId, projectId: project.id, title: binding.branch }, binding: { row, canvas: originalCanvas },
        message: `Remove the clean checkout ${binding.path}?`,
        details: 'Git runs without force and refuses ignored files. The branch is kept. After verified absence, supported terminals are closed and their saved nodes are repaired. Held commands and file contents are preserved; terminals require explicit manual start. This does not lock external processes or files.',
        confirmLabel: 'Remove clean checkout', danger: true,
        checkCurrent: async () => { try { beforeGit(); await this.verifyKept(row); await physical.revalidate(); beforeGit(); return true } catch { return false } }
      })
      if (!answer.ok) return { ok: false, outcome: 'refused', error: `Owner confirmation ${answer.reason}.` }
      approval = answer
      if (!(await answer.consume())) throw new Error('worktree-removal-approval-changed')
      consumed = true
      const writer = new CanvasContentWriter({ workspaceStore: domain.workspace })
      await this.deps.pty.runWorktreeAction(row.members.map((m) => m.nodeId), { owner, current, timeoutMs: 120_000 }, async (permit) => {
        const { value: hold } = await writer.edit((fresh) => {
          permit.assertCurrent(); beforeGit(); this.repairSnapshot(fresh, row)
          return domain.admission.reservations.hold(fresh, row.members.map((m) => m.nodeId), permit)
        })
        try {
          const assertPrepared = () => { permit.assertCurrent(); beforeGit() }
          assertPrepared()
          const { id: _id, createdAt: _created, phase: _phase, provenance: _origin, ...intent } = row
          changed = true // A lost first journal acknowledgement must retain possible effects.
          row = await this.deps.journal.prepare({ ...intent, directoryStamp: row.directoryStamp! }, assertPrepared)
          expectedJournal = JSON.stringify(this.deps.journal.list())
          assertPrepared()
          const result = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeRemoveClean!(row.repoPath, row.worktreePath, row.branch, false,
            { directoryStamp: row.directoryStamp!, assertCurrent: assertPrepared }))
          // Actual absence is factual evidence even when approval expired during Git. Never
          // interpret an inaccessible path, an unsuccessful list or an expired owner as absence.
          if (!this.directoryMissing(row)) throw new Error('worktree-removal-recovery-required')
          row = await this.deps.journal.markRemoved(row.id)
          expectedJournal = JSON.stringify(this.deps.journal.list())
          // A refused or uncertain Git reply never grants terminal teardown, even if an
          // independent observation can already durably record the missing path.
          if (!result.ok) throw new Error('worktree-removal-recovery-required')
          permit.assertCurrent()
          const candidate = structuredClone(await domain.workspace.load({ sideline: false }))
          const snapshot = this.repairSnapshot(candidate, row); const originals = structuredClone(snapshot.nodes)
          const freshProject = candidate.projects.find((p) => p.id === row.projectId)!
          this.repairNodes(snapshot.nodes, row, freshProject.cwd)
          const plan = { members: snapshot.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(freshProject, node) })),
            staged: snapshot.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(freshProject,
              carryLocalNodeExec(originals.find((old) => old.id === node.id), node, false)) })), manualStart: terminals }
          row = await this.deps.journal.planRepair(row.id, plan, permit.assertCurrent)
          expectedJournal = JSON.stringify(this.deps.journal.list())
          await domain.dispatch.withRecovery(permit, async () => {
            for (const id of terminals) {
              permit.assertCurrent()
              await this.deps.pty.recycleWorktreeMember!(id, permit, physical.targets.get(id)!)
            }
          })
          permit.assertCurrent()
          await writer.repairExecution(hold, (fresh) => {
            permit.assertCurrent()
            const repaired = this.repairSnapshot(fresh, row); const p = fresh.projects.find((p) => p.id === row.projectId)!
            this.repairNodes(repaired.nodes, row, p.cwd)
            if (repaired.nodes.some((node) => canvasExecutionBinding(p, node) !== plan.members.find((m) => m.nodeId === node.id)?.binding))
              throw new Error('worktree-removal-repair-changed')
          }, async (_fresh, assertDurable) => {
            const publish = () => { permit.assertCurrent(); assertDurable(); if (!this.directoryMissing(row)) throw new Error('worktree-removal-path-replaced') }
            publish(); row = await this.deps.journal.markRecovered(row.id, publish)
            expectedJournal = JSON.stringify(this.deps.journal.list())
          })
        } finally { hold.release() }
      })
      return { ok: true, outcome: 'recovered', message: 'Clean checkout removed; branch and saved nodes kept. Terminals require explicit manual start. No command was replayed.' }
    } catch (error) {
      const named = error instanceof Error && /^worktree-removal-[a-z-]+$/.test(error.message) ? error.message : 'worktree-removal-proof-unavailable'
      return { ok: false, outcome: changed ? 'uncertain' : 'refused', error: changed
        ? `${named}. Inspect recovery status; deletion is never retried automatically.` : named }
    } finally { approval?.cancel(); this.pending.delete(groupId) }
  }

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

  /** Adopt only the newly verified same-path/same-branch checkout. No terminal/Git mutation
   * and no manual admission release. All association evidence stays in the existing journal. */
  async rebind(id: string, owner: AccountOwner): Promise<WorktreeRecoveryRebindReply> {
    const refuse = (error: string): WorktreeRecoveryRebindReply => ({ ok: false, outcome: 'refused', error })
    const domain = this.deps.repair
    if (!owner.active() || !domain || !this.deps.pty.nodeExecutionIdentity || !this.deps.git.worktreeRecoveryDirectories)
      return refuse('Verified rebinding is unavailable for this owner or host.')
    if (this.pending.has(id) || this.pending.size >= 32) return refuse('Another recovery is still completing.')
    this.pending.add(id); let changed = false
    let approval: Extract<OwnerPermit, { ok: true }> | undefined
    try {
      let row = this.row(id)
      if (row.phase !== 'recovered' || !row.repair || row.rebind?.state === 'bound') return refuse('Complete recovery before reviewing a new association; this record may already be rebound.')
      const writer = new CanvasContentWriter({ workspaceStore: domain.workspace })
      const workspace = structuredClone(await domain.workspace.load({ sideline: false }))
      const before = this.repairSnapshot(workspace, row, true)
      const physical = new Map(before.nodes.filter((node) => node.kind === 'terminal').map((node) => [node.id, this.deps.pty.nodeExecutionIdentity!(node.id)]))
      const stat = fs.lstatSync(row.worktreePath, { bigint: true })
      const directoryStamp = row.rebind?.directoryStamp ?? `${stat.dev}:${stat.ino}`
      const repository = fs.lstatSync(row.repoPath, { bigint: true })
      const repoStamp = row.rebind?.repoStamp ?? `${repository.dev}:${repository.ino}`
      const gitEvidence = row.rebind?.git ?? captureWorktreeGitEvidence(row.repoPath, true)
      const targetGit = row.rebind?.targetGit ?? captureWorktreeGitEvidence(row.worktreePath, true)
      let expectedRecord = JSON.stringify(row)
      const assertTarget = () => {
        const current = fs.lstatSync(row.worktreePath, { bigint: true })
        const repo = fs.lstatSync(row.repoPath, { bigint: true })
        if (!repo.isDirectory() || !repo.ino || `${repo.dev}:${repo.ino}` !== repoStamp || !current.isDirectory() || !current.ino || fs.realpathSync.native(row.worktreePath) !== row.worktreePath ||
          fs.realpathSync.native(row.repoPath) !== row.repoPath || `${current.dev}:${current.ino}` !== directoryStamp)
          throw new Error('The approved new checkout identity changed.')
        fs.accessSync(row.worktreePath, fs.constants.R_OK | fs.constants.X_OK)
        assertWorktreeGitEvidence(row.repoPath, gitEvidence, true)
        assertWorktreeGitEvidence(row.worktreePath, targetGit, true)
      }
      assertTarget()
      const directories = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeRecoveryDirectories!(row.repoPath, assertTarget))
      if (!directories || directories.gitDirectory !== gitEvidence.gitDirectory || directories.commonDirectory !== gitEvidence.commonDirectory)
        return refuse('The actual Git route does not match the proposed association.')
      const targetDirectories = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeRecoveryDirectories!(row.worktreePath, assertTarget))
      const targetHead = await readRegularFileNoFollow(path.join(targetGit.gitDirectory, 'HEAD'), 4096)
      const targetBacklink = await readRegularFileNoFollow(path.join(targetGit.gitDirectory, 'gitdir'), 4096)
      assertTarget()
      if (!targetDirectories || targetDirectories.gitDirectory !== targetGit.gitDirectory || targetDirectories.commonDirectory !== gitEvidence.commonDirectory ||
        targetGit.commonDirectory !== gitEvidence.commonDirectory || targetHead?.trim() !== `ref: refs/heads/${row.branch}` ||
        targetBacklink?.trim() !== path.join(row.worktreePath, '.git'))
        return refuse('The new checkout marker, administrative backlink or branch does not match the proposed association.')
      const listing = await withGitRemoteResolver(() => undefined, () => this.deps.git.worktreeList(row.repoPath))
      assertTarget()
      const matches = listing.entries.filter((entry) => path.resolve(entry.path) === row.worktreePath)
      const baseRef = listing.entries[0]?.branch
      if (!listing.ok || matches.length !== 1 || matches[0] === listing.entries[0] || matches[0].isBare || matches[0].prunable ||
        matches[0].branch !== row.branch || !baseRef || !isValidGitRef(baseRef))
        return refuse('A healthy nonprimary linked checkout and a real merge-target branch are required.')
      const project = workspace.projects.find((entry) => entry.id === row.projectId)!
      const originals = structuredClone(before.nodes)
      const binding = { repoPath: row.repoPath, path: row.worktreePath, branch: row.branch, baseRef, createdByApp: false }
      const group = before.nodes.find((node) => node.id === row.groupId)!
      group.worktree = binding; group.cwd = row.worktreePath
      const plan: WorktreeRebindPlan = row.rebind ?? { state: 'prepared', directoryStamp, repoStamp, git: gitEvidence, targetGit, binding,
        members: before.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project, node) })),
        staged: before.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(project,
          carryLocalNodeExec(originals.find((old) => old.id === node.id), node, false)) })) }
      if (JSON.stringify(plan.binding) !== JSON.stringify(binding) || before.nodes.some((node) =>
        canvasExecutionBinding(project, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
        return refuse('The prepared association no longer matches the actual target.')
      const current = () => {
        try {
          assertTarget()
          return owner.active() && JSON.stringify(this.row(id)) === expectedRecord &&
            [...physical].every(([nodeId, identity]) => this.deps.pty.nodeExecutionIdentity!(nodeId) === identity)
        } catch { return false }
      }
      const answer = await domain.confirmations.request({ action: 'rebind-worktree',
        requester: { nodeId: row.groupId, projectId: row.projectId, title: row.branch }, binding: { record: expectedRecord, plan },
        message: `Associate the recovered group with ${row.branch} at ${row.worktreePath}?`,
        details: `The new merge target is ${baseRef}. Only the group association and its cwd change. Terminal cwd, missing file notices and held commands stay unchanged; terminals remain manually blocked. No session or Git mutation is performed.`,
        confirmLabel: 'Rebind verified checkout', danger: true,
        checkCurrent: async () => {
          if (!current()) return false
          this.repairSnapshot(await domain.workspace.load({ sideline: false }), row, true)
          return current()
        }
      })
      if (!answer.ok) return refuse(`Owner confirmation ${answer.reason}. No association was changed.`)
      approval = answer
      if (!(await answer.consume())) return refuse('The approved association changed or expired.')
      await this.deps.pty.runWorktreeAction(row.members.map((member) => member.nodeId), { owner, current: () => answer.current() && current(), timeoutMs: 120_000 }, async (permit) => {
        const { value: hold } = await writer.edit((fresh) => {
          permit.assertCurrent(); this.repairSnapshot(fresh, row, true)
          return domain.admission.reservations.hold(fresh, row.members.map((member) => member.nodeId), permit)
        })
        try {
          permit.assertCurrent()
          row = await this.deps.journal.prepareRebind(id, plan, permit.assertCurrent)
          expectedRecord = JSON.stringify(row); changed = true
          await domain.admission.withVerifiedRebind(permit, row, () => writer.repairExecution(hold, (fresh) => {
            permit.assertCurrent()
            const captured = this.repairSnapshot(fresh, row, true)
            const targetProject = fresh.projects.find((entry) => entry.id === row.projectId)!
            const target = captured.nodes.find((node) => node.id === row.groupId)!
            target.worktree = structuredClone(plan.binding); target.cwd = row.worktreePath
            if (captured.nodes.some((node) => canvasExecutionBinding(targetProject, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
              throw new Error('The conditional rebind projection changed.')
          }, async (durable, assertDurable) => {
            permit.assertCurrent(); assertDurable()
            const final = this.repairSnapshot(durable, row, true); const location = domain.workspace.projectExecutionLocation(row.projectId)!
            if (final.nodes.some((node) => canvasExecutionBinding(location, node) !== plan.members.find((member) => member.nodeId === node.id)?.binding))
              throw new Error('The new association was not acknowledged.')
            row = await this.deps.journal.markRebound(id, () => { permit.assertCurrent(); assertDurable() })
            expectedRecord = JSON.stringify(row)
          }))
        } finally { hold.release() }
      })
      return { ok: true, outcome: 'rebound', message: 'Verified checkout rebound. Terminal cwd and manual-start restrictions remain; no session was started or command replayed.' }
    } catch (error) {
      try { this.deps.journal.list() } catch { changed = true }
      return { ok: false, outcome: changed ? 'uncertain' : 'refused', error: `Rebinding ${changed ? 'may be partially complete; inspect its recorded state' : 'was refused'}: ${error instanceof Error ? error.message : String(error)}` }
    } finally { approval?.cancel(); this.pending.delete(id) }
  }

  /** Explicit owner start. Durable manualStart remains; only this actual Session can accept
   * ordinary input. A reconstructed host cannot turn recorded observations into authority. */
  async resume(id: string, nodeId: string, owner: AccountOwner): Promise<WorktreeRecoveryResumeReply> {
    const refuse = (error: string): WorktreeRecoveryResumeReply => ({ ok: false, outcome: 'refused', error })
    const domain = this.deps.repair; const pty = this.deps.pty
    if (!owner.active() || !domain || !pty.runNodeActions || !pty.prepareManualShell || !pty.createManualShell || !pty.nodeExecutionIdentity)
      return refuse('Verified manual shell creation is unavailable for this owner or host.')
    if (this.pending.has(id) || this.pending.size >= 32) return refuse('Another recovery is still completing.')
    this.pending.add(id)
    let approval: Extract<OwnerPermit, { ok: true }> | undefined
    let dispatched = false; let ready: object | undefined
    try {
      let row = this.row(id)
      if (row.phase !== 'recovered' || !row.repair?.manualStart.includes(nodeId)) return refuse('This terminal has no recovered manual-start plan.')
      if (domain.dispatch.manualSessionActive(nodeId)) return refuse('The verified shell is already running. Attach to that terminal.')
      const workspace = await domain.workspace.load({ sideline: false })
      const before = this.repairSnapshot(workspace, row, true)
      const project = workspace.projects.find((entry) => entry.id === row.projectId)!
      const node = before.nodes.find((entry) => entry.id === nodeId)
      if (!node || node.kind !== 'terminal' || node.agentModel) return refuse('A plain local terminal is required; agent runtime identities need a separate adapter.')
      const options = localNodePtyOptions(project, node, { cols: HEADLESS_COLS, rows: HEADLESS_ROWS })
      const profile = await pty.prepareManualShell(options)
      const cwd = profile.options.cwd!
      const stamp = () => {
        const stat = fs.lstatSync(cwd, { bigint: true })
        if (!stat.isDirectory() || !stat.ino || path.resolve(cwd) !== cwd || fs.realpathSync.native(cwd) !== cwd)
          throw new Error('The approved shell directory is unavailable or redirected.')
        fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK)
        worktreeRecoveryAdmission(this.deps.journal)(cwd)
        return `${stat.dev}:${stat.ino}`
      }
      const members = before.nodes.map((entry) => ({ nodeId: entry.id, binding: canvasExecutionBinding(project, entry) }))
      const latest = row.manualResume?.filter((entry) => entry.nodeId === nodeId).at(-1)
      const physical = new Map(before.nodes.filter((entry) => entry.kind === 'terminal').map((entry) => [entry.id, pty.nodeExecutionIdentity!(entry.id)]))
      let reconcile = false
      if (latest && (latest.state === 'dispatching' || latest.state === 'observed')) {
        if (physical.get(nodeId)) reconcile = true
        else if (latest.state === 'observed' && latest.evidence) {
          const ended = (pid: number, birth: string) => {
            try { return manualProcessBirth(pid) !== birth }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
          }
          const proof = latest.evidence
          if (proof.backend === 'plain' ? !ended(proof.pid, proof.birth) :
            !ended(proof.panePid, proof.paneBirth) || !ended(proof.clientPid, proof.clientBirth))
            return refuse('The previously observed process still exists without a verifiable host Session. Inspect it before another start.')
        } else return refuse('A previous creation has an uncertain outcome. Inspect the backend; it cannot be retried automatically.')
      } else if (physical.get(nodeId)) return refuse('An unverified live session already occupies this terminal.')
      const plan: WorktreeManualResume = { nodeId, nonce: reconcile || latest?.state === 'prepared' ? latest!.nonce : randomUUID(),
        state: 'prepared', cwd, directoryStamp: stamp(), profile: profile.fingerprint, options: manualCreateBinding(profile.options), members }
      if ((reconcile || latest?.state === 'prepared') && JSON.stringify({ ...latest, state: 'prepared', evidence: undefined, backendCreated: undefined }) !== JSON.stringify(plan))
        return refuse('The recorded start profile or saved identities changed. Preserve the previous attempt for explicit reconciliation.')
      let expectedRecord = JSON.stringify(row)
      const snapshot = (fresh: Workspace) => {
        const captured = this.repairSnapshot(fresh, row, true)
        const targetProject = fresh.projects.find((entry) => entry.id === row.projectId)!
        if (captured.nodes.some((entry) => canvasExecutionBinding(targetProject, entry) !== members.find((member) => member.nodeId === entry.id)?.binding))
          throw new Error('The approved saved execution identity changed.')
      }
      const current = () => {
        try { return owner.active() && stamp() === plan.directoryStamp && JSON.stringify(this.row(id)) === expectedRecord &&
          [...physical].every(([key, target]) => pty.nodeExecutionIdentity!(key) === target) }
        catch { return false }
      }
      const answer = await domain.confirmations.request({ action: 'resume-worktree-terminal',
        requester: { nodeId, projectId: row.projectId, title: node.title }, binding: { record: expectedRecord, plan },
        message: `Start the recovered terminal in ${cwd}?`,
        details: `Uses the verified local ${profile.backend} shell ${profile.options.shell}. Held launch commands stay manual and are not sent. Only this actual shell session receives input permission; another cold start needs confirmation.`,
        confirmLabel: reconcile ? 'Review existing shell' : 'Start shell', danger: true,
        checkCurrent: async () => {
          if (!current()) return false
          snapshot(await domain.workspace.load({ sideline: false }))
          const fresh = await pty.prepareManualShell!(options)
          return fresh.fingerprint === profile.fingerprint && current()
        }
      })
      if (!answer.ok) return refuse(`Owner confirmation ${answer.reason}. No shell was dispatched.`)
      approval = answer
      if (!(await answer.consume())) return refuse('The approved shell identity changed or expired.')
      const writer = new CanvasContentWriter({ workspaceStore: domain.workspace })
      await pty.runNodeActions(members.map((member) => member.nodeId), 'restart',
        { owner, current: () => answer.current() && current(), timeoutMs: 120_000 }, async (permit) => {
          const { value: hold } = await writer.edit((fresh) => {
            permit.assertCurrent(); snapshot(fresh)
            return domain.admission.reservations.hold(fresh, members.map((member) => member.nodeId), permit)
          })
          try {
            if (!reconcile) {
              row = await this.deps.journal.planManualResume(id, plan, permit.assertCurrent)
              expectedRecord = JSON.stringify(row)
            }
            await writer.repairExecution(hold, (fresh) => { permit.assertCurrent(); snapshot(fresh) }, async (_durable, assertDurable) => {
              let assertProfileCurrent = () => {}
              const assertCurrent = () => { permit.assertCurrent(); assertDurable(); assertProfileCurrent() }
              assertCurrent()
              if (!reconcile) {
                row = await this.deps.journal.markManualDispatch(id, plan.nonce, assertCurrent)
                expectedRecord = JSON.stringify(row)
              }
              await domain.dispatch.withManualCreate(permit, nodeId, plan.options, assertCurrent, async () => {
                const result = await pty.createManualShell!(profile, plan.nonce, permit, (target) => { physical.set(nodeId, target) })
                if (!result.ok) {
                  dispatched = result.dispatched || reconcile
                  if (result.backendCreated) {
                    row = await this.deps.journal.markManualBackendCreated(id, plan.nonce, result.backendCreated)
                    expectedRecord = JSON.stringify(row)
                  }
                  if (result.evidence) {
                    row = await this.deps.journal.markManualObserved(id, plan.nonce, result.evidence)
                    expectedRecord = JSON.stringify(row)
                  }
                  if (!dispatched) {
                    row = await this.deps.journal.markManualRefused(id, plan.nonce)
                    expectedRecord = JSON.stringify(row)
                  }
                  throw new Error(result.error)
                }
                dispatched = true
                // This synchronous original-profile fence remains in the final dispatch grant,
                // after journal awaits and backend identity probes. Established sessions keep
                // their separate physical-only current() check; later settings do not revoke them.
                assertProfileCurrent = result.assertProfileCurrent
                row = await this.deps.journal.markManualObserved(id, plan.nonce, result.evidence)
                expectedRecord = JSON.stringify(row)
                assertCurrent()
                domain.dispatch.admitManualSession(permit, nodeId, result.target, result.current)
                ready = result.target
              }, physical.get(nodeId))
            })
          } finally { hold.release() }
        })
      if (!owner.active()) throw new Error('The approving owner departed.')
      if (ready) pty.publishManualShellReady?.(nodeId, ready)
      return { ok: true, outcome: 'resumed', message: 'Verified local shell ready. Held commands were not replayed; future cold starts still require confirmation.' }
    } catch (error) {
      if (ready) domain.dispatch.revokeManualSession(nodeId, ready)
      try { this.deps.journal.list() } catch { dispatched = true }
      // Backend exceptions can contain argv, the private intent nonce, or /proc identities.
      // Expose only stable host error codes, never the raw diagnostic across IPC.
      const code = error instanceof Error ? error.message.match(/^(?:manual-shell|node-execution|durable-sync|canvas-execution|worktree-journal)-[a-z-]+(?=$|:)/)?.[0] : undefined
      return { ok: false, outcome: dispatched ? 'uncertain' : 'refused', error: `Manual shell ${dispatched ? 'may have started; inspect the recorded state before another action' : 'was refused'}: ${code ?? 'manual-shell-verification-failed'}` }
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
      return { ok: true, record: this.publicItem(row), status }
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
