/**
 * The one-time clone notice, decided ONCE for every capability — pure, shared, and the only
 * decider either feature may use (browser control here in PR 3; agent messaging adopts it in its
 * PR 6 without reimplementing anything).
 *
 * A switch that arrives from a clone is not the same thing as a switch the user set:
 * `.nodeterm/project.json` is git-shared and hand-editable, so `agentBrowserControl: true` in a
 * freshly cloned repo is a stranger's decision until this machine's user has seen it. The
 * acknowledgment is therefore recorded MACHINE-LOCALLY (`IndexEntryV3.capabilityAck` — the index
 * entry is the only authority for project identity), never in the shared file; a second worktree
 * of the same repo is a second entry, hence a second notice, on purpose.
 *
 * THE ACK CARRIES THE ANSWER, not just the fact of one (PR #213 review, C1). "Turn it off" can
 * only delete the field from THIS working copy — the hostile `true` survives in git and a routine
 * `git checkout`/pull restores it. If the ack were a bare bit, that restored `true` would meet a
 * standing acknowledgment and grant silently to a user who explicitly said no. So:
 *   - `'kept'`     — explicit consent; enabled+kept is the ONE granting combination.
 *   - `'declined'` — explicit refusal; if the file's `true` ever re-arrives it is refused AND a
 *                    NEW notice is raised (never silence, never a grant without a fresh "keep").
 *   - absent       — never answered (or dismissed without answering — dismissal is not an answer);
 *                    enabled+absent is a pending notice and a refusal.
 * Each rule is pinned by `project-capability-consent.test.ts`.
 *
 * Lives in `src/shared` for the same reason as `safe-id.ts`: the renderer raises the dialog and may
 * not import `src/core`; `core/project-capability-consent.ts` re-exports these for main/core
 * callers, and its test pins that the two paths are the same function objects.
 */
import {
  capabilityHasMachineDefault,
  capabilityMachineDefault,
  projectCapabilityFileState,
  type CapabilityMachineDefaults,
  type ProjectCapability
} from './project-capabilities'

/** What this machine's user answered when told about a capability switch. */
export type CapabilityAnswer = 'kept' | 'declined'

/** The machine-local answer record, keyed like the capability fields but never written to the
 *  shared project file (`projectToFile` does not know this shape exists — pinned by the consent
 *  test with an ack-carrying project as input). */
export type CapabilityAckMap = Partial<Record<ProjectCapability, CapabilityAnswer>>

/** Apply an explicit human answer through the same setter on UI and host command paths. */
export function setProjectCapability<P extends Partial<Record<ProjectCapability, boolean>> & { capabilityAck?: CapabilityAckMap }>(
  project: P, cap: ProjectCapability, on: boolean
): P {
  if (on) return recordCapabilityAck({ ...project, [cap]: true }, cap, 'kept')
  const next = { ...project }
  if (capabilityHasMachineDefault(cap)) next[cap] = false
  else delete next[cap]
  return recordCapabilityAck(next, cap, 'declined')
}

export interface CapabilityConsentState {
  capability: ProjectCapability
  /** The strict read of the shared file's switch (`projectCapabilityFlagInFile` — literal true
   *  only). NEVER a grant by itself. */
  enabledInFile: boolean
  /** This machine's recorded answer for this project entry, if any. */
  answer: CapabilityAnswer | undefined
}

/** On in the file + not explicitly KEPT on this machine ⇒ notice. That covers both the
 *  never-answered clone window and the re-arrival of a `true` the user declined (C1): a recorded
 *  "no" makes a re-appearing switch a NEW event to be told about, not a settled one. Off needs no
 *  warning, whatever was answered. */
export function needsCapabilityNotice(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && s.answer !== 'kept'
}

/**
 * May the capability act RIGHT NOW? Only `enabledInFile && answer === 'kept'`: a pending notice is
 * a refusal, and a recorded DECLINE is a refusal even when the hostile `true` re-arrives via git
 * (`project-capability-consent.test.ts` — "a switch that is on but unanswered grants nothing",
 * "a DECLINED switch grants nothing even when the file says true again"). This is the predicate
 * the browser ledger's admission check (PR 4) and messaging's `messagingEnabled` wiring (PR 6)
 * consult per call — never cached at lease start.
 */
export function projectCapabilityGranted(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && s.answer === 'kept'
}

/** Where an effective capability value came from — for display, never for a grant decision. */
export type CapabilitySource = 'project' | 'default'

export interface CapabilityEffective {
  /** THE grant. */
  on: boolean
  /** `project` = the file carries an explicit value (or this machine declined it); `default` = the
   *  file says nothing and this machine's setting answered. */
  source: CapabilitySource
  /** The file says `true` but this machine has not KEPT it: off, and the clone notice is owed. */
  pendingNotice: boolean
}

/**
 * The whole grant rule, ONCE — every consumer reads it through here or `projectCapabilityGrantedFor`
 * so no consumer invents its own default:
 *   - file `true`  → granted only with this machine's `'kept'` (unchanged: a clone's `true` notices)
 *   - file `false` → off, whatever the default (the explicit value always wins)
 *   - absent       → a recorded `'declined'` keeps it off (the pre-default builds wrote "off" as a
 *                    deleted field + decline); otherwise the MACHINE-LOCAL default answers, and only
 *                    for a capability that has one (`CAPABILITY_MACHINE_DEFAULTS`).
 * `needsCapabilityNotice` is deliberately untouched: it stays keyed on an EXPLICIT `true`, so a
 * project that is on only by this machine's default never raises a notice (nothing arrived from a
 * stranger) while a cloned `true` always does. Pinned by project-capability-consent.test.ts.
 */
export function projectCapabilityEffective(
  p:
    | (Partial<Record<ProjectCapability, unknown>> & { capabilityAck?: CapabilityAckMap })
    | undefined
    | null,
  cap: ProjectCapability,
  defaults: CapabilityMachineDefaults
): CapabilityEffective {
  const file = projectCapabilityFileState(p, cap)
  const answer = capabilityAnswerOf(p, cap)
  if (file === 'on') {
    const on = projectCapabilityGranted({ capability: cap, enabledInFile: true, answer })
    return { on, source: 'project', pendingNotice: !on }
  }
  if (file === 'off' || !capabilityHasMachineDefault(cap) || answer === 'declined') {
    return { on: false, source: 'project', pendingNotice: false }
  }
  return { on: capabilityMachineDefault(defaults, cap), source: 'default', pendingNotice: false }
}

/**
 * THE consumer-facing grant check: derives every half (the file's value, this machine's
 * own-property answer, this machine's default) from a Project-shaped object and the settings, so a
 * consumer cannot pick the raw file flag by mistake (PR #213 review, I2). `defaults` is REQUIRED —
 * a consumer that forgot the machine default must fail to compile, not silently read it as off
 * while every other surface reads it as on.
 */
export function projectCapabilityGrantedFor(
  p:
    | (Partial<Record<ProjectCapability, unknown>> & { capabilityAck?: CapabilityAckMap })
    | undefined
    | null,
  cap: ProjectCapability,
  defaults: CapabilityMachineDefaults
): boolean {
  return projectCapabilityEffective(p, cap, defaults).on
}

/** This machine's recorded answer, own properties only (M-1: an in-process object must not inherit
 *  consent through its prototype; JSON never produces one, but callers are not only JSON). */
export function capabilityAnswerOf(
  p: { capabilityAck?: CapabilityAckMap } | undefined | null,
  cap: ProjectCapability
): CapabilityAnswer | undefined {
  const ack = p?.capabilityAck
  if (!ack || !Object.prototype.hasOwnProperty.call(ack, cap)) return undefined
  const v = ack[cap]
  return v === 'kept' || v === 'declined' ? v : undefined
}

/**
 * Returns `entry` with the capability answered — a new object, input untouched; a later answer
 * overwrites an earlier one (decline → later explicit keep must win, and vice versa). Works on any
 * entry-shaped record (`IndexEntryV3` in main, the renderer's `Project` mirror of the same
 * machine-local field) so both sides record the answer through the one function.
 */
export function recordCapabilityAck<E extends { capabilityAck?: CapabilityAckMap }>(
  entry: E,
  cap: ProjectCapability,
  answer: CapabilityAnswer
): E {
  return { ...entry, capabilityAck: { ...entry.capabilityAck, [cap]: answer } }
}
