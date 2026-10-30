import { initCodexAccountService } from '../core/codex-account-service'
import { OwnerLifetimes } from '../core/owner-lifetimes'
import type { CorePlatform } from '../core/platform'

/** Account administration belongs to the authenticated owner's connection, never relay peers. */
export function registerServerCodexAccounts(platform: CorePlatform): { forgetClient(id: number): void; dispose(): void } {
  const owners = new OwnerLifetimes()
  const service = initCodexAccountService({
    // Server uses core's shared identity proxy instead of the legacy Desktop relay daemon.
    ensureRelayRoot: () => {},
    handle: (channel, handler) => platform.handleWithSender(channel, (id, ...args) => handler(
      owners.get(id, () => platform.clientIds().includes(id) && platform.isOwnerClient?.(id) === true), ...args))
  })
  return { forgetClient: (id) => owners.forget(id), dispose: () => { service.dispose(); owners.dispose() } }
}
