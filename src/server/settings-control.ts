/**
 * Read adapter and explicit refusal for shells without a settings confirmation backend.
 * Production changes route through core/settings-control.ts, outside command/workspace queues.
 * Operator opt-in and creator scope never stand in for individual owner consent.
 *
 * `--get` answers from the same stores the delivery gate reads — the capability view is
 * `workspaceStore.capabilityProjectFor`, i.e. the file flag plus this machine's recorded answer — so
 * a read can never say "on" where a delivery would be refused. `--project` is limited to the
 * caller's OWN project: this edition keeps no `open-project` grant ledger that main's
 * `gateProjectTarget` could consult, and a read of another project's switch is not worth inventing
 * one for.
 */
import {
  SETTINGS_VERB_KEY_LIST,
  parseSettingsRequest,
  renderSettingsGet,
  type SettingsProjectView
} from '../shared/settings-verb'
import type { CapabilityAckMap } from '../shared/project-capability-consent'
import type { ProjectCapability } from '../shared/project-capabilities'
import type { Settings } from '../shared/types'
import { CONTROL_UNSUPPORTED_ERROR } from './control-unsupported'
import type { ServerControlReply } from './headless-node-factory'

export const SETTINGS_SET_UNSUPPORTED_MESSAGE =
  `${CONTROL_UNSUPPORTED_ERROR}: this host has no settings confirmation backend. ` +
  'Ask the user to change it in Settings; do not retry.'

export interface ServerSettingsControlDeps {
  persistedCanvases(): Array<{ id: string; nodes: ReadonlyArray<{ id: string }> }>
  capabilityProjectFor(
    projectId: string
  ): (Partial<Record<ProjectCapability, boolean>> & { capabilityAck?: CapabilityAckMap }) | undefined
  projectName(projectId: string): string | undefined
  settings(): Settings
}

export function serverSettingsControl(
  deps: ServerSettingsControlDeps,
  sourceNodeId: string,
  args: Record<string, string>
): ServerControlReply {
  const request = parseSettingsRequest(args)
  if ('error' in request) return { ok: false, error: request.error }
  if (request.action === 'set') {
    return { ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: SETTINGS_SET_UNSUPPORTED_MESSAGE }
  }
  const callerProjectId = deps
    .persistedCanvases()
    .find((p) => p.nodes.some((n) => n.id === sourceNodeId))?.id
  if (request.project !== undefined && request.project !== callerProjectId) {
    return {
      ok: false,
      error:
        'project-target-refused: on nodeterm Server Edition, settings can only be read for your own project'
    }
  }
  let project: SettingsProjectView | undefined
  if (callerProjectId) {
    project = {
      id: callerProjectId,
      name: deps.projectName(callerProjectId) ?? callerProjectId,
      ...(deps.capabilityProjectFor(callerProjectId) ?? {})
    }
  }
  return renderSettingsGet({
    keys: request.action === 'get' ? [request.key] : SETTINGS_VERB_KEY_LIST,
    settings: deps.settings(),
    project
  })
}
