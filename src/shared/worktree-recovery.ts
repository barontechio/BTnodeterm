/** Owner-only recovery facts. No command text, journal member hashes or physical process tokens. */
export interface WorktreeRecoveryItem {
  id: string
  createdAt: number
  phase: 'prepared' | 'removed' | 'recovered'
  pathRestricted?: boolean
  provenance?: 'recorded-directory' | 'observed-missing'
  projectId: string
  groupId: string
  repoPath: string
  path: string
  branch: string
  fallbackCwd: string
  memberIds: string[]
  manualStartIds?: string[]
}
export type WorktreeRecoveryList = { ok: true; records: WorktreeRecoveryItem[] } | { ok: false; error: string }
export type WorktreeRecoveryInspection = { ok: true; record: WorktreeRecoveryItem; status: 'kept' | 'missing' | 'changed' | 'unavailable' } |
  { ok: false; error: string }
export type WorktreeRecoveryKeepReply = { ok: true; outcome: 'kept'; message: string } |
  { ok: false; outcome: 'refused' | 'uncertain'; error: string }
export interface WorktreeRecoveryApi {
  /** null means this older/non-owning host does not expose recovery administration. */
  list(): Promise<WorktreeRecoveryList | null>
  inspect(id: string): Promise<WorktreeRecoveryInspection>
  keep(id: string): Promise<WorktreeRecoveryKeepReply>
  rebind?(id: string): Promise<WorktreeRecoveryRebindReply>
  discoverMissing?(): Promise<WorktreeMissingList>
  recoverMissing?(groupId: string): Promise<WorktreeRecoveryRepairReply>
  recover?(id: string): Promise<WorktreeRecoveryRepairReply>
}

export type WorktreeRecoveryRepairReply = { ok: true; outcome: 'recovered'; message: string } |
  { ok: false; outcome: 'refused' | 'uncertain'; error: string }

export interface WorktreeMissingCandidate { groupId: string; projectId: string; branch: string; path: string }
export type WorktreeMissingList = { ok: true; candidates: WorktreeMissingCandidate[] } | { ok: false; error: string }

export type WorktreeRecoveryRebindReply = { ok: true; outcome: 'rebound'; message: string } |
  { ok: false; outcome: 'refused' | 'uncertain'; error: string }
