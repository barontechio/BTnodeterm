export type OwnerAction = 'write' | 'branch' | 'settings' | 'remove-worktree' | 'account-switch' | 'ssh-trust' | 'browser-control'
export interface OwnerConfirmation {
  id: string
  token: string
  proof: string
  action: OwnerAction
  requester: { nodeId: string; projectId: string; title: string }
  message: string
  details?: string
  confirmLabel: string
  danger: boolean
  expiresAt: number
  /** UI countdown measured from receipt; the host still enforces its absolute deadline. */
  remainingMs: number
}
export interface OwnerConfirmationAnswer {
  id: string
  token: string
  proof: string
  answer: 'approve' | 'deny' | 'busy'
}
export interface OwnerConfirmationApi {
  connect(): Promise<string>
  disconnect(epoch: string): Promise<void>
  decide(answer: OwnerConfirmationAnswer): Promise<boolean>
  onRequest(listener: (request: OwnerConfirmation) => void): () => void
  onDismiss(listener: (id: string) => void): () => void
}
