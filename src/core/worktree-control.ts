import path from 'node:path'
import { createBoundWorktree } from '../shared/worktree-create'
import { dryRunRequested } from '../shared/control-verbs'
import { placeBelowSource } from '../shared/placement'
import {
  effectiveWorktreeBaseRef, effectiveWorktreeTemplate, resolveWorktreeBase,
  resolveWorktreePath, sanitizeWorktreeBranch, worktreePathKey, WORKTREE_GROUP_SIZE
} from '../shared/worktree'
import { sharedBasePathOf, sharedWorktreeLocationRefusal } from '../shared/worktree-location'
import type { CanvasNodeState, Project, Settings, Workspace } from '../shared/types'
import type { ProjectLaunchInfo } from '../shared/project-settings'
import type { CanvasContentWriter } from './canvas-content-writer'
import type { GitService } from './git-service'
import type { ServerControlReply } from './headless-node-factory'

export interface WorktreeControlBackend {
  git: Pick<GitService, 'repoRoot' | 'worktreeList' | 'worktreeAdd'>
  projectLaunchInfo?(projectId: string): Promise<ProjectLaunchInfo | null>
  /** Validated materialization followed by successful, trust-gated setup before binding. */
  prepare(projectId: string, worktreePath: string): Promise<void>
}

export interface WorktreeControlContext {
  writer: CanvasContentWriter
  settings(): Settings
  actor(workspace: Workspace): { project: Project; node: CanvasNodeState } | null
  permitted(workspace: Workspace, project: Project, nodeId: string): boolean
  record(groupId: string, projectId: string): void
  publish(projectId: string): Promise<void>
  stopped(): boolean
  newGroupId(): string
}

const refusal = (error: string): ServerControlReply => ({ ok: false, error })
const key = worktreePathKey

/** A command is serialized by its caller; short canvas edits use the workspace queue. */
export async function worktreeControl(
  verb: 'open-worktree' | 'close-worktree', args: Record<string, string>,
  backend: WorktreeControlBackend, context: WorktreeControlContext
): Promise<ServerControlReply> {
  const initial = context.actor(await context.writer.readWorkspace())
  if (!initial) return refusal(`${verb}-source-refused: requires one available local project and a control-capable source`)
  const projectId = initial.project.id
  const cwd = initial.project.cwd
  if (!cwd || !path.isAbsolute(cwd)) return refusal(`${verb}-repository-unavailable: the project needs an absolute local folder`)
  const current = (workspace: Workspace) => {
    if (context.stopped()) throw new Error('control stopped')
    const actor = context.actor(workspace)
    if (!actor || actor.project.id !== projectId || actor.project.cwd !== cwd) throw new Error('source project changed')
    return actor
  }
  const groupFor = (workspace: Workspace, project: Project, bound: boolean) => {
    const matches = project.nodes.filter((n) => n.id === args.group)
    const group = matches.length === 1 ? matches[0] : undefined
    if (!group || group.kind !== 'group' || !!group.worktree !== bound ||
      !context.permitted(workspace, project, group.id)) throw new Error('group is unavailable or outside the caller scope')
    return group
  }
  if (verb === 'close-worktree') {
    if ((args.mode ?? 'unbind') !== 'unbind') return refusal('close-worktree-confirmation-required: directory removal requires the owner confirmation service')
    let directory = ''
    let editing = false
    try {
      const loaded = await context.writer.readWorkspace()
      const bound = groupFor(loaded, current(loaded).project, true).worktree!
      const repoRoot = await backend.git.repoRoot(cwd)
      if (!repoRoot || key(repoRoot) !== key(bound.repoPath)) return refusal('close-worktree-repository-refused: binding belongs to another repository')
      const listed = await backend.git.worktreeList(repoRoot)
      if (!listed.ok || !listed.entries.some((e) => !e.prunable && key(e.path) === key(bound.path))) {
        return refusal('close-worktree-recovery-required: checkout is missing or unreadable; recover its descendant sessions before dropping the binding')
      }
      const edited = await context.writer.edit((workspace) => {
        const { project } = current(workspace)
        const group = groupFor(workspace, project, true)
        if (JSON.stringify(group.worktree) !== JSON.stringify(bound)) throw new Error('binding changed')
        directory = group.worktree!.path
        // Unbind is metadata-only. A missing checkout needs explicit cwd/session recovery first.
        // Never silently recycle running descendants as a side effect of this command.
        editing = true
        delete group.worktree
        return group.id
      })
      if (!edited.saved) return refusal('close-worktree-not-saved: inspect the binding before retrying')
      await context.publish(projectId)
      return { ok: true, message: `unbound worktree from ${edited.value} (directory kept on disk)`, result: { groupId: edited.value, path: directory } }
    } catch (error) { return refusal(`close-worktree-${editing ? 'save-uncertain: inspect the binding before retrying' : 'refused'}: ${String(error)}`) }
  }

  const branch = sanitizeWorktreeBranch(args.branch ?? '')
  if (!branch) return refusal('open-worktree: invalid branch name')
  const repo = await backend.git.repoRoot(cwd)
  if (!repo) return refusal('open-worktree: repository root could not be read')
  const listed = await backend.git.worktreeList(repo)
  if (!listed.ok || !listed.entries.length) return refusal('open-worktree: worktree list could not be read')
  const firstWorkspace = await context.writer.readWorkspace()
  const { project } = current(firstWorkspace)
  if (args.group) groupFor(firstWorkspace, project, false)
  if (args.base && project.nodes.some((n) => n.id === args.base) && !context.permitted(firstWorkspace, project, args.base)) {
    return refusal('open-worktree: base station is outside the caller scope')
  }
  const base = resolveWorktreeBase(args.base, branch, project.nodes)
  if (base.kind === 'error') return refusal(`open-worktree: ${base.error}`)
  const info = await backend.projectLaunchInfo?.(projectId)
  const worktree = info?.resolved.worktree
  const defaults = { basePath: worktree?.basePath?.value, baseRef: worktree?.baseRef?.value }
  const baseRef = base.kind === 'default' ? effectiveWorktreeBaseRef(defaults, listed.entries) : base.ref
  const derived = await resolveWorktreePath({ explicitPath: args.path, repoRoot: repo, branch,
    template: effectiveWorktreeTemplate(defaults, context.settings().worktreePathTemplate) })
  if (!derived) return refusal('open-worktree: could not derive a worktree path — pass --path')
  const directory = path.resolve(repo, derived)
  const locationRefusal = sharedWorktreeLocationRefusal({ path: directory, repoRoot: repo, branch,
    sharedBasePath: args.path?.trim() ? undefined : sharedBasePathOf(worktree) })
  if (locationRefusal) return refusal(`open-worktree: ${locationRefusal}`)
  const assertUnclaimed = (workspace: Workspace) => {
    if (workspace.projects.some((p) => !p.ssh && p.nodes.some((n) => n.worktree && key(n.worktree.path) === key(directory)))) {
      throw new Error('worktree directory already has a canvas binding')
    }
  }
  assertUnclaimed(firstWorkspace)
  if (listed.entries.some((e) => key(e.path) === key(directory) || e.branch === branch)) return refusal('open-worktree: directory or branch is already checked out')
  const result = { branch, path: directory, baseRef, ...(base.kind === 'station' ? { baseStation: base.stationId } : {}) }
  if (dryRunRequested(args)) return { ok: true, message: `Dry run: would create ${branch} off ${baseRef} at ${directory}. Base ref is checked by Git at create time.`, result: { ...result, dryRun: true, group: args.group ?? null } }
  // Flush queued owner saves before Git starts, then revalidate again when binding its result.
  await context.writer.edit((workspace) => {
    const { project } = current(workspace)
    if (args.group) groupFor(workspace, project, false)
    assertUnclaimed(workspace)
  })
  const groupId = args.group || context.newGroupId()
  const created = await createBoundWorktree({
    worktreeAdd: (...params) => backend.git.worktreeAdd(...params), activeProjectId: () => projectId,
    beforeAttach: async (wt) => {
      await context.writer.edit((workspace) => { current(workspace); assertUnclaimed(workspace) })
      await backend.prepare(projectId, wt.path)
    },
    attach: async (_target, binding) => {
      const saved = await context.writer.edit((workspace) => {
        const { project } = current(workspace)
        assertUnclaimed(workspace)
        if (args.group) groupFor(workspace, project, false).worktree = binding
        else {
          if (workspace.projects.some((p) => p.nodes.some((n) => n.id === groupId))) throw new Error('group id collision')
          const position = placeBelowSource(project.nodes, initial.node.id,
            { w: WORKTREE_GROUP_SIZE.width, h: WORKTREE_GROUP_SIZE.height },
            { snapGrid: context.settings().snapToGrid ? context.settings().gridSize : 0 })
          if (!position) throw new Error('source placement unavailable')
          project.nodes.unshift({ id: groupId, kind: 'group', title: branch, color: '#8b8b8b', group: null,
            position, size: { ...WORKTREE_GROUP_SIZE }, worktree: binding, openedBy: initial.node.id })
        }
      })
      if (!saved.saved) throw new Error('binding was not saved')
      return groupId
    }
  }, { repoPath: repo, mode: 'new', branch, baseRef, path: directory }, { target: () => ({ groupId: args.group ?? null }) })
  if (!created.ok) return { ok: false, error: created.reason === 'git' ? `open-worktree: ${created.message}${created.rejected ? '; outcome uncertain — inspect git worktree list before retrying' : ''}` :
    `open-worktree-binding-uncertain: checkout exists at ${directory}; inspect list and recover it instead of recreating it`, result: { ...result, ...(created.reason !== 'git' ? { worktree: created.worktree, detail: created.reason === 'binding' ? created.message : 'project changed' } : {}) } }
  context.record(groupId, projectId)
  try { await context.publish(projectId) } catch (error) {
    return { ok: false, error: `open-worktree-publication-uncertain: binding was saved; inspect list before retrying: ${String(error)}`, result: { ...result, groupId } }
  }
  return { ok: true, message: `opened worktree ${branch} (off ${baseRef}) at ${directory} in group ${groupId}`, result: { ...result, groupId } }
}
