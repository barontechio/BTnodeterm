import type { RestartOutcome } from '../terminal/agent-restart'

export interface CodexSwitchFacts {
  exposure: 'not-dispatched' | 'unconfirmed' | 'confirmed'
  metadataRequested: boolean
  restart: RestartOutcome | 'not-requested' | 'unconfirmed'
  stale: boolean
  cleanupFailed: boolean
  finish: 'not-requested' | 'unconfirmed' | 'confirmed'
  failed: boolean
}

/** Reporting for the existing compatibility flow; these are observations, not durable receipts. */
export async function runCodexSwitch(deps: {
  prepare: () => Promise<string | undefined>
  commit: (token: string) => Promise<unknown>
  release: (token: string) => Promise<unknown>
  finish: (token: string) => Promise<unknown>
  eligible: () => boolean
  requestMetadata: () => void
  restart: () => Promise<RestartOutcome>
}): Promise<CodexSwitchFacts | null> {
  const facts = initialFacts()
  let token: string | undefined
  let releaseAttempted = false
  try {
    token = await deps.prepare()
    if (!token) return null
    if (!deps.eligible()) {
      facts.stale = true
      releaseAttempted = true
      await deps.release(token)
      return facts
    }
    facts.exposure = 'unconfirmed'
    await deps.commit(token)
    facts.exposure = 'confirmed'
    facts.metadataRequested = true
    deps.requestMetadata()
    facts.restart = 'unconfirmed'
    facts.restart = await deps.restart()
    facts.finish = 'unconfirmed'
    await deps.finish(token)
    facts.finish = 'confirmed'
  } catch {
    facts.failed = true
    if (releaseAttempted) facts.cleanupFailed = true
    if (token && !releaseAttempted) {
      try {
        // Releases the reservation only. Published exposure and node/runtime effects survive.
        await deps.release(token)
      } catch {
        facts.cleanupFailed = true
      }
    }
    return facts
  }
  return facts
}

const initialFacts = (): CodexSwitchFacts => ({
  exposure: 'not-dispatched', metadataRequested: false, restart: 'not-requested',
  stale: false, cleanupFailed: false, finish: 'not-requested', failed: false
})

export async function runRemoteCodexSwitch(deps: {
  expose: () => Promise<unknown>
  eligible: () => boolean
  restart: (metadataRequested: () => void) => Promise<RestartOutcome>
  markDirty: () => void
}): Promise<CodexSwitchFacts> {
  const facts = initialFacts()
  try {
    facts.exposure = 'unconfirmed'
    await deps.expose()
    facts.exposure = 'confirmed'
    if (!deps.eligible()) {
      facts.stale = true
      return facts
    }
    facts.restart = 'unconfirmed'
    facts.restart = await deps.restart(() => { facts.metadataRequested = true })
    if (facts.restart === 'restarted') deps.markDirty()
  } catch {
    facts.failed = true
    // Dispatch can publish even if its reply is lost. Never retry or imply compensation.
  }
  return facts
}

export function codexSwitchNotice(facts: CodexSwitchFacts): { kind: 'info' | 'error'; text: string } {
  let text: string
  if (facts.exposure === 'not-dispatched') {
    text = facts.stale
      ? 'This session changed before the account switch was committed. The exposure was not requested.'
      : 'Account switch preparation failed; the switch was not confirmed. Preparation may have started account services.'
  } else if (facts.exposure === 'unconfirmed') {
    text = 'The conversation exposure may have completed; its result is unconfirmed. Inspect the conversation and selected account before another attempt.'
  } else {
    text = 'The conversation is available to the target account. '
    text += facts.metadataRequested
      ? 'The node account update was requested; durable persistence is not confirmed. '
      : 'The node account update was not requested. '
    text += facts.restart === 'restarted'
      ? 'The restart step completed; conversation resumption is not verified.'
      : facts.stale
        ? 'The session changed, so its restart was not requested.'
        : facts.restart === 'not-requested' || facts.restart === 'not-eligible'
          ? 'The pane restart was not completed.'
          : 'The pane restart outcome is unconfirmed; inspect the terminal before another attempt.'
  }
  if (facts.finish === 'unconfirmed') text += ' Switch finalization was not confirmed; the exposure remains.'
  if (facts.cleanupFailed) text += ' Reservation cleanup was not confirmed.'
  return { kind: facts.restart === 'restarted' && !facts.failed && !facts.cleanupFailed ? 'info' : 'error', text }
}
