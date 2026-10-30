import type { EmptyPromptResult } from '../shared/text-delivery'
import { TEXT_NOT_SUBMITTED } from '../shared/text-delivery'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isClaudeBranchSessionId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const MAX_CAPTURE = 256 * 1024
// capture-pane can wrap inside a UUID. Accept line wrapping within that fixed grammar only.
const wrapped = (count: number) => Array.from({ length: count }, () => '[0-9a-f]').join('(?:[ \\t]*\\r?\\n[ \\t]*)?')
const ID = [8, 4, 4, 4, 12].map(wrapped).join('(?:[ \\t]*\\r?\\n[ \\t]*)?-(?:[ \\t]*\\r?\\n[ \\t]*)?')
const marker = () => new RegExp(`Branched conversation\\.\\s+You are now in the new branch\\s+\\(session\\s+(${ID})\\)[\\s\\S]{0,1024}?(?:claude -r|/resume)\\s+(${ID})(?![0-9a-z_-])`, 'gi')

interface Session { sessionId?: string; agentId?: string; verified: boolean }
interface Dependencies {
  /** Caller holds a host node claim bound to saved account/cwd and physical pane generation. */
  assertCurrent(): void
  session(): Session
  capture(): Promise<string>
  /** Must be the measured empty-composer path, never raw sendText. */
  submit(): Promise<EmptyPromptResult>
  /** Preserve the existing pending-work hold even if the subsequent proof fails. */
  onDispatched(): void
  signal: AbortSignal
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  now?(): number
}
export type ClaudeBranchResult =
  | { outcome: 'branched'; originalId: string; sessionId: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'uncertain'; originalId: string; message: string }

function evidence(text: string, originalId: string): Set<string> {
  if (typeof text !== 'string' || text.length > MAX_CAPTURE) throw new Error('branch-capture-unavailable')
  const ids = new Set<string>()
  for (const match of text.matchAll(marker())) {
    const next = match[1].replace(/\s/g, '').toLowerCase()
    const previous = match[2].replace(/\s/g, '').toLowerCase()
    if (previous === originalId && next !== originalId) ids.add(next)
  }
  return ids
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('branch-cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
}

/** One non-retrying /branch effect. Proof is fresh pane output AND the verified new runtime id.
 * Does not open a copy, authorize a caller or acquire a node claim; the domain adapter owns those.
 */
export async function performClaudeBranch(original: string, deps: Dependencies): Promise<ClaudeBranchResult> {
  if (!isClaudeBranchSessionId(original)) return { outcome: 'refused', reason: 'branch-original-session-invalid' }
  const originalId = original.toLowerCase(); const now = deps.now ?? Date.now
  let attempted = false; let marked = false
  const check = () => { if (deps.signal.aborted) throw new Error('branch-cancelled'); deps.assertCurrent() }
  const session = () => {
    const value = deps.session()
    if (!value.verified || value.agentId !== 'claude' || !value.sessionId || !UUID.test(value.sessionId))
      throw new Error('branch-runtime-unverified')
    return value.sessionId.toLowerCase()
  }
  try {
    check()
    if (session() !== originalId) throw new Error('branch-session-changed')
    const initial = await deps.capture()
    if (!initial.trim()) throw new Error('branch-capture-unavailable')
    const before = evidence(initial, originalId)
    check()
    if (session() !== originalId) throw new Error('branch-session-changed')
    attempted = true
    const submitted = await deps.submit()
    if (!submitted.sent && submitted.reason !== 'failed' && submitted.reason !== 'not-submitted') {
      attempted = false
      return { outcome: 'refused', reason: `branch-composer-${submitted.reason}` }
    }
    marked = true; deps.onDispatched()
    if (!submitted.sent) return { outcome: 'uncertain', originalId, message: TEXT_NOT_SUBMITTED }
    const deadline = now() + 8_000
    for (let pass = 0; pass < 32 && now() < deadline; pass++) {
      check()
      const after = evidence(await deps.capture(), originalId)
      check()
      if (now() >= deadline) throw new Error('branch-result-unconfirmed')
      const current = session()
      const fresh = [...after].filter((id) => !before.has(id))
      if (fresh.length === 1 && current === fresh[0]) return { outcome: 'branched', originalId, sessionId: current }
      // Multiple new results or an unrelated session transition cannot select a safe copy.
      if (fresh.length > 1 || (fresh.length === 1 && current !== originalId && current !== fresh[0])) throw new Error('branch-result-ambiguous')
      await (deps.sleep ?? pause)(250, deps.signal)
    }
    throw new Error('branch-result-unconfirmed')
  } catch (error) {
    return attempted
      ? { outcome: 'uncertain', originalId, message: 'The branch command may have run, but its new session could not be confirmed. Do not repeat it. Inspect the terminal before resuming the original conversation.' }
      : { outcome: 'refused', reason: error instanceof Error ? error.message : 'branch-inspection-failed' }
  } finally {
    if (attempted && !marked) deps.onDispatched()
  }
}
