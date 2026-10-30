import type { ControlVerb } from './control-verb'

export type ControlEdition = 'desktop' | 'server'
export type ControlSupport = 'supported' | 'partial' | 'unsupported'

// Support is deliberately independent of authorization. The host still checks identity,
// project ownership, backend availability and human consent when a command executes.
export const CONTROL_SUPPORT = {
  capabilities: 'supported',
  list: 'supported',
  'open-terminal': 'partial',
  'open-claude': 'partial',
  'open-agent': 'partial',
  'show-image': 'partial',
  'show-video': 'partial',
  'show-web': 'partial',
  'open-browser': 'unsupported',
  group: 'supported',
  ungroup: 'supported',
  move: 'supported',
  arrange: 'supported',
  align: 'supported',
  resize: 'supported',
  place: 'supported',
  link: 'supported',
  verify: 'partial',
  'spawn-team': 'partial',
  'open-worktree': 'partial',
  'close-worktree': 'partial',
  branch: 'partial',
  rename: 'partial',
  color: 'supported',
  write: 'partial',
  close: 'partial',
  run: 'partial',
  board: 'partial',
  assign: 'supported',
  send: 'supported',
  reply: 'supported',
  notify: 'supported',
  sticky: 'supported',
  browser: 'unsupported',
  'open-project': 'partial',
  settings: 'partial',
  'report-issue': 'supported',
  'report-outcome': 'supported',
  issues: 'partial',
  prs: 'partial'
} as const satisfies Record<ControlVerb, ControlSupport>

export type ServerControlVerb = {
  [V in ControlVerb]: typeof CONTROL_SUPPORT[V] extends 'unsupported' ? never : V
}[ControlVerb]

const SERVER_LIMITATIONS: Partial<Record<ServerControlVerb, string>> = {
  branch: 'Verified idle local POSIX tmux Claude panes within operator scope; cannot branch the caller. Requires individual owner approval, a readable original transcript and a proven new session. Uncertain input must never be repeated.',
  write: 'Local verified idle Claude panes with an empty composer, within operator scope. Requires an attached owner and individual confirmation; uncertain input must never be resent.',
  'show-web': 'External HTTP(S) URLs use a sandboxed iframe; static local HTML requires a distinct configured HTTPS preview hostname. Local scripts and network resource loads are disabled.',
  'show-video': 'Local audio/video files; authenticated owner streaming with browser-dependent codec support. No SSH fallback.',
  'open-worktree': 'Local projects only; prepares shared paths and successful trust-gated setup before binding.',
  'close-worktree': 'Unbind keeps an existing checkout; removal requires owner confirmation and missing checkouts require recovery.',
  verify: 'Local Claude, Codex and Gemini reviewers; automatic release requires verified current-session state.',
  'spawn-team': 'Local Claude, Codex and Gemini members; all roles are validated before creation.',
  'open-claude': 'Claude alias of open-agent; the same supported launch flags and local backend limits apply.',
  'show-image': 'Existing local images supported by the editor preview; no SSH filesystem fallback.',
  board: 'Reads only the caller project; creator scope shows the caller and its created cards.',
  'open-project': 'Only an exact, already registered local project can be opened.',
  'open-terminal': 'Local persistent sessions only; the host validates supported launch flags.',
  'open-agent': 'Local persistent sessions only; the host validates supported launch flags.',
  rename: 'Changes canvas metadata; does not type a rename command into the session.',
  close: 'Cannot close the caller; busy sessions require an explicit force in project scope.',
  run: 'Local retained launches only.',
  settings: 'Own local project and allowlisted canvas settings; every change requires an attached owner UI and individual confirmation.',
  issues: 'Reads only the caller project GitHub cache.',
  prs: 'Reads only the caller project GitHub cache.'
}

export interface ControlCapabilityReport {
  version: 1
  /** The owner UI can recover host-owned queued launches through the host scheduler. */
  hostLaunches?: true
  edition: ControlEdition
  enabled: boolean
  /** Describes implementation, never a grant to execute. */
  verbs: Array<{ verb: ControlVerb; support: ControlSupport; limitation?: string }>
}

export function serverSupportsControl(verb: string): verb is ServerControlVerb {
  return Object.hasOwn(CONTROL_SUPPORT, verb) &&
    CONTROL_SUPPORT[verb as ControlVerb] !== 'unsupported'
}

export function controlCapabilities(edition: ControlEdition, enabled: boolean): ControlCapabilityReport {
  return {
    version: 1,
    hostLaunches: true,
    edition,
    enabled,
    verbs: (Object.keys(CONTROL_SUPPORT) as ControlVerb[]).map((verb) => ({
      verb,
      support: edition === 'desktop' && verb !== 'branch' ? 'supported' : CONTROL_SUPPORT[verb],
      ...((edition === 'server' || verb === 'branch') && serverSupportsControl(verb) && SERVER_LIMITATIONS[verb]
        ? { limitation: SERVER_LIMITATIONS[verb] } : {})
    }))
  }
}

export function controlCapabilitiesText(report: ControlCapabilityReport): string {
  return [
    `${report.edition} canvas control: ${report.enabled ? 'enabled' : 'disabled'}. Support is not authorization.`,
    ...report.verbs.map(({ verb, support, limitation }) =>
      `${verb}: ${support}${limitation ? ` — ${limitation}` : ''}`)
  ].join('\n')
}
