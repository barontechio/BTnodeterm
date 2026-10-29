import type { CorePlatform } from '../../core/platform'

/** Which shell booted the extension. Logic that differs per shell branches on this, nothing else. */
export type BtEdition = 'server' | 'desktop'

export interface BtExtensionContext {
  readonly edition: BtEdition
  /** The shell's CorePlatform — the ONLY way an extension talks to its shell (RPC, broadcast, dirs). */
  readonly platform: CorePlatform
  /** `<userData>/bt/<extension id>`: the extension's own state. Created on demand by the extension. */
  readonly dataDir: string
  log(...args: unknown[]): void
}

export interface BtExtensionHandle {
  stop?(): void | Promise<void>
}

/**
 * A fork-only feature. Lives under src/bt and reaches upstream code only through `CorePlatform`
 * and imports of upstream modules — never by editing them. Reusable logic belongs in src/bt/core
 * (Electron-free, booted by BOTH shells); a feature that only makes sense on one shell declares it
 * with `editions`.
 */
export interface BtExtension {
  /** Stable kebab-case id; also the data dir name and the RPC channel prefix (`bt:<id>:…`). */
  readonly id: string
  /** Shells to run on. Absent = both. */
  readonly editions?: readonly BtEdition[]
  start(ctx: BtExtensionContext): BtExtensionHandle | void | Promise<BtExtensionHandle | void>
}
