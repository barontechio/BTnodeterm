import path from 'node:path'
import { carryLocalNodeExec } from '../shared/node-exec'
import type { CanvasMutation, CanvasNodeState, Project, Workspace } from '../shared/types'
import { CanvasExecutionReservations, canvasExecutionBinding } from './canvas-execution-reservations'
import { setCanvasMutationObserver, setClientMutationAdmission, type ClientMutationRejection } from './canvas-sync'
import { worktreeRecoveryAdmission } from './worktree-recovery-admission'
import type { WorktreeRemovalJournal } from './worktree-removal-journal'
import type { WorkspaceExecutionAdmission, WorkspaceStore } from './workspace-store'

type Source = Pick<WorkspaceStore, 'projectExecutionLocation' | 'projectIdsForNode' | 'getNodeForHostAction' | 'getProjectNodesForHostAction'>
type ProjectLocation = NonNullable<ReturnType<Source['projectExecutionLocation']>>
type Facts = Pick<WorktreeRemovalJournal, 'needsAdmission' | 'reservedPaths'>

// Closing a tab or moving storage is not a new filesystem reference. Account/session/held-launch
// changes do matter: they must not re-arm an unchanged path awaiting recovery.
function referenceBinding(project: ProjectLocation, node: CanvasNodeState): string {
  return canvasExecutionBinding({ id: project.id, cwd: project.cwd, ssh: project.ssh }, node)
}

/** Admission for new execution references, separate from the in-process node metadata fence.
 * Historical recovery rows do not pin their old members forever: layout edits, closing a tab,
 * deleting a node and repairing it to a safe location remain possible after restart.
 */
export class WorktreeCanvasAdmission implements WorkspaceExecutionAdmission {
  readonly reservations: CanvasExecutionReservations
  private readonly admitDirectory: (directory: string) => void
  constructor(private readonly source: Source, private readonly journal: Facts) {
    this.reservations = new CanvasExecutionReservations({
      project: (id) => source.projectExecutionLocation(id), node: (projectId, id) => this.currentNode(projectId, id)
    })
    this.admitDirectory = worktreeRecoveryAdmission(journal)
  }
  private currentNode(projectId: string, nodeId: string): CanvasNodeState | undefined {
    const projects = this.source.projectIdsForNode(nodeId)
    return projects.length === 1 && projects[0] === projectId ? this.source.getNodeForHostAction(nodeId) : undefined
  }
  active(): boolean { return this.reservations.active() || this.journal.needsAdmission() }
  assertCurrent(): void { this.reservations.assertCurrent() }
  assertStorageChange(projectId: string): void {
    this.reservations.assertStorageChange(projectId)
    if (!this.journal.needsAdmission()) return
    const project = this.source.projectExecutionLocation(projectId)
    if (project?.cwd && !project.ssh && !project.remote) this.admitDirectory(project.cwd)
  }
  private assertReferences(project: ProjectLocation, node: CanvasNodeState,
    lookup: (id: string) => CanvasNodeState | undefined): void {
    if (project.ssh || project.remote || node.ssh) return
    if (node.sshRemoteTmux || node.sshFs) throw new Error('worktree-recovery-directory-unverifiable: remote route is incomplete')
    const missingFile = (node.kind === 'editor' || node.kind === 'diff') && node.fileMissing === true
    const references = new Set([missingFile ? undefined : node.cwd,
      node.worktree?.path, node.worktree?.repoPath, node.runConfig?.projectDir])
    if (!missingFile && node.filePath) {
      const base = node.kind === 'diff' ? node.cwd ?? project.cwd : project.cwd
      if (!path.isAbsolute(node.filePath) && (!base || !path.isAbsolute(base)))
        throw new Error('worktree-recovery-directory-unverifiable: relative file without a local root')
      references.add(path.resolve(base ?? path.parse(node.filePath).root, node.filePath))
    }
    if (node.kind === 'terminal' || node.kind === 'group') {
      references.add(project.cwd)
      let parentId = node.parentId; const seen = new Set([node.id])
      for (let depth = 0; parentId; depth++) {
        if (depth >= 128 || seen.has(parentId)) throw new Error('worktree-recovery-directory-unverifiable: invalid group ancestry')
        seen.add(parentId)
        const parent = lookup(parentId)
        if (!parent) throw new Error('worktree-recovery-directory-unverifiable: missing group')
        references.add(parent.worktree?.path); references.add(parent.cwd)
        parentId = parent.parentId
      }
    }
    for (const reference of references) {
      if (!reference) continue
      if (!path.isAbsolute(reference) && (!project.cwd || !path.isAbsolute(project.cwd)))
        throw new Error('worktree-recovery-directory-unverifiable: relative path without a local project root')
      this.admitDirectory(path.resolve(project.cwd ?? path.parse(reference).root, reference))
    }
  }
  private assertNode(project: ProjectLocation, node: CanvasNodeState,
    lookup: (id: string) => CanvasNodeState | undefined,
    prior?: { project: ProjectLocation | undefined; node: CanvasNodeState | undefined }): void {
    const beforeProject = prior ? prior.project : this.source.projectExecutionLocation(project.id)
    const before = prior ? prior.node : this.currentNode(project.id, node.id)
    if (beforeProject && before && referenceBinding(beforeProject, before) === referenceBinding(project, node)) return
    this.assertReferences(project, node, lookup)
  }
  assertProject(project: Project): void {
    this.reservations.assertProject(project)
    if (!this.journal.needsAdmission()) return
    const previous = this.source.projectExecutionLocation(project.id)
    if (project.cwd && !project.ssh && !project.remote &&
      (!previous || previous.cwd !== project.cwd || previous.ssh || previous.remote)) this.admitDirectory(project.cwd)
    const nodes = new Map(project.nodes.map((node) => [node.id, node]))
    const before = new Map<string, CanvasNodeState | undefined>()
    for (const node of this.source.getProjectNodesForHostAction(project.id) ?? []) {
      const placements = this.source.projectIdsForNode(node.id)
      before.set(node.id, !before.has(node.id) && placements.length === 1 && placements[0] === project.id ? node : undefined)
    }
    for (const node of project.nodes) this.assertNode(project, node, (id) => nodes.get(id), { project: previous, node: before.get(node.id) })
  }
  assertWorkspace(workspace: Workspace): void {
    this.reservations.assertWorkspace(workspace)
    if (this.journal.needsAdmission()) for (const project of workspace.projects) this.assertProject(project)
  }
  inspectClient(projectId: string, mutation: CanvasMutation, fromOwner: boolean): ClientMutationRejection | null {
    const reserved = this.reservations.inspectClient(projectId, mutation, fromOwner)
    if (reserved || mutation.op !== 'upsert' || !this.journal.needsAdmission()) return reserved
    const previous = this.currentNode(projectId, mutation.node.id)
    try {
      const project = this.source.projectExecutionLocation(projectId)
      if (!project) throw new Error('worktree-recovery-project-unavailable')
      this.assertNode(project, carryLocalNodeExec(previous, mutation.node, fromOwner), (id) => this.currentNode(projectId, id))
      return null
    } catch {
      // The incoming visual fields are safe even when its new execution binding is refused.
      // Preserve its latest layout intent rather than restoring an older durable position.
      const canonical: CanvasMutation = previous ? { op: 'upsert', node: { ...structuredClone(previous),
        position: structuredClone(mutation.node.position), size: structuredClone(mutation.node.size),
        title: mutation.node.title, color: mutation.node.color } } : { op: 'remove', id: mutation.node.id }
      return { reason: 'Worktree recovery is pending. This execution change was refused; inspect recovery before retrying.', canonical }
    }
  }
}

/** Called only by the core that owns the recovery journal, before owner launches are available. */
export function installWorktreeCanvasAdmission(workspace: WorkspaceStore, journal: WorktreeRemovalJournal): WorktreeCanvasAdmission {
  const admission = new WorktreeCanvasAdmission(workspace, journal)
  workspace.setExecutionAdmission(admission)
  setClientMutationAdmission((projectId, mutation, owner) => admission.inspectClient(projectId, mutation, owner))
  setCanvasMutationObserver((projectId, mutation, trusted) => admission.reservations.onReflected(projectId, mutation, trusted))
  return admission
}
