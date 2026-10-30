// Native adapter: account lifecycle and rollout reservations live in the shared core service.
import { ipcMain, type WebContents } from 'electron'
import { initCodexAccountService } from '../core/codex-account-service'
import { OwnerLifetimes } from '../core/owner-lifetimes'
import { ensureCodexRelayRoot } from './codex-relay-daemon'
import type { SshProjectManager } from './remote-ssh/ssh-project'

export { localCodexAccountHome, localCodexSocket, ensureCodexAccountDaemon,
  setCodexAccountsHostPlatformForTests } from '../core/codex-account-service'

const owners = new OwnerLifetimes()
const senders = new Map<number, WebContents>()
export function forgetCodexAccountOwner(id: number): void {
  owners.forget(id); senders.delete(id)
}
export function initCodexAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  initCodexAccountService({ ensureRelayRoot: ensureCodexRelayRoot, remote: getSshManager,
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
      const sender = event.sender
      const id = sender.id
      if (senders.get(id) !== sender) {
        forgetCodexAccountOwner(id)
        senders.set(id, sender)
        sender.once('destroyed', () => forgetCodexAccountOwner(id))
      }
      const owner = owners.get(id, () => senders.get(id) === sender && !sender.isDestroyed())
      return handler(owner, ...args)
    })
  })
}
