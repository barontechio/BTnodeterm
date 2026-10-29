import { app } from 'electron'
import { platform } from '../../core/platform'
import { startBtExtensions } from '../core/extensions'
import { BT_EXTENSIONS } from '../core/registry'

/** Desktop seam: called once from src/main/index.ts inside app.whenReady(). Stops on will-quit. */
export function startBtDesktop(): void {
  const runtime = startBtExtensions('desktop', platform(), BT_EXTENSIONS)
  app.once('will-quit', () => {
    void runtime.then((r) => r.stop())
  })
}
