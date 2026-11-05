import { resolveProjectSetupTarget } from './project-setup-runner-local'
import { materializeProjectSharedPaths } from './worktree-shared-paths-handlers'
import type { ProjectSetupService } from './project-setup-service'
import type { WorkspaceStore } from './workspace-store'
import type { WorktreeControlBackend } from './worktree-control'

/** Shell-independent preparation. Never trusts a caller's root, script or shared-path list. */
export function makeWorktreeControlBackend(
  workspace: WorkspaceStore, git: WorktreeControlBackend['git'], setup: Pick<ProjectSetupService, 'runAndWait'>,
  projectLaunchInfo: WorktreeControlBackend['projectLaunchInfo']
): WorktreeControlBackend {
  const paths = { readSettings: (id: string) => workspace.readProjectSettings(id),
    targetInfo: (id: string) => workspace.projectTargetInfo(id),
    worktreeList: (repo: string) => git.worktreeList(repo) }
  return { git, projectLaunchInfo, prepare: async (projectId, directory) => {
    const target = await resolveProjectSetupTarget(projectId, directory, paths.targetInfo(projectId), paths.worktreeList)
    if (!target || target.ssh) throw new Error('worktree no longer belongs to this local project')
    const materialized = await materializeProjectSharedPaths(paths, projectId, directory)
    const errors = materialized.filter((r) => r.status === 'error' || r.status === 'skipped-unsafe')
    if (errors.length) throw new Error(`shared paths could not be prepared: ${errors.map((r) => r.path).join(', ')}`)
    if (!(await setup.runAndWait(target, 'setup'))) throw new Error('setup was declined, unavailable or did not finish successfully; checkout remains on disk')
  } }
}
