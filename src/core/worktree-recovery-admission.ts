import fs from 'node:fs'
import path from 'node:path'
import { isAncestorPath } from '../shared/worktree'
import type { WorktreeRemovalJournal } from './worktree-removal-journal'

/** Resolve existing ancestors AND dangling symlink ancestors. A removed checkout can still be
 * reached through an alias whose target no longer exists; a lexical parent fallback misses it.
 * Unknown IO/permissions and bounded-resolution exhaustion refuse instead of falling back home.
 */
function canonicalDirectory(requested: string): string {
  if (typeof requested !== 'string' || !requested || requested.length > 4096 || requested.includes('\0'))
    throw new Error('worktree-recovery-directory-unverifiable')
  let current = path.resolve(requested); const rest: string[] = []; let links = 0
  for (let depth = 0; depth < 128; depth++) {
    try { return path.join(fs.realpathSync.native(current), ...rest) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Error('worktree-recovery-directory-unverifiable')
    }
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        if (++links > 16) throw new Error('worktree-recovery-directory-unverifiable')
        current = path.resolve(path.dirname(current), fs.readlinkSync(current), ...rest)
        rest.length = 0
        continue
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    const parent = path.dirname(current)
    if (parent === current) break
    rest.unshift(path.basename(current)); current = parent
  }
  throw new Error('worktree-recovery-directory-unverifiable')
}

/** Physical-start guard only. The journal supplies facts, not permission to delete/rebind.
 * An unavailable journal throws before the backend can apply its ordinary stale-cwd fallback.
 * With no reserved paths, existing launch behavior and its filesystem cost remain unchanged.
 */
export function worktreeRecoveryAdmission(journal: Pick<WorktreeRemovalJournal, 'reservedPaths'>): (directory: string) => void {
  return (directory) => {
    const roots = journal.reservedPaths()
    if (!roots.length) return
    const canonical = canonicalDirectory(directory)
    if (roots.some((root) => isAncestorPath(root, canonical)))
      throw new Error('worktree-recovery-required: inspect removal recovery before starting a terminal in this directory')
  }
}
