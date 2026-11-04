// "Switch Claude account" on a RUNNING node: move the conversation onto another account the user
// has already logged into, with no `/login` in the pane. The Claude counterpart of the Codex switch
// (`codex-account-ops.ts`), and much simpler: Claude's account IS its config dir, and a transcript
// carries no account identity, so the whole switch is
//
//   1. quit the CLI (the ordinary "Restart agent and shell" exit — refused while busy/blocked),
//   2. copy the transcript into the target account's dir (core `claudeAccounts.copySession`),
//   3. rebind the node's `accountId`, and
//   4. recycle the tmux session, whose respawn gets the new CLAUDE_CONFIG_DIR and whose cold-restore
//      auto-resume runs `claude --resume <same id>` under it.
//
// An SSH project's node switches the same way between the accounts pinned to ITS host; step 2 then
// runs on the host (`claudeAccounts.copySession` with the project's ctx).
//
// This file is the renderer's own fail-closed refusal of what cannot work; core re-checks the target.

import { settleRestart, type RestartOutcome } from '../terminal/agent-restart'
import type { ClaudeAccount, ClaudeSessionCopyResult } from '@shared/types'
import { sshHostKey, type SshServer } from '@shared/ssh'

/**
 * Accounts a node can be switched onto: settled ones on the node's OWN machine — local (managed or
 * linked) for a local node, the accounts pinned to its host for an SSH node (`hostKey` =
 * `sshHostKey`). An account on another machine has no dir where the pane runs.
 */
export function claudeSwitchTargets(
  accounts: readonly ClaudeAccount[],
  hostKey?: string
): ClaudeAccount[] {
  return accounts.filter((a) => !a.pending && (hostKey ? a.host === hostKey : !a.host))
}

export interface ClaudeSwitchNode {
  agentId?: string
  /** The account the node was launched under (`data.accountId`; undefined = system). */
  accountId?: string
  /** Where its transcript actually lives — `effectiveAccountId(...)`, the same id its readers use. */
  readAccountId?: string
  /** An SSH project's node: the `sshHostKey` of the host its pane runs on. */
  hostKey?: string
  /** A session this canvas cannot switch: a relay tab (another core's accounts), or a remote node
   *  whose host could not be identified. */
  remote: boolean
  sessionId?: string
}

export interface ClaudeSwitchPlan {
  sessionId: string
  sourceAccountId: string | undefined
  targetAccountId: string | undefined
}

export type ClaudeSwitchDecision =
  | { ok: true; plan: ClaudeSwitchPlan }
  | { ok: false; reason: 'not-claude' | 'remote' | 'no-session' | 'same-account' | 'unavailable' }

export function planClaudeAccountSwitch(
  node: ClaudeSwitchNode,
  targetAccountId: string | undefined,
  accounts: readonly ClaudeAccount[]
): ClaudeSwitchDecision {
  // The builtin only: `boundAccountId` (shared/agents/account-binding.ts) never binds an account to
  // any other agent — a custom agent on the claude harness included — so neither may a switch.
  if (node.agentId !== 'claude') return { ok: false, reason: 'not-claude' }
  if (node.remote) return { ok: false, reason: 'remote' }
  const target = targetAccountId || undefined
  if (target === (node.accountId || undefined)) return { ok: false, reason: 'same-account' }
  // Never substitute: a target that is gone, pending or on another host is refused, not swapped for
  // the system account.
  if (target !== undefined && !claudeSwitchTargets(accounts, node.hostKey).some((a) => a.id === target))
    return { ok: false, reason: 'unavailable' }
  if (!node.sessionId) return { ok: false, reason: 'no-session' }
  return {
    ok: true,
    plan: {
      sessionId: node.sessionId,
      sourceAccountId: node.readAccountId || node.accountId || undefined,
      targetAccountId: target
    }
  }
}

/** A copy refusal is not a receipt for a resumed conversation. */
export function copyRefusalText(reason: string, targetLabel: string): string {
  const why =
    reason === 'diverged'
      ? `${targetLabel} already holds a different copy of this conversation`
      : reason === 'no-transcript'
        ? 'its transcript could not be found'
        : reason === 'unknown-account'
          ? `${targetLabel} is no longer available`
          : 'the transcript could not be copied'
  return `Could not move this conversation to ${targetLabel} — ${why}. The copy may be incomplete; inspect both accounts. Conversation resumption is not verified.`
}

/** The `sshHostKey` of the host an SSH project's node runs on, or undefined for a local node (and
 *  for a remote node carrying no `data.ssh`, which the caller then refuses as unswitchable). */
export function claudeSwitchHostKey(
  n: { data: Record<string, unknown> } | undefined
): string | undefined {
  const ssh = n?.data.ssh as SshServer | undefined
  return ssh ? sshHostKey(ssh) : undefined
}

/**
 * What one switch did — returned rather than announced, so the single switch (one notice) and the
 * bulk move (one summary for N nodes) share the choreography and differ only in what they say.
 */
export type ClaudeSwitchOutcome =
  | { kind: 'switched'; saveUnconfirmed?: boolean }
  | { kind: 'same-account' }
  | {
      kind: 'refused'
      reason: 'not-claude' | 'remote' | 'no-session' | 'unavailable' | 'no-connection' | 'not-attached'
    }
  /** Restart did not complete; copy facts survive later failures. */
  | { kind: 'not-restarted'; outcome: 'exit-timeout' | 'not-eligible'; copy?: 'not-requested' | 'unconfirmed' | 'confirmed' }
  /** The renderer restart leg completed without an acknowledged copy. */
  | { kind: 'copy-failed'; reason: string }

/** The single-switch notice (null = say nothing: a no-op same-account pick). */
export function switchOutcomeNotice(
  o: ClaudeSwitchOutcome,
  targetLabel: string
): { kind: 'info' | 'error'; text: string } | null {
  switch (o.kind) {
    case 'switched':
      return { kind: o.saveUnconfirmed ? 'error' : 'info', text: `Conversation copied to ${targetLabel}; account update requested and restart step completed. Conversation resumption is not verified.${o.saveUnconfirmed ? ' Saving the account selection was not confirmed.' : ''}` }
    case 'same-account':
      return null
    case 'copy-failed':
      return { kind: 'error', text: copyRefusalText(o.reason, targetLabel) }
    case 'not-restarted':
      return {
        kind: 'error',
        text: (o.copy === 'confirmed'
          ? `The conversation was copied to ${targetLabel}; that copy remains available. `
          : o.copy === 'not-requested'
            ? 'The transcript copy was not requested. '
            : 'The transcript copy outcome is unconfirmed; a partial copy may remain. ') +
          'The pane restart did not complete; inspect the terminal before another attempt.'
      }
    case 'refused':
      return {
        kind: 'error',
        text:
          o.reason === 'no-session'
            ? 'This session has no resumable conversation id yet — nothing to switch.'
            : o.reason === 'remote' || o.reason === 'not-claude'
              ? 'Switching accounts is not available for this session.'
              : o.reason === 'no-connection'
                ? 'This host is not connected — reconnect the project, then switch. Nothing was changed.'
                : o.reason === 'not-attached'
                  ? 'Switch skipped: this terminal is not attached right now.'
                  : `${targetLabel} is no longer available. Nothing was changed.`
      }
  }
}

/** A live canvas node, as the bulk move needs to see it. */
export interface BulkSwitchNode {
  id: string
  agentId?: string
  /** `data.accountId` (undefined = the system account). */
  accountId?: string
  /** `claudeSwitchHostKey` — the machine the pane runs on (undefined = this one). */
  hostKey?: string
  /** The live agent state: a `working`/`blocked` session is skipped, never interrupted. */
  busy: boolean
}

/**
 * The Claude sessions on `from` (undefined = the system account) that live on the scoped machine
 * — the set "Move N sessions" counts and the bulk move walks, in canvas order. `busy` ones are
 * listed separately: they are counted (so the number the user saw is the number accounted for) but
 * never switched, because a switch types `/exit`, which a permission prompt would take as an answer.
 */
export function bulkSwitchCandidates(
  nodes: readonly BulkSwitchNode[],
  from: string | undefined,
  scopeHostKey: string | undefined
): { ready: BulkSwitchNode[]; busy: BulkSwitchNode[] } {
  const on = nodes.filter(
    (n) =>
      n.agentId === 'claude' &&
      (n.accountId || undefined) === (from || undefined) &&
      (n.hostKey || undefined) === (scopeHostKey || undefined)
  )
  return { ready: on.filter((n) => !n.busy), busy: on.filter((n) => n.busy) }
}

/**
 * Run a bulk move's switches ALL AT ONCE, and come back with every outcome (a rejection reads as
 * `undefined`, which the caller counts as skipped — it never swallows the others).
 *
 * Each switch waits seconds for its CLI to quit, so awaiting them one after another made N sessions
 * cost N exits in a row — visibly one pane at a time. Worse, a switch reads its node off the live
 * canvas when it STARTS: a project switch mid-run unmounted every node still waiting its turn, and
 * each was then refused as "not attached" — the move stopped halfway. Starting them together means
 * every node is read while it is on the canvas; `settleRecycledNode` covers the one that finishes
 * after the user has left. Load on an SSH host is paced in core, not here: every exec child rides
 * the ControlMaster's `SshChildGate`, and the respawns ride the pty spawn gate.
 */
export function startBulkSwitch<T>(
  ids: readonly string[],
  run: (id: string) => Promise<T>
): Promise<(T | undefined)[]> {
  return Promise.all(ids.map((id) => run(id).catch((): undefined => undefined)))
}

/** One line retaining exposure facts separately from restart and refusal outcomes. */
export function summarizeBulkSwitch(
  outcomes: readonly ClaudeSwitchOutcome[],
  busySkipped: number,
  targetLabel: string
): { kind: 'info' | 'error'; text: string } {
  const completed = outcomes.filter((o) => o.kind === 'switched').length
  const retained = outcomes.filter((o) => o.kind === 'not-restarted' && o.copy === 'confirmed').length
  const uncertain = outcomes.filter((o) => o.kind === 'copy-failed' ||
    (o.kind === 'not-restarted' && o.copy !== 'confirmed' && o.copy !== 'not-requested')).length
  const incomplete = outcomes.filter((o) => o.kind === 'not-restarted' && o.copy === 'not-requested').length
  const unsaved = outcomes.filter((o) => o.kind === 'switched' && o.saveUnconfirmed).length
  const refused = busySkipped + outcomes.filter((o) => o.kind === 'refused').length
  const parts = [`${completed} copied to ${targetLabel} with account update requested and restart step completed`]
  if (retained) parts.push(`${retained} copies retained with restart incomplete`)
  if (uncertain) parts.push(`${uncertain} copy outcomes unconfirmed (partial copies may remain)`)
  if (incomplete) parts.push(`${incomplete} restarts incomplete before copy`)
  if (unsaved) parts.push(`${unsaved} account saves unconfirmed`)
  if (refused) parts.push(`${refused} refused before switch dispatch`)
  return { kind: retained || uncertain || incomplete || refused || unsaved ? 'error' : 'info',
    text: `${parts.join(' · ')}. Conversation resumption is not verified.` }
}

/** Existing quit/copy/recycle choreography, with copy facts retained across restart failure. */
export async function runClaudeSwitch(deps: {
  copy: () => Promise<ClaudeSessionCopyResult>
  restart: (beforeRecycle: () => Promise<{ accountId: string | undefined } | undefined>) => Promise<RestartOutcome>
  targetAccountId: string | undefined
  markDirty: () => void
}): Promise<ClaudeSwitchOutcome> {
  let copy: 'not-requested' | 'unconfirmed' | 'confirmed' = 'not-requested'
  let reason = 'failed'
  const outcome = await settleRestart(() => deps.restart(async () => {
    copy = 'unconfirmed'
    const result = await deps.copy().catch((): ClaudeSessionCopyResult => ({ ok: false, reason: 'failed' }))
    if (!result.ok) { reason = result.reason; return }
    copy = 'confirmed'
    return { accountId: deps.targetAccountId }
  }))
  // TypeScript cannot observe assignments made by the awaited callback.
  const observed = copy as 'not-requested' | 'unconfirmed' | 'confirmed'
  let saveUnconfirmed = false
  if (observed === 'confirmed') {
    try { deps.markDirty() } catch { saveUnconfirmed = true }
  }
  if (outcome !== 'restarted') return {
    kind: 'not-restarted', outcome: outcome === 'host-unsupported' ? 'not-eligible' : outcome, copy: observed
  }
  return observed === 'confirmed' ? { kind: 'switched', ...(saveUnconfirmed ? { saveUnconfirmed } : {}) } : { kind: 'copy-failed', reason }
}
