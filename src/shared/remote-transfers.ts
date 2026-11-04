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
