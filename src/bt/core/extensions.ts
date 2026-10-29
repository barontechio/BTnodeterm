import path from 'path'
import type { CorePlatform } from '../../core/platform'
import type { BtEdition, BtExtension, BtExtensionHandle } from '../shared/extension'

export interface BtRuntime {
  /** Ids that started, in start order. */
  readonly started: readonly string[]
  /** Stops every started extension in reverse order. Never throws; safe to call twice. */
  stop(): Promise<void>
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/**
 * Start the fork's extensions for one shell. A failing extension is logged and skipped: a fork
 * feature must never take the upstream boot down with it.
 */
export async function startBtExtensions(
  edition: BtEdition,
  platform: CorePlatform,
  extensions: readonly BtExtension[],
  log: (...args: unknown[]) => void = (...a) => console.log('[bt]', ...a)
): Promise<BtRuntime> {
  const running: { id: string; handle: BtExtensionHandle | void }[] = []
  const seen = new Set<string>()
  for (const ext of extensions) {
    if (!SAFE_ID.test(ext.id) || seen.has(ext.id)) {
      log(`skipping extension with invalid or duplicate id: ${JSON.stringify(ext.id)}`)
      continue
    }
    seen.add(ext.id)
    if (ext.editions && !ext.editions.includes(edition)) continue
    try {
      const handle = await ext.start({
        edition,
        platform,
        dataDir: path.join(platform.userDataDir, 'bt', ext.id),
        log: (...a) => log(`[${ext.id}]`, ...a)
      })
      running.push({ id: ext.id, handle })
    } catch (err) {
      log(`extension ${ext.id} failed to start:`, err)
    }
  }
  let stopped = false
  return {
    started: running.map((r) => r.id),
    async stop() {
      if (stopped) return
      stopped = true
      for (const { id, handle } of [...running].reverse()) {
        try {
          await handle?.stop?.()
        } catch (err) {
          log(`extension ${id} failed to stop:`, err)
        }
      }
    }
  }
}
