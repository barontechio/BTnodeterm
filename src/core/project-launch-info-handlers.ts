import { IPC } from '../shared/ipc'
import {
  resolveProjectSettings,
  type ProjectLaunchInfo,
  type ProjectSettingsDoc
} from '../shared/project-settings'
import type { CorePlatform } from './platform'
import type { ProjectTrustStore } from './project-trust-store'
import { projectFamilyTrusted, projectTrustKeyFor } from './project-trust-verdict'
import type { WorkspaceStore } from './workspace-store'

export async function readProjectLaunchInfo(
  workspaceStore: Pick<WorkspaceStore, 'readProjectSettings' | 'projectTargetInfo'>,
  trustStore: ProjectTrustStore,
  projectId: unknown
): Promise<ProjectLaunchInfo | null> {
  if (typeof projectId !== 'string' || !projectId) return null
  const snap = await workspaceStore.readProjectSettings(projectId)
  if (!snap) return null
  const info = workspaceStore.projectTargetInfo(projectId)
  const sharedDoc: ProjectSettingsDoc = snap.shared ?? {}
  const resolved = resolveProjectSettings(snap.local, snap.shared ?? undefined)
  // The verdict itself lives in `project-trust-verdict.ts`, shared with the SPAWN's own reader
  // (`makeProjectSpawnOverrides`): a renderer told "trusted" here while the spawn silently
  // drops the same value would be a gate that reports one thing and enforces another.
  const key = projectTrustKeyFor(info)
  const trusted = {
    agents: await projectFamilyTrusted(trustStore, key, 'agents', sharedDoc),
    shell: await projectFamilyTrusted(trustStore, key, 'shell', sharedDoc)
  }
  return { resolved, trusted }
}

/**
 * `project-settings:launch-info` — the single read a launcher warms before it may consume a
 * shared-sourced value out of `resolveProjectSettings`'s answer (SDD: consumption plan, Task 1).
 *
 * A SIBLING `register*` (the `project-setup-handlers.ts` shape), not a widening of
 * `WorkspaceStore.registerIpc()`: the store has no trust-store dependency anywhere else, and giving
 * it one just to serve this one channel would spread the trust boundary across a file that
 * currently has none. Both shells already construct a `ProjectTrustStore` (main/server wiring) and
 * call a sibling `register*Handlers` for the setup runner right next to it — this follows the same
 * construction-order point.
 *
 * Only `agents`/`shell` are reported (not `setup`, though it is a `ProjectTrustFamily` too) —
 * `setup` already has its own gate at RUN time in `project-setup-service.ts`; this channel is for
 * consumers that need to know ahead of a launch, not another copy of that gate.
 */
export function registerProjectLaunchInfoHandlers(
  platform: CorePlatform,
  workspaceStore: Pick<WorkspaceStore, 'readProjectSettings' | 'projectTargetInfo'>,
  trustStore: ProjectTrustStore
): void {
  platform.handle(
    IPC.projectSettingsLaunchInfo,
    async (projectId: unknown): Promise<ProjectLaunchInfo | null> => {
      return readProjectLaunchInfo(workspaceStore, trustStore, projectId)
    }
  )
}
