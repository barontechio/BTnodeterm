import type { NodeTerminalApi, PendingLaunch } from '@shared/types'
import type { HostLaunchReply } from '@shared/headless-launch'

/** Null permits only the old-host path. An uncertain host request must never fall back to typing. */
export async function runHostQueuedLaunch(api: Pick<NodeTerminalApi, 'control'>, nodeId: string, pending: PendingLaunch | undefined): Promise<HostLaunchReply | null> {
  if (pending?.executor !== 'server' || !api.control?.runLaunch) return null
  try { return await api.control.runLaunch(nodeId, pending.command) } catch {
    return { ok: false, started: false, error: 'Launch could not be confirmed. Inspect the session before sending again.' }
  }
}
