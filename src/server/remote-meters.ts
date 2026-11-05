import type { CorePlatform } from '../core/platform'
import { OwnerLifetimes } from '../core/owner-lifetimes'
import { RemoteMeters, type RemoteMeterSource } from '../core/remote-meters'
import { IPC } from '../shared/ipc'

/** The shell supplies authenticated WS lifetimes. No agent/link/relay entry point. */
export function createServerRemoteMeters(platform: CorePlatform,
  capture: (nodeId: string) => RemoteMeterSource | null | undefined) {
  const owners = new OwnerLifetimes()
  const meters = new RemoteMeters()
  const owner = (id: number) => {
    const eligible = () => platform.clientIds().includes(id) && platform.isOwnerClient?.(id) === true
    return eligible() ? owners.get(id, eligible) : null
  }
  platform.handleWithSender(IPC.contextRemoteStart, (id, nodeId: unknown) => {
    const caller = owner(id)
    if (!caller || typeof nodeId !== 'string' || !nodeId || nodeId.length > 256) return { status: 'unavailable' }
    let source: ReturnType<typeof capture>
    try { source = capture(nodeId) } catch { return { status: 'unavailable' } }
    if (source === undefined) return { status: 'local' }
    if (!source) return { status: 'unavailable' }
    return meters.start(caller, source, update => {
      // Synchronous addressed publication: no await between the original proof check and send.
      if (!caller.active()) return
      if (update.usage && !source.current()) return
      platform.sendTo(id, IPC.contextRemoteUpdate, update)
    })
  })
  platform.handleWithSender(IPC.contextRemoteRenew, (id, token: unknown) => {
    const caller = owner(id)
    return !!caller && typeof token === 'string' && token.length <= 64 && meters.renew(caller, token)
  })
  platform.handleWithSender(IPC.contextRemoteRelease, (id, token: unknown) => {
    const caller = owner(id)
    if (caller && typeof token === 'string' && token.length <= 64) meters.release(caller, token)
  })
  return { forgetClient: (id: number) => owners.forget(id), dispose: () => { meters.dispose(); owners.dispose() } }
}
