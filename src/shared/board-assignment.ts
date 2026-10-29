import type { ProjectKanban } from './types'
import { assignNode, defaultKanban, resolveColumnRef } from './kanban'

/** Board-only planning. Caller checks card membership and authorization before committing. */
export function planBoardAssignment(board: ProjectKanban | undefined, projectId: string, nodeId: string, args: { column?: string; before?: string }):
  | { ok: false; error: string }
  | { ok: true; previous: ProjectKanban; next: ProjectKanban; columnId: string | null } {
  const previous = board ?? defaultKanban(projectId)
  const rawColumn = (args.column ?? '').trim()
  const columnId = resolveColumnRef(previous, rawColumn)
  if (columnId === undefined) return {
    ok: false, error: `assign: no column "${rawColumn}" — columns: ${previous.columns.map((c) => c.title).join(', ') || '(none)'}`
  }
  return { ok: true, previous, next: assignNode(previous, nodeId, columnId, (args.before ?? '').trim() || null), columnId }
}
