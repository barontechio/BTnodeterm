/** Uploads create a new file in the verified opened remote directory. This is stable inode
 * authority, not an atomic lock on the pathname: a concurrent rename after authorization may
 * leave the file in the moved original directory. Such namespace uncertainty is UNKNOWN;
 * clients must explain that possibility and must never automatically resend the body. */
export interface RemoteTransferRequest {
  projectId: string
  relativePath: string
  kind: 'upload' | 'download' | 'media'
  bytes?: number
  /** Required for node attachments/media; the host verifies saved project/account/session. */
  nodeId?: string
}
export type RemoteUploadOutcome =
  | { outcome: 'committed'; bytes: number; sha256: string; path: string }
  | { outcome: 'conflict' | 'not-written' | 'unknown' | 'unavailable' }
export type RemoteTransferPrepared =
  | { status: 'ready'; reference: string; url: string; bytes: number; expiresAt: number }
  | { status: 'unavailable' | 'conflict' | 'busy' }
export interface RemoteTransfersApi {
  prepare(request: RemoteTransferRequest): Promise<RemoteTransferPrepared>
  status(reference: string): Promise<RemoteUploadOutcome>
  renew(reference: string): Promise<boolean>
  release(reference: string): Promise<void>
}
