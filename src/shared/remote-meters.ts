import type { ContextWindowUsage } from './types'

/** Owner UI only. No host paths, account credentials or command arguments. */
export type RemoteMeterStart = { status: 'started'; leaseId: string; ttlMs: number } |
  { status: 'local' | 'unavailable' | 'capacity' }
export interface RemoteMeterUpdate {
  leaseId: string
  nodeId: string
  sessionId: string
  status: 'ready' | 'unknown' | 'invalidated'
  usage: ContextWindowUsage | null
  quota: 'unavailable'
}
