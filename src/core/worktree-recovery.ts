import path from 'node:path'
import type { PtyManager } from './pty-manager'
import { WorktreeRemovalJournal } from './worktree-removal-journal'
import { worktreeRecoveryAdmission } from './worktree-recovery-admission'
import { installWorktreeCanvasAdmission, type WorktreeCanvasAdmission } from './worktree-canvas-admission'
import type { WorkspaceStore } from './workspace-store'
import { WorktreeRecoveryDispatch } from './worktree-recovery-dispatch'

export interface WorktreeRecoveryRuntime {
  journal: WorktreeRemovalJournal
  canvasAdmission: WorktreeCanvasAdmission | null
  dispatch: WorktreeRecoveryDispatch
  idle(): Promise<void>
}

/** Install before owner/headless launches become available. Missing state loads empty, without
 * writing a file. Unreadable recovery facts keep existing panes but refuse new physical starts.
 * Only the core owning this data directory installs the guard and can advance recovery facts.
 */
export async function initWorktreeRecovery(dataDir: string,
  pty: Pick<PtyManager, 'setWorktreeRecoveryAdmission' | 'setNodeExecutionAdmission'>, ownsFiles: () => boolean, workspace?: WorkspaceStore
): Promise<WorktreeRecoveryRuntime | null> {
  if (!ownsFiles()) return null
  const journal = new WorktreeRemovalJournal(path.join(dataDir, 'worktree-removals.json'), { ownsFiles })
  try { await journal.load() }
  catch (error) { console.warn('[worktree-recovery] recovery state unavailable; inspect the local journal before new starts', error) }
  // The journal itself refuses unavailable state, including ownership lost after boot.
  pty.setWorktreeRecoveryAdmission(worktreeRecoveryAdmission(journal))
  const dispatch = new WorktreeRecoveryDispatch(journal)
  pty.setNodeExecutionAdmission((nodeId, permit) => dispatch.assertAllowed(nodeId, permit))
  const canvasAdmission = workspace ? installWorktreeCanvasAdmission(workspace, journal) : null
  return { journal, canvasAdmission, dispatch, idle: () => journal.idle() }
}
