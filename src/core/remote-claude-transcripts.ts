import { stableStringify } from '../shared/canvas-mutations'
import { CHAT_PAGE_MAX_BYTES, type ChatTranscriptPage } from '../shared/chat-page'
import type { SshConnection } from '../shared/ssh'
import type { TranscriptPresence } from '../shared/types'
import type { RemoteTranscriptPage, TranscriptQuery } from './transcript-ipc'
import { SESSION_ID_RE } from './transcript-reader'
import { parseStrictTranscriptPage, strictTranscriptReadCommand, type StrictTranscriptPage } from './remote-ssh/strict-transcript-read'

export interface RemoteClaudeTranscriptTarget {
  nodeId: string
  projectId: string
  sessionId?: string
  accountId?: string
  cwd?: string
  home: string
  conn: SshConnection
  controlPath: string
  connectionKey: string
}
interface Dependencies {
  /** Optional caller policy; absent only for trusted internal host consumers. */
  allowed?(): boolean
  /** undefined = local; null = remote but unavailable. Already verifies saved endpoint/account. */
  targetFor(nodeId: string): RemoteClaudeTranscriptTarget | null | undefined
  run(target: RemoteClaudeTranscriptTarget, command: string): Promise<{ code: number; stdout: string }>
  withQueuedExecutionCheck<T>(current: () => boolean, work: () => Promise<T>, options: { signal: AbortSignal }): Promise<T>
}
type Read = StrictTranscriptPage | 'absent' | 'unreadable' | 'runtime-unavailable' | 'unsafe' | 'permission-required' | undefined

/** Read-only SSH counterpart. No implicit connect, system-account fallback, host file or retry. */
export class RemoteClaudeTranscripts {
  private stopped = false
  private active = new Map<AbortController, string>()
  constructor(private readonly deps: Dependencies, private readonly now: () => number = () => Date.now()) {}

  private async execute(q: TranscriptQuery, page: ChatTranscriptPage): Promise<Read> {
    q = { ...q }; page = { ...page }
    if (!q.nodeId) return q.remoteOnly ? 'unreadable' : undefined
    let target: RemoteClaudeTranscriptTarget | null | undefined
    try { target = this.deps.targetFor(q.nodeId) } catch { return 'unreadable' }
    if (target === undefined) return q.remoteOnly ? 'unreadable' : undefined
    const allowed = () => { try { return !this.deps.allowed || this.deps.allowed() === true } catch { return false } }
    if (!allowed()) return 'permission-required'
    if (!target || this.stopped) return 'unreadable'
    if (!q.sessionId) return 'absent'
    if (!SESSION_ID_RE.test(q.sessionId) || q.sessionId !== target.sessionId ||
      (q.accountId != null && q.accountId !== target.accountId) || target.nodeId !== q.nodeId) return 'unreadable'
    if (this.active.size >= 32 || [...this.active.values()].filter((id) => id === q.nodeId).length >= 2) return 'unreadable'
    const binding = stableStringify(target); const captured = target
    const abort = new AbortController(); const deadline = this.now() + 30_000
    this.active.set(abort, q.nodeId)
    const timer = setTimeout(() => abort.abort(), 30_000); timer.unref?.()
    const current = () => {
      if (this.stopped || abort.signal.aborted || this.now() >= deadline || !allowed()) return false
      try { return stableStringify(this.deps.targetFor(q.nodeId!)) === binding } catch { return false }
    }
    try {
      return await this.deps.withQueuedExecutionCheck(current, async () => {
        const query = { home: captured.home, accountId: captured.accountId, sessionId: q.sessionId!,
          before: page.before, maxBytes: page.maxBytes }
        const result = await this.deps.run(captured, strictTranscriptReadCommand(query))
        if (!current()) return 'unreadable'
        if (result.code === 66) return 'absent'
        if (result.code === 67) return 'unsafe'
        if (result.code === 69 || result.code === 127) return 'runtime-unavailable'
        if (result.code !== 0) return 'unreadable'
        return parseStrictTranscriptPage(result.stdout, query)
      }, { signal: abort.signal })
    } catch { return 'unreadable' }
    finally { clearTimeout(timer); abort.abort(); this.active.delete(abort) }
  }

  async readPage(q: TranscriptQuery, page: ChatTranscriptPage): Promise<RemoteTranscriptPage | null> {
    const result = await this.execute(q, page)
    if (result === undefined) return null
    if (result === 'absent') return { ok: false, absent: true }
    if (result === 'runtime-unavailable') return { ok: false, reason: 'remote-runtime-unavailable' }
    if (result === 'unsafe') return { ok: false, reason: 'remote-unsafe-transcript' }
    if (result === 'permission-required') return { ok: false, reason: 'remote-reader-permission-required' }
    if (result === 'unreadable') return { ok: false }
    return { ok: true, data: result.data, start: result.start }
  }

  async read(q: TranscriptQuery): Promise<string | null> {
    const result = await this.execute(q, { before: null, maxBytes: CHAT_PAGE_MAX_BYTES })
    return result && typeof result === 'object' ? result.data.toString('utf8') : null
  }

  async exists(q: TranscriptQuery): Promise<TranscriptPresence | null> {
    const result = await this.execute(q, { before: null, maxBytes: 1 })
    if (result === undefined) return null
    if (result === 'absent' && q.sessionId && SESSION_ID_RE.test(q.sessionId)) return 'absent'
    return result && typeof result === 'object' ? 'present' : 'unknown'
  }

  dispose(): void { this.stopped = true; for (const abort of this.active.keys()) abort.abort() }
}
