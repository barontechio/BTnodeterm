import { openDialogCount } from '../components/dialog-stack'

const blockers = new Set<() => boolean>()
let ticket: string | null = null

/** Canvas supplies its synchronous pending flags, including the gap before a modal mounts. */
export function registerConfirmationBlocker(blocked: () => boolean): () => void {
  blockers.add(blocked)
  return () => { blockers.delete(blocked) }
}
export function hasOwnerConfirmation(): boolean { return ticket !== null }
export function claimOwnerConfirmation(id: string): boolean {
  if (ticket || openDialogCount() > 0) return false
  for (const blocked of blockers) {
    try { if (blocked()) return false } catch { return false }
  }
  ticket = id
  return true
}
export function releaseOwnerConfirmation(id: string): void { if (ticket === id) ticket = null }
