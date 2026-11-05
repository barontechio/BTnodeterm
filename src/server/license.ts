import { AsyncLocalStorage } from 'node:async_hooks'
import { initLicense } from '../core/license'
import { OwnerLifetimes, type AccountOwner } from '../core/owner-lifetimes'
import type { CorePlatform } from '../core/platform'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'

type Request = { owner: AccountOwner; checkoutUrl?: string }
const freeStatus = (): LicenseStatus => ({ tier: null, active: false, expiresAt: null, termEndsAt: null, seats: 0, error: 'disabled' })

/** Licenses bind to this host installation; only attached owner connections may administer them. */
export function registerServerLicense(deps: {
  platform: CorePlatform; enabled: boolean; onChanged(): void
}): { forgetClient(id: number): void; dispose(): Promise<void> } {
  const { platform } = deps; const owners = new OwnerLifetimes(); const request = new AsyncLocalStorage<Request>()
  const eligible = (id: number) => platform.clientIds().includes(id) && platform.isOwnerClient?.(id) === true
  const register = (channel: string, handler: (...args: any[]) => unknown) => platform.handleWithSender(channel, (id, ...args) => {
    const context: Request = { owner: owners.get(id, () => eligible(id)) }
    return request.run(context, async () => {
      const result = await handler(...args)
      if (!context.owner.active()) throw new Error('license-owner-expired')
      return channel === IPC.licenseUpgrade ? { status: result, checkoutUrl: context.checkoutUrl } : result
    })
  })
  register(IPC.licenseCapabilities, () => ({ enabled: deps.enabled, hostContext: 'server' }))
  const service = deps.enabled ? initLicense(deps.onChanged, {
    register,
    current: () => request.getStore()?.owner.active() !== false,
    emit: (status) => { for (const id of platform.clientIds()) if (eligible(id)) platform.sendTo(id, IPC.licenseChanged, status) },
    openExternal: async (url) => {
      const context = request.getStore()
      if (!context?.owner.active()) throw new Error('license-owner-expired')
      if (new URL(url).protocol !== 'https:') throw new Error('license-checkout-requires-https')
      context.checkoutUrl = url
    }
  }) : undefined
  if (!service) {
    register(IPC.licenseStatus, freeStatus)
    for (const channel of [IPC.licenseActivate, IPC.licenseDeactivate, IPC.licenseUpgrade, IPC.licenseDetail, IPC.licenseRelease]) {
      register(channel, () => { throw new Error('license-disabled: enable NODETERM_SERVER_LICENSE on this host') })
    }
  }
  return { forgetClient: (id) => owners.forget(id), dispose: async () => { owners.dispose(); await service?.dispose() } }
}
