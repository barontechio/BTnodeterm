import fs from 'node:fs'
import { isAncestorPath } from '../shared/worktree'
import { manualProcessBirth } from './worktree-manual-shell'
import type { LocalTmuxExecution } from './local-tmux-execution'

/** Private capabilities minted by PtyManager, never accepted from IPC. */
export interface WorktreeRemovalTarget {
  readonly nodeId: string
  readonly identity: object
  readonly tmux?: LocalTmuxExecution
  assertCurrent(): void
}
export interface WorktreeRemovalPhysical {
  readonly nodeIds: readonly string[]
  readonly targets: ReadonlyMap<string, WorktreeRemovalTarget>
  assertCurrent(): void
  revalidate(): Promise<void>
}

/** Bounded observations of managed Linux process trees. No OSC paths and no assertion about
 * unrelated OS processes. A child, cwd, fd or birth change invalidates the original observation.
 * External processes can still race Git after the final observation; this is not an OS lock. */
export function captureManagedReferences(roots: readonly { pid: number; member: boolean }[], checkout: string): () => void {
  const inspect = () => {
    const seen = new Map<number, boolean>(); const rows: string[] = []
    const visit = (pid: number, member: boolean, depth: number) => {
      if (depth > 32 || seen.size >= 512) throw new Error('worktree-removal-runtime-capacity')
      if (seen.has(pid)) {
        if (seen.get(pid) !== member) throw new Error('worktree-removal-runtime-overlap')
        return
      }
      seen.set(pid, member)
      const birth = manualProcessBirth(pid)
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
      const descriptors = fs.readdirSync(`/proc/${pid}/fd`).sort()
      if (descriptors.length > 1024) throw new Error('worktree-removal-runtime-capacity')
      const refs = [cwd, ...descriptors.map((fd) => fs.readlinkSync(`/proc/${pid}/fd/${fd}`))]
      for (const ref of refs) {
        if (ref.endsWith(' (deleted)')) throw new Error('worktree-removal-runtime-unverifiable')
        if (!member && ref.startsWith('/') && isAncestorPath(checkout, ref))
          throw new Error('worktree-removal-nonmember-reference')
      }
      const tasks = fs.readdirSync(`/proc/${pid}/task`).sort()
      if (tasks.length > 128) throw new Error('worktree-removal-runtime-capacity')
      const children = tasks.flatMap((tid) => fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean))
      if (children.some((child) => !/^[1-9]\d*$/.test(child))) throw new Error('worktree-removal-runtime-unverifiable')
      if (manualProcessBirth(pid) !== birth) throw new Error('worktree-removal-runtime-changed')
      rows.push(JSON.stringify([pid, birth, refs, tasks, children]))
      for (const child of children) visit(Number(child), member, depth + 1)
    }
    for (const root of roots) visit(root.pid, root.member, 0)
    return JSON.stringify(rows)
  }
  const original = inspect()
  return () => { if (inspect() !== original) throw new Error('worktree-removal-runtime-changed') }
}
