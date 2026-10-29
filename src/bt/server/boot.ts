import { platform } from '../../core/platform'
import { startBtExtensions, type BtRuntime } from '../core/extensions'
import { BT_EXTENSIONS } from '../core/registry'

/** Server Edition seam: called from src/server/main.ts once startServer() has initialized the
 *  platform. The only fork code upstream's server entry knows about. */
export function startBtServer(): Promise<BtRuntime> {
  return startBtExtensions('server', platform(), BT_EXTENSIONS)
}
