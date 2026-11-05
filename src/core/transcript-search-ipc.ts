import { IPC } from '../shared/ipc'
import type { ClaudeAccount, TranscriptSearchScope } from '../shared/types'
import type { CorePlatform } from './platform'
import { initTranscriptIndex, refreshTranscriptIndex, searchTranscripts, stopTranscriptIndex } from './transcript-index'

function scopeOf(raw: unknown): TranscriptSearchScope {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('transcript-search-invalid-scope')
  const scope = raw as TranscriptSearchScope
  if (Object.keys(raw).some((key) => !['accountId', 'cwd', 'limit'].includes(key)) ||
    (scope.accountId !== undefined && scope.accountId !== null && (typeof scope.accountId !== 'string' || !scope.accountId || scope.accountId.length > 256)) ||
    (scope.cwd !== undefined && (typeof scope.cwd !== 'string' || scope.cwd.length > 4096)) ||
    (scope.limit !== undefined && (!Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 100))) {
    throw new Error('transcript-search-invalid-scope')
  }
  return { ...scope }
}

/** Local Claude search for the host owner. Server starts scanning only when search is requested. */
export function registerTranscriptSearchIpc(platform: CorePlatform, getAccounts: () => ClaudeAccount[], opts: { lazy?: boolean } = {}): () => Promise<void> {
  let started = false
  let stopped = false
  let ready: Promise<void> | undefined
  const start = () => {
    if (!started) { initTranscriptIndex(getAccounts); started = true; ready = refreshTranscriptIndex() }
    return ready
  }
  if (!opts.lazy) start()
  const search = async (senderId: number, query: unknown, rawScope?: unknown) => {
    if (stopped || platform.isOwnerClient?.(senderId) !== true) throw new Error('transcript-search-owner-required')
    if (typeof query !== 'string' || query.length > 512) throw new Error('transcript-search-invalid-query')
    const scope = scopeOf(rawScope)
    await start()
    if (stopped || platform.isOwnerClient?.(senderId) !== true) throw new Error('transcript-search-owner-required')
    return searchTranscripts(query, scope)
  }
  platform.handleWithSender(IPC.transcriptSearch, (senderId, query) => search(senderId, query))
  // Separate additive channel: an old host must refuse scoped search rather than silently ignore scope.
  platform.handleWithSender(IPC.transcriptSearchScoped, search)
  return async () => { stopped = true; if (started) await stopTranscriptIndex() }
}
