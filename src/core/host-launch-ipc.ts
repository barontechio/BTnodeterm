import type { CorePlatform } from './platform'
import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import type { HostLaunchReply } from '../shared/headless-launch'

/** Owner recovery is serialized with the same host scheduler that performs automatic release. */
export function registerHostLaunchIpc(platform: CorePlatform, run: (id: string, expectedCommand: string) => Promise<HostLaunchReply>): void {
  platform.handleWithSender(IPC.controlRunLaunch, async (senderId, id: unknown, command: unknown): Promise<HostLaunchReply> => {
    if (platform.isOwnerClient?.(senderId) !== true) return { ok: false, started: false, error: 'run-host-owner-required' }
    if (typeof id !== 'string' || !isSafeNodeId(id) || typeof command !== 'string' || !command || command.length > 256 * 1024 || command.includes('\0')) {
      return { ok: false, started: false, error: 'run-host-invalid-request' }
    }
    try { return await run(id, command) } catch (error) {
      return { ok: false, started: false, error: `run-host-uncertain: inspect the session before repeating; ${String(error)}` }
    }
  })
}
