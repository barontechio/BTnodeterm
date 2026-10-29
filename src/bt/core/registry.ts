import type { BtExtension } from '../shared/extension'
import { infoExtension } from './info'

/** Every fork extension, in start order. Shell-specific ones declare `editions`. */
export const BT_EXTENSIONS: readonly BtExtension[] = [infoExtension]
