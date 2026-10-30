/** Owner-only recovery facts. No command text, journal member hashes or physical process tokens. */
export interface WorktreeRecoveryItem {
  id: string
  createdAt: number
  phase: 'prepared' | 'removed' | 'recovered'
  projectId: string
  groupId: string
  repoPath: string
  path: string
  branch: string
  fallbackCwd: string
  memberIds: string[]
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
}
