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
      ? 'This session changed before the account switch was applied. Sharing the conversation with the other account was not requested.'
      : 'The account switch could not be prepared. Check the selected account and terminal before trying again.'
  } else if (facts.exposure === 'unconfirmed') {
    text = 'The conversation may already be available to the other account. Check both accounts and the terminal before trying again.'
  } else {
    text = 'The conversation is available to the other account. '
    text += facts.metadataRequested
      ? 'An account selection update was requested. '
      : 'This switch did not request an account update. '
    text += facts.restart === 'restarted'
      ? 'A restart was requested. Check that the terminal has resumed the right conversation.'
      : facts.stale
        ? 'The session changed, so this switch did not request a restart.'
        : facts.restart === 'not-requested'
          ? 'This switch did not request a restart.'
          : 'The terminal restart was not confirmed. Check the selected account and terminal before trying again.'
  }
  if (facts.finish === 'unconfirmed') text += ' The switch could not be confirmed as finished.'
  if (facts.cleanupFailed) text += ' The switch may still be pending.'
  return { kind: facts.restart === 'restarted' && !facts.failed && !facts.cleanupFailed ? 'info' : 'error', text }
}
