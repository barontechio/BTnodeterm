import { IPC } from '../shared/ipc'
import { resolveProjectSettings, type ProjectSettingsSnapshot } from '../shared/project-settings'
import type { WorktreeListResult } from '../shared/worktree'
import type { CorePlatform } from './platform'
import { resolveProjectSetupTarget, type ProjectSetupTargetInfo } from './project-setup-runner-local'
import { materializeSharedPaths, type SharedPathResult } from './worktree-shared-paths'

/**
 * RPC surface for `worktree:materialize-shared`, registered once per shell (Electron main + Server
 * Edition) through CorePlatform — the `project-setup-handlers.ts` / `project-launch-info-handlers.ts`
 * sibling-registrar shape.
 *
 * The wire carries ONLY `(projectId, worktreePath)`. It NEVER carries the `sharedPaths` list: a
 * renderer-supplied list of relative paths is untrusted input (it could name anything, and would
 * also let a compromised renderer materialize links a project never opted into). The handler reads
 * the list ITSELF, by projectId, out of the project's resolved settings
 * (`readSettings` → `resolveProjectSettings` → `worktree.sharedPaths`).
 *
 * The trust boundary is the SAME one the setup runner uses (`resolveProjectSetupTarget`): rootPath
 * (= the project's `cwd`) is derived from THIS process's own workspace index by projectId, never the
 * caller, and `worktreePath` is independently validated to be either that rootPath or one of the
 * project's ACTUAL git worktrees — else the call is refused with `[]`. An SSH project is refused the
 * same way (materialization is local-only this PR; `resolveProjectSetupTarget` already rejects an
 * ssh target that carries a worktreePath, and we re-check `target.ssh` here as defense in depth).
 * Every refusal — unknown project, bad worktreePath, ssh, non-string args, no configured
 * sharedPaths — answers `[]`, the same shape a real "nothing was linked" answer uses, so a caller
 * needs no extra branch.
 */
export interface WorktreeSharedPathsDeps {
  /** This shell's own settings resolution (e.g. `WorkspaceStore.readProjectSettings`). */
  readSettings(projectId: string): Promise<ProjectSettingsSnapshot | null>
  /** This shell's own workspace index lookup (e.g. `WorkspaceStore.projectTargetInfo`). */
  targetInfo(projectId: string): ProjectSetupTargetInfo | null
  /** `git worktree list` for a repo root (e.g. `GitService#worktreeList` bound to the caller). */
  worktreeList(repoPath: string): Promise<WorktreeListResult>
}

export function registerWorktreeSharedPathsHandlers(
  platform: CorePlatform,
  deps: WorktreeSharedPathsDeps
): void {
  platform.handle(
    IPC.worktreeMaterializeShared,
    async (projectId: unknown, worktreePath: unknown): Promise<SharedPathResult[]> => {
      return materializeProjectSharedPaths(deps, projectId, worktreePath)
    }
  )
}

/** The same validated operation for host lifecycle services and RPC callers. */
export async function materializeProjectSharedPaths(
  deps: WorktreeSharedPathsDeps, projectId: unknown, worktreePath: unknown
): Promise<SharedPathResult[]> {
  if (typeof projectId !== 'string' || !projectId) return []
  if (typeof worktreePath !== 'string' || !worktreePath) return []

  // Same derivation + validation the setup runner performs: rootPath/ssh come from THIS
  // process's index by projectId, and `worktreePath` must be the project's rootPath or one of
  // its actual worktrees. A null target = unknown project / no local folder / refused ssh path.
  const info = deps.targetInfo(projectId)
  const target = await resolveProjectSetupTarget(projectId, worktreePath, info, deps.worktreeList)
  if (!target || target.ssh || !target.worktreePath) return []

  // Read the sharedPaths list ITSELF by projectId — never a value off the wire.
  const snap = await deps.readSettings(projectId)
  const resolved = resolveProjectSettings(snap?.local, snap?.shared ?? undefined)
  const sharedPaths = resolved.worktree.sharedPaths?.value ?? []
  if (sharedPaths.length === 0) return []

  // repoRoot = the project's own cwd (target.rootPath); target.worktreePath is the validated,
  // absolute worktree directory. materializeSharedPaths never throws.
  return materializeSharedPaths(target.rootPath, target.worktreePath, sharedPaths)
}
