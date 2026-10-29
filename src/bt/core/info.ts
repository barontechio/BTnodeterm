import { FORK_NAME, UPSTREAM_BASE } from '../shared/fork'
import type { BtExtension } from '../shared/extension'

/** `bt:info:get` — which fork and upstream base a core runs. Shared by both shells; also the
 *  reference shape for a new extension. */
export const infoExtension: BtExtension = {
  id: 'info',
  start({ platform, edition }) {
    platform.handle('bt:info:get', () => ({
      fork: FORK_NAME,
      upstreamBase: UPSTREAM_BASE,
      appVersion: platform.appVersion,
      edition
    }))
  }
}
