import { mediaMime, VIDEO_NODE_SIZE, videoNodeData } from '../shared/media'
import { matchesMediaSignature } from './media-references'
import { externalPreviewUrl, webNodeData, WEB_NODE_SIZE } from '../shared/web-preview'
import type { WebPreviews } from './web-previews'
import type { TextDeliveryResult } from '../shared/text-delivery'
import { isBusyAgentState, parseForceFlag, type ControlScope } from '../shared/control-scope'
import { isLaunchShell } from '../shared/agents/pane'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { expandHomePath } from './fs-handlers'
import { FS_READ_BINARY_MAX_BYTES } from '../shared/fsLimits'
import { editorNodeData, EDITOR_NODE_SIZE } from '../shared/editor-node'
import { isImagePath } from '../shared/image-preview'
import { NODE_MIN_SIZES } from '../shared/node-sizing'

import { CanvasContentWriter, type NodePatch, type PatchSave } from './canvas-content-writer'
import { platform } from './platform'
import { saveUpload } from './uploads'
import { claudeConfigDirFor } from './claude-config-dir'
import { codexHomeForAccount } from './codex-accounts-core'
import { agentAccountColor } from '../shared/agents/account-color'
import { parseTeamSpec } from '../shared/team-spec'
import { planIndependentTeam, planVerification, type PlannedTeamRole } from '../shared/team-plan'
import { launchPromptFor } from '../shared/prompt-spill'
import { arrangeNodes, fitAncestorChain as fitGeometryAncestors } from '../shared/canvas-geometry'
import { coldGroupCwd, coldResolveGroup, groupSlot, groupSizeFor } from '../shared/cold-open'
import { placeBelowSource } from '../shared/placement'
import { dryRunRequested } from '../shared/control-verbs'
import { waitRopeId } from '../shared/canvas-lineage'
import { LOCAL_HEADLESS_AGENTS } from '../shared/headless-agents'
import { LAUNCH_CLAIM_LEDGER_MAX } from './launch-claim-ledger'
import { projectLaunchOverride } from '../shared/project-launch-policy'
import type { ProjectLaunchInfo } from '../shared/project-settings'
import { worktreeControl, type WorktreeControlBackend } from './worktree-control'
import { planGeometryCommand, type GeometryControlVerb } from '../shared/geometry-command'
import { applyStoredGeometry, storedGeometryNodes, wrapStoredNodes } from '../shared/stored-canvas-geometry'
import { stableStringify } from '../shared/canvas-mutations'
import { boardCard } from '../shared/board-card'
import { boardVerbReply } from '../shared/board-verb'
import { planBoardAssignment } from '../shared/board-assignment'
import { boardLogEvents } from '../shared/board-log-diff'
import { groupsFirst } from '../shared/node-order'
import { launchHeadless } from './headless-launch'
import { gateProjectTarget, GRANT_CAP } from './project-grants'
import {
  LINK_ENDPOINT_NOT_FOUND,
  LINK_PROJECT_ONLY,
  planBridges,
  type LinkEndpoint
} from '../shared/canvas-link'
import {
  invalidNodeColorMessage,
  resolveNodeColor,
  SYSTEM_NODE_COLORS,
  type NodeColor
} from '../shared/node-colors'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef } from '../shared/sticky-write'
import type { HeadlessLaunchFailure, HeadlessLaunchResult, HostLaunchReply } from '../shared/headless-launch'
import { localNodePtyOptions } from '../shared/node-pty-options'
import type { WorkspaceStore } from './workspace-store'
import {
  AGENT_CONFIG,
  canContextLink,
  canControlCanvas,
  gatePermissionMode,
  hasHooks,
  resolvePermissionMode,
  supportsSessionIdFlag,
  type AgentId,
  type BuiltinAgentId
} from '../shared/agents/config'
import { assembleLaunchCommand, assembleResumeCommand } from '../shared/agents/launch'
import { isClaudeBranchSessionId } from './claude-branch'
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'
import { oneLine } from '../shared/one-line'
import { rootPositionWith } from '../shared/root-position'
import { RUN_NOW_AFTER_REFUSAL, runNowRequested } from '../shared/control-verbs'
import {
  RUN_NOW_AFTER_SUCCESS_REFUSAL,
  normalizeSuccessWaitHold,
  parseAfterSuccessArg,
  parseSuccessDeadlineArg,
  successDepRefusal,
  successWaitSatisfied,
  type StationOutcomeRecord,
  type SuccessDepFacts,
  type SuccessWaitHold
} from '../shared/station-outcome'
import { isRemoteSessionNode } from '../shared/worktree'
import { issueLaunchPrompt, resolveIssueArg, type IssueRef } from '../shared/github-issue-ref'
import { runEndedEvent, runStartedEvent } from '../shared/issue-runs'
import type { BoardLogEntry } from '../shared/types'
import { controlListingText, storedNodeListing } from '../shared/control-listing'
import { listGeometryRequested } from '../shared/geometry-verbs'
import type { StationHandoverRecord } from '../shared/station-handover'
import type { StationOutcomeRecord as ListedOutcome } from '../shared/station-outcome'
import { UNKNOWN_CODEX_CLI_CAPS } from '../shared/types'
import type {
  BridgeLink,
  CanvasMutation,
  CanvasNodeState,
  ClaudeCliCaps,
  CodexCliCaps,
  GrokCliCaps,
  Project,
  PtyCreateOptions,
  PtyCreateResult,
  Settings,
  Workspace
} from '../shared/types'
import {
  NODE_SIZE_MAX,
  STICKY_NODE_MIN_SIZE,
  STICKY_NODE_SIZE,
  TERMINAL_NODE_SIZE_MIN,
  resolveDefaultNodeSize
} from '../shared/default-node-size'

export interface ServerControlReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
}

/** The PtyManager surface the headless factory uses, kept narrow for deterministic tests. */
export interface HeadlessPty {
  createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult>
  /** Probe only. Boot reconciliation must never turn absence into a fresh session. */
  paneCommand(persistKey: string): Promise<string | null>
  sessionExists(persistKey: string): Promise<boolean>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<TextDeliveryResult>
  persistentSpawnAvailable(): boolean
  writeHeadless(persistKey: string, data: string): boolean
  onOutput(persistKey: string, cb: (chunk: string) => void): () => void
  releaseHeadless(persistKey: string): void
  destroySession(
    clientId: number | null,
    persistKey: string,
    opts?: { everySocket?: boolean }
  ): Promise<void>
}

/** WorkspaceStore's mutation surface, also narrow so tests can use the real store or a fake. */
export type HeadlessWorkspace = Pick<WorkspaceStore, 'load' | 'save'>

export interface HeadlessNodeFactoryDeps {
  /** Which nodes a caller may read and act on (control-scope.ts). Absent = `creator`. */
  controlScope?: ControlScope
  workspaceStore: HeadlessWorkspace
  ptyManager: HeadlessPty
  settings(): Settings
  cliCaps(): Promise<ClaudeCliCaps>
  /**
   * grok's OWN `--session-id` probe. Separate from `cliCaps` because the two CLIs are installed and
   * upgraded independently, so claude's answer is not evidence about grok (CLAUDE.md rule 9: a gate
   * fed by a version probe belongs to the agent it probes). Wired even though `SERVER_AGENTS` does
   * not yet include grok: `supportsSessionIdFlag`'s third argument is required precisely so a caller
   * cannot forget the probe and silently get "grok never mints", and a hard-coded `false` here would
   * be that forgotten probe, waiting for the day grok joins the set.
   */
  grokCaps(): Promise<GrokCliCaps>
  /**
   * codex's OWN `--help` probe, and separate from `cliCaps`/`grokCaps` for the same reason they are
   * separate from each other. It answers which values this host's `codex` accepts for
   * `--ask-for-approval`: the set changed between releases (`untrusted` was removed in 0.149.0) and
   * clap EXITS on a value it does not know, so a launch line built from a table rather than from
   * the binary is a dead session, not a degraded one — issue #785.
   */
  codexCaps(): Promise<CodexCliCaps>
  /** Whether this host's Codex launcher + shared app-server identity spine are ready. */
  codexSharedIdentity(): Promise<boolean>
  /** Hook-mirror lookups. A stored agentId wins; these cover a plain terminal running an agent. */
  stateOf(nodeId: string): AgentState | undefined
  agentIdOf?(nodeId: string): string | undefined
  stateVerified?(nodeId: string): boolean
  sessionOf?(nodeId: string): string | undefined
  contextShimPath?(): string
  projectLaunchInfo?(projectId: string): Promise<ProjectLaunchInfo | null>
  requestAgentsTrust?(projectId: string): unknown
  worktrees?: WorktreeControlBackend
  webPreviews?: Pick<WebPreviews, 'readHtml' | 'writeHtml'>
  /** Desktop keeps only backend sessions after a headless operation; Server retains its synthetic client. */
  releaseHeadlessAfterWork?: boolean
  /** A station's latest task report (`report-outcome`, core's store) — what `--after-success` waits
   *  on. Absent = no report is ever known, so a success wait never releases on its own. */
  outcomeOf?(nodeId: string): StationOutcomeRecord | undefined
  /** Has this station been handed new work (a `send` / `reply` queued or landed, a `run`) that no
   *  turn since has finished? core/station-handover.ts — while it has, plain `--after` on it is not
   *  satisfied, whatever its state reads: its `done` is the PREVIOUS task's. Absent = nothing is
   *  ever handed over (the pre-tracker behaviour). */
  handedOver?(nodeId: string): boolean
  /** The same station's hand-over record, for `list` to say WHAT it is held on (new work, or tasks
   *  still running in its background). Absent = `list` names no hand-over wait. */
  handoverOf?(nodeId: string): StationHandoverRecord | undefined
  env?: Record<string, string | undefined>
  now?: () => number
  /**
   * Cast one content op (node, edge or board) to every client. Default: the reflector
   * (`publishCanvasMutation`), whose listener is the canvas authority. Every op is cast BEFORE the
   * save that persists it (`castAndSave`): on a governed project the save is overlaid with the
   * authority's content, which holds only what it heard as ops.
   */
  publishMutation?: (projectId: string, m: CanvasMutation) => void
  /** The whole project, to browsers, on `workspace:server-change` (merged, never a conflict bar). */
  publishProject?: (project: Project) => void
  /** Injectable only so tests can seed creator facts; production uses a fresh process-local ledger. */
  ownership?: HeadlessNodeOwnership
  /** Test seam for the launch settle; production uses core's SETTLE_* defaults. */
  launchTiming?: { quietMs: number; capMs: number }
  /**
   * The `owner/repo` a project's kanban board syncs with — what `open-agent --issue #N` means. The
   * GitHub host controller's answer (configured, else detected from the project's git remote), the
   * same one the issue lane uses. Absent/throwing/null = only the board's explicitly configured
   * repository counts, and a `#N` against a board with none is refused — never guessed.
   */
  issueRepository?: (projectId: string) => Promise<string | null>
  /** Append to a project's board log (the issue card's run history). Absent = no history is
   *  written; the session still opens. */
  appendBoardLog?: (projectId: string, entry: BoardLogEntry) => Promise<boolean>
}

/** The author of a run-history line this factory writes: the app acting on an agent's request. */
const RUN_LOG_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export interface HeadlessNodeOwner {
  sourceNodeId: string
  projectId: string
}

export interface HeadlessNodeOwnership {
  ownerOf(nodeId: string): HeadlessNodeOwner | undefined
  record(nodeId: string, owner: HeadlessNodeOwner): void
  forget(nodeId: string): void
  clear(): void
}

/**
 * Creator proof for Server Edition canvas mutations. Deliberately process-local: after a service
 * restart, a git-shared/hand-editable project file cannot reassert who created a node. Unknown
 * ownership therefore fails closed until this server run records a fresh agent-requested spawn.
 */
export function createHeadlessNodeOwnership(): HeadlessNodeOwnership {
  const owners = new Map<string, HeadlessNodeOwner>()
  return {
    ownerOf: (nodeId) => owners.get(nodeId),
    record: (nodeId, owner) => owners.set(nodeId, owner),
    forget: (nodeId) => owners.delete(nodeId),
    clear: () => owners.clear()
  }
}

/** One node an `open-*` persisted but could not start. */
export interface OpenLaunchFailure {
  id: string
  reason: HeadlessLaunchFailure
  /** The node still holds its launch (manualOnly), so the user's Run now can deliver it. */
  retained: boolean
}

/**
 * The `open-*` failure reply (#925). Each failed node is named with its own reason, grouped, so a
 * caller can tell a failure Run now may get past from one it repeats: `line-too-long` fails the
 * same way on every attempt, and this edition has no `--prompt-file` (the open flag allowlist),
 * so the only way past it is a shorter prompt or command. "Do not repeat the open request" holds
 * for every reason: the nodes are persisted, so the same request would open duplicates.
 */
export function launchFailedError(
  failures: readonly OpenLaunchFailure[],
  verb: 'open-terminal' | 'open-agent' | 'spawn-team' | 'verify'
): string {
  const groups = new Map<string, OpenLaunchFailure & { ids: string[] }>()
  for (const f of failures) {
    const key = `${f.reason}:${f.retained}`
    const group = groups.get(key) ?? { ...f, ids: [] }
    group.ids.push(f.id)
    groups.set(key, group)
  }
  const what = (g: OpenLaunchFailure): string =>
    g.reason === 'account-unavailable' ? 'restore or choose the selected local account before using Run now' :
    g.reason === 'prompt-file-missing' ? 'restore the prompt file before using Run now' : g.reason === 'line-too-long'
      ? 'the launch line is longer than a terminal line takes, so Run now will fail the same way; ' +
        `shorten the ${verb === 'open-terminal' ? 'command' : 'prompt'}`
      : g.retained
        ? 'launch retained for Run now in the node'
        : 'no launch was held'
  const clauses = [...groups.values()].map((g) => `${g.reason}: ${g.ids.join(', ')} (${what(g)})`)
  return (
    `launch-failed: node(s) ${failures.map((f) => f.id).join(', ')} were persisted but their PTY or ` +
    `initial command could not be delivered — ${clauses.join('; ')}; do not repeat the open request`
  )
}

const TERMINAL_LIMIT = 8
const AGENT_LIMIT = 5
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 36
const TERMINAL_SIZE = { width: 640, height: 440 }
const H_GAP = 80
const V_GAP = 36
const SERVER_AGENTS: ReadonlySet<string> = new Set(LOCAL_HEADLESS_AGENTS)

function token(): string {
  return randomBytes(4).toString('hex')
}

function nextId(prefix: 'term' | 'sticky' | 'group' | 'editor' | 'video' | 'web'): string {
  return `${prefix}-${Date.now().toString(36)}-${token()}`
}

function edgeId(prefix: string, source: string, target: string): string {
  return `${prefix}-${source}-${target}-${token()}`
}

function parseCount(raw: string | undefined, max: number): number {
  return Math.max(1, Math.min(max, Number.parseInt(raw || '1', 10) || 1))
}

function terminalSize(settings: Settings): { width: number; height: number } {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    width: clamp(settings.defaultNodeWidth, TERMINAL_NODE_SIZE_MIN.width, NODE_SIZE_MAX.width, TERMINAL_SIZE.width),
    height: clamp(settings.defaultNodeHeight, TERMINAL_NODE_SIZE_MIN.height, NODE_SIZE_MAX.height, TERMINAL_SIZE.height)
  }
}

function unsupportedFlags(
  args: Record<string, string>,
  allowed: ReadonlySet<string>
): string | undefined {
  const unknown = Object.keys(args).find((key) => !allowed.has(key))
  return unknown ? `--${unknown} is not supported by Server Edition canvas control` : undefined
}

function sourceProject(workspace: Workspace, nodeId: string): { project: Project; node: CanvasNodeState } | null {
  const matches: Array<{ project: Project; node: CanvasNodeState }> = []
  for (const project of workspace.projects) {
    const node = project.nodes.find((candidate) => candidate.id === nodeId)
    if (node) matches.push({ project, node })
  }
  return matches.length === 1 ? matches[0] : null
}

function effectiveAgentId(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): AgentId | undefined {
  const id = node.agentId || runtimeAgentId?.(node.id)
  return id ? (id as AgentId) : undefined
}

function sourceCanControl(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): boolean {
  const agentId = effectiveAgentId(node, runtimeAgentId)
  return !!agentId && canControlCanvas(agentId)
}

function placeRight(
  project: Project,
  source: CanvasNodeState,
  size: { width: number; height: number },
  reserved: readonly CanvasNodeState[] = []
): { x: number; y: number } {
  const origin = rootPosition(project.nodes, source)
  const sourceWidth = source.size?.width || TERMINAL_SIZE.width
  const occupied = [...project.nodes, ...reserved].map((node) => {
    const position = rootPosition(project.nodes, node)
    return {
      x: position.x,
      y: position.y,
      width: Math.max(1, node.size?.width || TERMINAL_SIZE.width),
      height: Math.max(1, node.size?.height || TERMINAL_SIZE.height)
    }
  })

  // Keep the existing compact three-row grid, but scan it rather than assuming this request's
  // local index is globally free. Repeated requests therefore continue into the first available
  // row/column instead of returning to slot zero and stacking nodes on top of one another.
  for (let slot = 0; ; slot++) {
    const column = Math.floor(slot / 3)
    const row = slot % 3
    const candidate = {
      x: origin.x + sourceWidth + H_GAP + column * (size.width + H_GAP),
      y: origin.y + row * (size.height + V_GAP),
      width: size.width,
      height: size.height
    }
    const collides = occupied.some((rect) =>
      candidate.x < rect.x + rect.width &&
      candidate.x + candidate.width > rect.x &&
      candidate.y < rect.y + rect.height &&
      candidate.y + candidate.height > rect.y
    )
    if (!collides) return { x: candidate.x, y: candidate.y }
  }
}

function addEdge(list: BridgeLink[], source: string, target: string, prefix: string): void {
  if (source === target) return
  if (list.some((edge) =>
    (edge.source === source && edge.target === target) ||
    (edge.source === target && edge.target === source))) return
  list.push({ id: edgeId(prefix, source, target), source, target })
}


/** The held launch this verb owns, by its command: a patch never touches a launch someone replaced. */
const ownLaunch = (node: CanvasNodeState, command: string): boolean => node.pendingLaunch?.command === command

/** The launch was delivered: the hold is gone. Lands when the hold was still this verb's own. */
function clearLaunch(projectId: string, nodeId: string, command: string): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      if (!ownLaunch(node, command)) return false
      delete node.pendingLaunch
      return true
    }
  }
}

/** The launch is claimed (or failed): only an explicit Run now may deliver it now. Lands only when
 *  THIS patch claimed it: the hold was this verb's own AND nobody had claimed it yet (a launch already
 *  `manualOnly` on the fresh read was claimed by someone else, and delivering it again would type the
 *  command twice). */
function claimLaunch(projectId: string, nodeId: string, command: string, attempted: boolean): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      if (!ownLaunch(node, command)) return false
      const unclaimed = node.pendingLaunch!.manualOnly !== true
      node.pendingLaunch = { ...node.pendingLaunch!, manualOnly: true, ...(attempted ? { attempted: true } : {}) }
      return unclaimed
    }
  }
}

/** A dependency this arm waited for has had its first real working turn. */
function dropAwaitWorking(projectId: string, nodeId: string, command: string, depId: string): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      const held = node.pendingLaunch
      if (!held || !ownLaunch(node, command) || !held.awaitWorking?.includes(depId)) return false
      const rest = held.awaitWorking.filter((id) => id !== depId)
      const { awaitWorking: _awaitWorking, ...kept } = held
      node.pendingLaunch = rest.length ? { ...kept, awaitWorking: rest } : kept
      return true
    }
  }
}


function nodeProjects(workspace: Workspace, nodeId: string): Project[] {
  return workspace.projects.filter((project) => project.nodes.some((node) => node.id === nodeId))
}

function headlessLinkEndpoint(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): LinkEndpoint {
  const agentId = node.kind === 'terminal' ? node.agentId ?? runtimeAgentId?.(node.id) : undefined
  return {
    kind: node.kind,
    contextCapable: !!agentId && canContextLink(agentId as AgentId)
  }
}

function isDescendant(
  nodes: readonly CanvasNodeState[],
  candidateId: string,
  ancestorId: string
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let current = byId.get(candidateId)
  while (current?.parentId && !seen.has(current.parentId)) {
    if (current.parentId === ancestorId) return true
    seen.add(current.parentId)
    current = byId.get(current.parentId)
  }
  return false
}

function groupPersistedNodes(
  nodes: CanvasNodeState[],
  ids: string[],
  groupIndex: number,
  label: string | undefined,
  color: NodeColor | undefined
): { nodes: CanvasNodeState[]; groupId: string; changed: CanvasNodeState[] } | null {
  const group: CanvasNodeState = {
    id: nextId('group'), kind: 'group', position: { x: 0, y: 0 }, size: { width: 200, height: 140 },
    title: label || `Group ${groupIndex + 1}`,
    color: color ?? SYSTEM_NODE_COLORS[groupIndex % SYSTEM_NODE_COLORS.length], group: null
  }
  const next = wrapStoredNodes(nodes, ids, group)
  if (!next) return null
  const before = new Map(nodes.map((node) => [node.id, node]))
  return { nodes: next, groupId: group.id,
    changed: next.filter((node) => stableStringify(before.get(node.id)) !== stableStringify(node)) }

}

function rootPosition(
  nodes: readonly CanvasNodeState[],
  node: CanvasNodeState
): { x: number; y: number } {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  return rootPositionWith(node, (id) => byId.get(id))
}

/** Desktop `ungroupNodes` semantics over persisted nodes: direct children move up one level. */
function ungroupPersistedNodes(
  nodes: CanvasNodeState[],
  groupId: string
): { nodes: CanvasNodeState[]; promoted: CanvasNodeState[] } {
  const frame = nodes.find((node) => node.id === groupId)
  if (!frame || frame.kind !== 'group') return { nodes, promoted: [] }
  const parentId = frame.parentId
  const parent = parentId ? nodes.find((node) => node.id === parentId && node.kind === 'group') : undefined
  const parentRoot = parent ? rootPosition(nodes, parent) : { x: 0, y: 0 }
  const promoted: CanvasNodeState[] = []
  const moved = nodes.map((node) => {
    if (node.parentId !== groupId) return node
    const root = rootPosition(nodes, node)
    const next: CanvasNodeState = {
      ...node,
      position: { x: root.x - parentRoot.x, y: root.y - parentRoot.y }
    }
    if (parent) next.parentId = parent.id
    else delete next.parentId
    promoted.push(next)
    return next
  })
  return {
    nodes: groupsFirst(moved.filter((node) => node.id !== groupId)),
    promoted
  }
}

function ptyOptions(project: Project, node: CanvasNodeState): PtyCreateOptions {
  return localNodePtyOptions(project, node, { cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
}

async function promptReadable(file: string | undefined): Promise<boolean> {
  if (!file) return true
  try { await fs.access(file, fs.constants.R_OK); return (await fs.stat(file)).isFile() } catch { return false }
}

function launchIdentity(project: Project, node: CanvasNodeState): string {
  return stableStringify({ projectId: project.id, projectCwd: project.cwd, projectSsh: project.ssh,
    kind: node.kind, agentId: node.agentId, accountId: node.accountId, cwd: node.cwd, shell: node.shell,
    ssh: node.ssh, remote: node.sshRemoteTmux, command: node.pendingLaunch?.command, promptFile: node.pendingLaunch?.promptFile })
}

/**
 * Host-side canvas authoring and launch scheduler, shared by Desktop and Server adapters.
 *
 * Every workspace read/modify/save transaction is serialized. That is important even on one
 * Node event loop: WorkspaceStore.load/save both await filesystem operations, so two simultaneous
 * `/control/open-agent` calls would otherwise read the same snapshot and the later save would
 * erase the earlier node. PTY creation happens after the node is durable, matching the renderer's
 * recoverable failure direction: a spawn error leaves a visible, reopenable node instead of an
 * invisible tmux session.
 */
export class HeadlessNodeFactory {
  private serial: Promise<unknown> = Promise.resolve()
  private attached = new Set<string>()
  /** Process-local proof that a caller created a node during THIS Server Edition run. */
  private ownership: HeadlessNodeOwnership
  /** Fresh server-spawned agents that have not emitted their first real working turn yet. */
  private awaitingFirstWorking = new Set<string>()
  /** New orchestration arms require authenticated current-session state; never rebuilt from disk. */
  private strictArms = new Set<string>()
  private strictLaunchIdentities = new Map<string, string>()
  private delivered = new Map<string, string>()

  private noteDelivered(id: string, command: string): void {
    this.delivered.delete(id)
    this.delivered.set(id, command)
    while (this.delivered.size > LAUNCH_CLAIM_LEDGER_MAX) this.delivered.delete(this.delivered.keys().next().value!)
  }
  /** Stations whose LAST turn ended on an API/model error (#521, the `errored` flag on a `done`),
   *  from this edition's own event stream — the desktop's `lastTurnError`, kept here so a success
   *  wait holds on an errored turn on both editions. Cleared by the next genuine new turn. */
  private lastTurnErrored = new Set<string>()
  /**
   * Server-local `open-project` grants. The browser shell's grant ledger is process-local too,
   * but Server Edition has its own process and handler. A service restart deliberately clears
   * this map; `openProject()` can re-establish a grant only for an exact, already-saved local
   * project path, so a surviving agent session is never stranded after that restart.
   */
  private projectGrants = new Map<string, Set<string>>()
  private stopped = false
  private readonly contentWriter: CanvasContentWriter

  constructor(private readonly deps: HeadlessNodeFactoryDeps) {
    this.ownership = deps.ownership ?? createHeadlessNodeOwnership()
    this.contentWriter = new CanvasContentWriter({ ...deps, isStopped: () => this.stopped })
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work)
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private readWorkspace(): Promise<Workspace> {
    return this.contentWriter.readWorkspace()
  }

  private loadForEdit(): Promise<Workspace> {
    return this.contentWriter.loadForEdit()
  }

  private castAndSave(workspace: Workspace, opts: { onlyIfChanged?: boolean } = {}): Promise<boolean> {
    return this.contentWriter.castAndSave(workspace, opts)
  }

  private savePatches(patches: readonly NodePatch[]): Promise<PatchSave> {
    return this.contentWriter.savePatches(patches)
  }

  private publishPersisted(projectIds: Iterable<string>): Promise<void> {
    return this.contentWriter.publishPersisted(projectIds)
  }

  /** Who opened `nodeId` during THIS server run (and into which project), or undefined — the
   *  station-failure notice's recipient rule on this edition (src/core/agents/station-notice.ts). */
  openerOf(nodeId: string): HeadlessNodeOwner | undefined {
    return this.ownership.ownerOf(nodeId)
  }

  /** Literal creator ownership: a caller may act only on nodes it freshly spawned this run. */
  ownsSpawn(sourceNodeId: string, nodeId: string): boolean {
    return this.ownership.ownerOf(nodeId)?.sourceNodeId === sourceNodeId
  }

  /** The operator's control scope (control-scope.ts). */
  get controlScope(): ControlScope {
    return this.deps.controlScope ?? 'creator'
  }

  /**
   * Does `nodeId` belong to the caller's OWN project and nowhere else? The `project` scope's whole
   * rule: the caller is in `project`, the node is too, and no other project holds that id (a node id
   * repeats when one committed canvas is opened from two folders, and its tmux session is keyed by id
   * alone, so it belongs to both).
   */
  private inCallerProject(sourceNodeId: string, nodeId: string, workspace: Workspace, project: Project): boolean {
    if (!project.nodes.some((node) => node.id === sourceNodeId)) return false
    const holders = nodeProjects(workspace, nodeId)
    return holders.length === 1 && holders[0].id === project.id
  }

  /** A verified caller may mutate a node it freshly created during this server run — or, under the
   *  `project` scope, any node of its own project (`inCallerProject`). */
  private ownsMutation(sourceNodeId: string, nodeId: string, workspace: Workspace, project: Project): boolean {
    if (this.ownsSpawn(sourceNodeId, nodeId)) return true
    return this.controlScope === 'project' && this.inCallerProject(sourceNodeId, nodeId, workspace, project)
  }

  /** All-or-nothing ownership gate: validate every id before any canvas or session mutation. */
  private unownedMutation(
    sourceNodeId: string,
    nodeIds: readonly string[],
    workspace: Workspace,
    project: Project
  ): string | undefined {
    return nodeIds.find((nodeId) => !this.ownsMutation(sourceNodeId, nodeId, workspace, project))
  }

  private ownershipRefusal(verb: string, sourceNodeId: string, nodeId: string): ServerControlReply {
    const reach =
      this.controlScope === 'project'
        ? 'nodes it spawned during this server run and nodes that are only in its own project'
        : 'nodes it spawned during this server run'
    return {
      ok: false,
      error: `${verb}-not-owner: ${sourceNodeId} may modify only ${reach}; ${nodeId} is neither`
    }
  }

  private projectGranted(sourceNodeId: string, projectId: string): boolean {
    return this.projectGrants.get(sourceNodeId)?.has(projectId) ?? false
  }

  private grantProject(sourceNodeId: string, projectId: string): boolean {
    const grants = this.projectGrants.get(sourceNodeId) ?? new Set<string>()
    if (!grants.has(projectId) && grants.size >= GRANT_CAP) return false
    grants.add(projectId)
    this.projectGrants.set(sourceNodeId, grants)
    return true
  }

  private async attach(project: Project, node: CanvasNodeState): Promise<PtyCreateResult> {
    if (this.stopped) throw new Error('host canvas control stopped')
    if (this.attached.has(node.id)) {
      return { sessionId: node.id, fresh: false }
    }
    const result = await this.deps.ptyManager.createHeadless(ptyOptions(project, node))
    if (result.sessionId) this.attached.add(node.id)
    return result
  }

  /**
   * Spawn-or-attach `node` and deliver `command` through the shared echo-verified launcher (#925).
   * - `release:false` keeps the server's synthetic client attached, as it always has.
   * - `requirePersistent:false`, because that attached client is what keeps even a plain-shell
   *   session reachable here. (The desktop releases its client, so it refuses a plain shell instead.)
   * - `createHeadless` goes through `attach()` so the `attached` ledger stays authoritative.
   */
  private async launch(project: Project, node: CanvasNodeState, command: string, current?: () => boolean): Promise<HeadlessLaunchResult> {
    if (!(await promptReadable(node.pendingLaunch?.promptFile))) return { outcome: 'failed', reason: 'prompt-file-missing' }
    if (!(await this.accountReady(node))) return { outcome: 'failed', reason: 'account-unavailable' }
    if (current && !current()) return { outcome: 'failed', reason: 'cancelled' }
    const pty = this.deps.ptyManager
    try { return await launchHeadless(
      {
        persistentSpawnAvailable: () => pty.persistentSpawnAvailable(),
        createHeadless: () => {
          if (current && !current()) return Promise.reject(new Error('launch-owner-expired'))
          return this.attach(project, node)
        },
        paneCommand: (key) => pty.paneCommand(key),
        writeHeadless: (key, data) => !this.stopped && (!current || current()) && pty.writeHeadless(key, data),
        onOutput: (key, cb) => pty.onOutput(key, cb),
        releaseHeadless: (key) => pty.releaseHeadless(key),
        timing: this.deps.launchTiming
      },
      { ptyOptions: ptyOptions(project, node), command, release: false, requirePersistent: this.deps.releaseHeadlessAfterWork === true }
    ) } finally {
      if (this.deps.releaseHeadlessAfterWork) { this.attached.delete(node.id); pty.releaseHeadless(node.id) }
    }
  }

  private async accountReady(node: CanvasNodeState): Promise<boolean> {
    if (!node.accountId) return true
    if (node.agentId !== 'claude' && node.agentId !== 'codex') return false
    const settings = this.deps.settings()
    const account = (node.agentId === 'claude' ? settings.claudeAccounts : settings.codexAccounts)?.find((a) => a.id === node.accountId)
    if (!account || account.pending || account.host) return false
    try {
      const home = node.agentId === 'claude' ? claudeConfigDirFor(node.accountId) : codexHomeForAccount(platform().userDataDir, node.accountId)
      return (await fs.stat(home)).isDirectory()
    } catch { return false }
  }

  private resolveTarget(
    workspace: Workspace,
    source: { project: Project; node: CanvasNodeState },
    verb: string,
    args: Record<string, string>,
    verified: boolean
  ): Project | ServerControlReply {
    const targetId = args.project || source.project.id
    const target = workspace.projects.find((project) => project.id === targetId)
    const gate = gateProjectTarget({
      verified,
      verb,
      targetProjectId: args.project || undefined,
      callerProjectId: source.project.id,
      targetIsSsh: target ? !!target.ssh : undefined,
      granted: this.projectGranted(source.node.id, targetId)
    })
    if (gate !== 'allow') return { ok: false, error: gate.refuse }
    if (!target) return { ok: false, error: 'project-target-refused: target project is unavailable' }
    if (target.ssh) {
      return {
        ok: false,
        error: 'project-target-ssh-unsupported: Server Edition v1 only creates local sessions'
      }
    }
    return target
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private handedOver(depId: string): boolean {
    return this.deps.handedOver?.(depId) === true
  }

  /** What a success wait knows about one station, from the same facts this edition's `--after`
   *  reads (the mirror's `done`, the `awaitWorking` fresh-spawn rule), the errored-turn rule (#521,
   *  `lastTurnErrored`, which this edition's plain `--after` does not apply), and its report. */
  private successFacts(
    project: Project,
    depId: string,
    observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>
  ): SuccessDepFacts {
    const exists = project.nodes.some((candidate) => candidate.id === depId)
    const state = observed?.nodeId === depId ? observed.state : this.deps.stateOf(depId)
    const reported = this.deps.outcomeOf?.(depId)
    return {
      exists,
      turnDone:
        exists &&
        !this.awaitingFirstWorking.has(depId) &&
        !this.lastTurnErrored.has(depId) &&
        !this.handedOver(depId) &&
        state === 'done',
      ...(reported ? { outcome: reported } : {})
    }
  }

  private resolveAfter(
    project: Project,
    raw: string | undefined,
    verb: string
  ): string[] | ServerControlReply {
    if (!raw) return []
    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
    for (const id of ids) {
      const node = project.nodes.find((candidate) => candidate.id === id)
      if (!node) return { ok: false, error: `${verb}: --after names no existing node (${id})` }
      const agentId = effectiveAgentId(node, this.deps.agentIdOf)
      if (!agentId || !hasHooks(agentId)) {
        return {
          ok: false,
          error: `${verb}: --after ${id} is not an agent session that reports when it is done`
        }
      }
    }
    return ids
  }

  async openTerminal(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-terminal', args, verified)
  }

  /**
   * Re-open one exact local project that is already present in the Server workspace and mint a
   * process-local targeting grant for this verified caller. Server Edition still cannot create,
   * add, rename, recolor, or focus projects: those operations require the browser UI's explicit
   * confirmation. This narrow existing-only form is the restart recovery path for long-lived
   * agent nodes whose tmux sessions survive the Server process.
   */
  openProject(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['cwd']))
      if (flagError) return { ok: false, error: `open-project: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: 'open-project-identity-refused: Server Edition open-project requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      if (source.project.ssh) {
        return {
          ok: false,
          error: 'open-project-local-only: open-project is not available from an SSH project — do not retry'
        }
      }

      const rawCwd = args.cwd ?? ''
      if (!path.isAbsolute(rawCwd)) {
        return {
          ok: false,
          error: 'open-project-cwd-invalid: --cwd must be an absolute path to an existing saved local project'
        }
      }
      const cwd = path.resolve(rawCwd)
      const target = workspace.projects.find(
        (project) => !project.ssh && !!project.cwd && path.resolve(project.cwd) === cwd
      )
      if (!target) {
        return {
          ok: false,
          error:
            'open-project-server-existing-only: Server Edition can only re-open an exact saved ' +
            'local project path; add the project in the UI first — do not retry this path'
        }
      }
      if (!this.grantProject(sourceNodeId, target.id)) {
        return {
          ok: false,
          error: 'open-project-grant-cap: this session already holds the maximum number of project grants'
        }
      }

      return {
        ok: true,
        message: `re-opened saved local project ${target.id}; cross-project grant restored`,
        result: {
          projectId: target.id,
          name: target.name,
          cwd,
          created: false,
          serverExistingOnly: true
        }
      }
    })
  }

  async openAgent(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-agent', args, verified)
  }

  /** Host-only continuation of a proven branch effect. No renderer callback or resume flag RPC. */
  resumeClaudeOriginal(sourceId: string, targetId: string, originalId: string,
    current: () => boolean): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      try {
        if (!isClaudeBranchSessionId(originalId) || sourceId === targetId) throw new Error('invalid branch continuation')
        const select = (workspace: Workspace) => {
          if (this.stopped || !current()) throw new Error('branch approval or target expired')
          const source = sourceProject(workspace, sourceId)
          const hits = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === targetId).map((node) => ({ project, node })))
          const target = hits.length === 1 ? hits[0] : undefined
          if (!source || !target || source.project.id !== target.project.id || target.project.unavailable ||
            target.project.ssh || isRemoteSessionNode(source.node) || isRemoteSessionNode(target.node) ||
            !sourceCanControl(source.node, this.deps.agentIdOf) || !this.ownsMutation(sourceId, targetId, workspace, target.project) ||
            target.node.kind !== 'terminal' || target.node.agentId !== 'claude' || target.node.pendingLaunch)
            throw new Error('branch source/target is no longer available in caller scope')
          const account = target.node.accountId ? this.deps.settings().claudeAccounts.find((a) => a.id === target.node.accountId) : undefined
          if (target.node.accountId && (!account || account.pending || account.host)) throw new Error('branch account is unavailable')
          const duplicate = workspace.projects.some((project) => project.nodes.some((node) =>
            node.id !== targetId && node.agentId === 'claude' && node.accountId === target.node.accountId &&
            !project.ssh && !isRemoteSessionNode(node) && (this.deps.sessionOf?.(node.id) ?? node.agentSessionId) === originalId))
          if (duplicate) throw new Error('the original conversation already has another node')
          const settings = this.deps.settings()
          const binding = stableStringify({ source: launchIdentity(source.project, source.node),
            target: launchIdentity(target.project, target.node), targetModel: target.node.agentModel,
            account, mode: resolvePermissionMode(target.project, settings), launch: settings.agentLaunchCommands?.claude })
          return { source, target, binding, settings }
        }
        const before = select(await this.readWorkspace())
        if (!(await this.accountReady(before.target.node))) throw new Error('branch account directory is unavailable')
        const caps = await this.deps.cliCaps()
        const launchInfo = await this.deps.projectLaunchInfo?.(before.target.project.id)
        const override = projectLaunchOverride('claude', launchInfo, before.settings)
        if (override.requestTrust) {
          this.deps.requestAgentsTrust?.(before.target.project.id)
          throw new Error('the project launch command requires owner trust')
        }
        const command = assembleResumeCommand({ agentId: 'claude', sessionId: originalId,
          model: before.target.node.agentModel, launchCmdOverride: override.command,
          permissionMode: gatePermissionMode(resolvePermissionMode(before.target.project, before.settings), caps.autoPermissionMode) },
        this.deps.env ?? process.env).command
        const id = nextId('term')
        const committed = await this.contentWriter.edit((workspace) => {
          const fresh = select(workspace)
          if (fresh.binding !== before.binding) throw new Error('branch execution/account settings changed')
          const project = fresh.target.project; const target = fresh.target.node
          const size = terminalSize(fresh.settings)
          const node: CanvasNodeState = { id, kind: 'terminal', position: placeRight(project, target, size), size,
            title: `${target.title || 'Claude'} (original)`, titleAuto: false, color: target.color,
            group: null, tags: [], agentId: 'claude', agentSessionId: originalId,
            ...(target.accountId ? { accountId: target.accountId } : {}),
            ...(target.agentModel ? { agentModel: target.agentModel } : {}), cwd: target.cwd || project.cwd,
            pendingLaunch: { after: [], command, executor: 'server', attempted: true, manualOnly: true } }
          project.nodes.push(node)
          const ropes = project.ropes ??= []; addEdge(ropes, sourceId, id, 'ctrl')
          const bridges = project.bridges ??= []; addEdge(bridges, sourceId, id, 'link')
          return { project, node }
        })
        if (!committed.saved) throw new Error('original resume could not be saved')
        const { project, node } = committed.value
        this.ownership.record(id, { sourceNodeId: sourceId, projectId: project.id })
        await this.publishPersisted([project.id])
        const launched = await this.startCreated(project, [node], new Map([[id, command]]), true, current)
        return { ok: launched.failed.length === 0,
          ...(launched.failed.length ? { error: 'original-resume-launch-failed: the saved node retains its launch; do not repeat branch' }
            : { message: 'Original conversation saved in a new node; launch delivered, startup is not confirmed.' }),
          result: { id, originalId, ...launched } }
      } catch (error) {
        return { ok: false, error: `original-resume-refused: ${error instanceof Error ? error.message : String(error)}; inspect the branch, do not repeat it` }
      }
    })
  }

  /** File one run-history line under the issue card. Never throws: history is a record of work,
   *  and a failed append must not fail the open or close it describes. */
  private async logRun(
    projectId: string,
    run: { nodeId: string; event: BoardLogEntry['event'] } | null
  ): Promise<void> {
    if (!run || !this.deps.appendBoardLog) return
    await this.deps.appendBoardLog(projectId, {
      id: randomUUID(),
      ts: (this.deps.now ?? Date.now)(),
      author: RUN_LOG_AUTHOR,
      nodeId: run.nodeId,
      kind: 'event',
      event: run.event
    }).catch(() => false)
  }

  close(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      // `--force` exists only under the `project` scope (a busy node the caller did not open); under
      // `creator` it stays an unknown flag, as it always was.
      const flagError = unsupportedFlags(
        args,
        new Set(this.controlScope === 'project' ? ['node', 'force'] : ['node'])
      )
      if (flagError) return { ok: false, error: `close: ${flagError}` }
      const force = parseForceFlag(args.force)
      if (typeof force === 'object') return { ok: false, error: force.error }
      if (!verified) {
        return {
          ok: false,
          error: 'close-identity-refused: Server Edition close requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = [...new Set((args.node ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
      if (!ids.length) return { ok: false, error: 'close requires --node <id>' }

      // Validate the WHOLE list before killing anything. A mixed owned/unowned request is one
      // refusal, never a partial destructive success whose surviving ids the caller must guess.
      // Each id's project is resolved HERE (a factory stopped while the panes die clears the
      // ownership ledger, and the steps below must still know where each node lives): the creator
      // record's project for a node the caller spawned, else — under the `project` scope only — the
      // caller's own project, which `ownsMutation` has checked is the node's only project.
      const frameIds = new Set<string>()
      const ownerProject = new Map<string, string>()
      for (const id of ids) {
        // (Under `creator` the caller never spawned itself, so it gets close-not-owner, as before.)
        if (id === sourceNodeId && this.controlScope === 'project') {
          return { ok: false, error: `close-self-refused: ${id} is the calling node; an agent never closes itself` }
        }
        const ownership = this.ownership.ownerOf(id)
        const spawned = !!ownership && ownership.sourceNodeId === sourceNodeId
        if (!spawned && !this.ownsMutation(sourceNodeId, id, workspace, source.project)) {
          return this.controlScope === 'project'
            ? this.ownershipRefusal('close', sourceNodeId, id)
            : {
                ok: false,
                error: `close-not-owner: ${sourceNodeId} did not spawn ${id} during this server run`
              }
        }
        const projectId = spawned ? ownership!.projectId : source.project.id
        ownerProject.set(id, projectId)
        const project = workspace.projects.find((candidate) => candidate.id === projectId)
        const target = project?.nodes.find((node) => node.id === id)
        // No human confirms a close here, so a node the caller did not open is not ended mid-turn or
        // under an open question without saying so: `--force yes` is that saying so.
        if (!spawned && target?.kind !== 'group' && !force && isBusyAgentState(this.deps.stateOf(id))) {
          return {
            ok: false,
            error:
              `close-busy: ${id} is working or waiting on a person; closing it ends that work. ` +
              'Pass --force yes to close it anyway.'
          }
        }
        if (target?.kind === 'group') {
          const unownedChild = this.unownedMutation(
            sourceNodeId,
            project!.nodes.filter((node) => node.parentId === id).map((node) => node.id),
            workspace,
            source.project
          )
          if (unownedChild) return this.ownershipRefusal('close', sourceNodeId, unownedChild)
          frameIds.add(id)
        }
      }

      // Kill terminal panes first: the durable canvas must never lose a session whose outcome is
      // unknown. Frames have no PTY; closing one is the desktop `ungroup` transform followed by
      // removal of the frame alone, regardless of who owns its members.
      await Promise.all(
        ids
          .filter((id) => !frameIds.has(id))
          .map((id) => this.deps.ptyManager.destroySession(null, id, { everySocket: true }))
      )

      // Run history first (it awaits), from the read the checks above used.
      for (const id of ids) {
        const projectId = ownerProject.get(id)!
        const target = workspace.projects.find((p) => p.id === projectId)?.nodes.find((node) => node.id === id)
        if (!target?.issueRef) continue
        // A run ends when its node is CLOSED — never when a turn ends.
        await this.logRun(projectId, runEndedEvent(target.issueRef, {
          id: target.id,
          title: target.title,
          agentId: target.agentId,
          agentSessionId: target.agentSessionId
        }, { state: this.deps.stateOf(target.id) }))
      }

      // The kills and the history took time: the removals go onto a FRESH read, so an edit a
      // teammate made meanwhile is never written back from the copy loaded before them. What
      // changed (removals, promoted frame members, pruned edges) is cast by `castAndSave`.
      const current = await this.loadForEdit()
      const touched = new Set<string>()
      for (const id of ids) {
        const projectId = ownerProject.get(id)!
        const project = current.projects.find((candidate) => candidate.id === projectId)
        const target = project?.nodes.find((node) => node.id === id)
        if (!project || !target) continue
        if (target.kind === 'group') {
          project.nodes = ungroupPersistedNodes(project.nodes, id).nodes
        } else {
          project.nodes = project.nodes.filter((node) => node.id !== id)
        }
        if (project.ropes) {
          project.ropes = project.ropes.filter((edge) => edge.source !== id && edge.target !== id)
        }
        if (project.bridges) {
          project.bridges = project.bridges.filter((edge) => edge.source !== id && edge.target !== id)
        }
        touched.add(project.id)
      }

      // A refused save (canvas control is stopping) removed nothing from the canvas: say so, rather
      // than report a close whose nodes are still on disk.
      const saved = touched.size ? await this.castAndSave(current) : true
      if (saved && touched.size) await this.publishPersisted(touched)

      for (const id of ids) {
        this.ownership.forget(id)
        this.attached.delete(id)
        this.awaitingFirstWorking.delete(id)
      }
      if (!saved) {
        return {
          ok: false,
          error:
            `close-not-saved: the sessions of ${ids.join(', ')} were ended, but the canvas could not be ` +
            'written (canvas control is stopping); the nodes stay on the canvas'
        }
      }
      return {
        ok: true,
        message: `closed ${ids.length} owned node(s): ${ids.join(', ')}`,
        result: { ids, id: ids[0] }
      }
    })
  }

  link(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['from', 'to', 'one-way']))
      if (flagError) return { ok: false, error: `link: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: 'link-identity-refused: Server Edition link requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const from = (args.from ?? sourceNodeId).trim()
      const targets = (args.to ?? '').split(',').map((id) => id.trim()).filter(Boolean)
      if (!targets.length) return { ok: false, error: 'link requires --to <id,id>' }

      // An arbitrary `--from` is allowed, but every endpoint still belongs to the caller's one
      // project. Refuse the whole request before appending anything if a named id resolves across
      // that boundary (or ambiguously in more than one saved project).
      for (const id of [from, ...targets]) {
        const projects = nodeProjects(workspace, id)
        if (projects.length && (projects.length !== 1 || projects[0].id !== source.project.id)) {
          return {
            ok: false,
            error: `link-project-refused: ${id} is not exclusively in the caller's project; ${LINK_PROJECT_ONLY}`
          }
        }
      }
      const unowned = this.unownedMutation(sourceNodeId, [from, ...targets], workspace, source.project)
      if (unowned) return this.ownershipRefusal('link', sourceNodeId, unowned)

      const byId = new Map(source.project.nodes.map((node) => [node.id, node]))
      if (!byId.has(from)) {
        return { ok: false, error: `link: --from ${from}: ${LINK_ENDPOINT_NOT_FOUND}` }
      }
      const existing = [...(source.project.bridges ?? [])]
      const plan = planBridges(
        from,
        targets,
        (id) => {
          const node = byId.get(id)
          return node ? headlessLinkEndpoint(node, this.deps.agentIdOf) : null
        },
        existing,
        // Valueless flag: the shim sends `arg.one-way=` (present, empty).
        { oneWay: 'one-way' in args }
      )
      if (!plan.edges.length) {
        return {
          ok: false,
          error: `link: nothing linked — ${plan.skipped
            .map((skipped) => `${skipped.id}: ${skipped.why}`)
            .join('; ')}`
        }
      }

      source.project.bridges = [...existing, ...plan.edges]
      await this.castAndSave(workspace)
      await this.publishPersisted([source.project.id])
      const note = plan.skipped.length
        ? ` (skipped ${plan.skipped.map((skipped) => `${skipped.id}: ${skipped.why}`).join('; ')})`
        : ''
      return {
        ok: true,
        message: 'one-way' in args
          ? `linked one-way: ${from} reads ${plan.linked.join(', ')}${note}`
          : `linked ${from} ↔ ${plan.linked.join(', ')}${note}`,
        result: { from, linked: plan.linked, skipped: plan.skipped }
      }
    })
  }

  showImage(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.showFile('image', sourceNodeId, args, verified)
  }

  showVideo(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.showFile('video', sourceNodeId, args, verified)
  }

  private showFile(kind: 'image' | 'video', sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    const verb = `show-${kind}`
    const label = kind === 'image' ? 'image' : 'media'
    return this.runExclusive(async () => {
      if (!verified) return { ok: false, error: `${verb}-identity-refused: requires verified node identity` }
      const flagError = unsupportedFlags(args, new Set(['path']))
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      const rawPath = args.path?.trim()
      if (!rawPath || rawPath.includes('\0')) return { ok: false, error: `${verb} requires --path to ${kind === 'image' ? 'an image' : 'a media'} file` }
      const source = sourceProject(await this.readWorkspace(), sourceNodeId)
      if (!source || !sourceCanControl(source.node, this.deps.agentIdOf)) return { ok: false, error: `${verb}-source-refused: requires a control-capable source in exactly one saved project` }
      if (source.project.ssh || source.node.ssh || source.node.sshRemoteTmux || source.project.unavailable) {
        return { ok: false, error: `${verb}-host-refused: remote ${kind === 'image' ? 'images' : 'media'} require their own filesystem adapter; no local fallback` }
      }
      const resolvePath = (project: Project, node: CanvasNodeState): string | undefined => {
        const expanded = expandHomePath(rawPath)
        if (path.isAbsolute(expanded)) return path.normalize(expanded)
        const cwd = node.cwd || project.cwd
        return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, expanded) : undefined
      }
      const filePath = resolvePath(source.project, source.node)
      if (!filePath) return { ok: false, error: `${verb}-path-refused: use an absolute path when the source has no absolute cwd` }
      if (kind === 'image' ? !isImagePath(filePath) : !mediaMime(filePath)) return { ok: false, error: `${verb}-type-refused: this file type has no ${label} preview` }
      // Inspect the opened descriptor; a path stat/access before open can become stale.
      try {
        const handle = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
        try {
          const stat = await handle.stat()
          const named = await fs.lstat(filePath)
          if (!stat.isFile() || !named.isFile() || (stat.ino !== 0 && (stat.dev !== named.dev || stat.ino !== named.ino)) ||
            (kind === 'image' && stat.size > FS_READ_BINARY_MAX_BYTES)) {
            return { ok: false, error: `${verb}-file-refused: requires a regular ${label} file${kind === 'image' ? ' within the binary preview size limit' : ''}` }
          }
          if (kind === 'video') {
            const bytes = Buffer.alloc(32)
            const read = await handle.read(bytes, 0, bytes.length, 0)
            if (!matchesMediaSignature(mediaMime(filePath)!, bytes.subarray(0, read.bytesRead))) return { ok: false, error: 'show-video-type-refused: media signature does not match the file type' }
          }
        } finally { await handle.close() }
      } catch { return { ok: false, error: `${verb}-file-refused: ${label} is unreadable or a symbolic link` } }
      const id = nextId(kind === 'image' ? 'editor' : 'video')
      let editStarted = false
      try {
        const edited = await this.contentWriter.edit((workspace): ServerControlReply => {
          const fresh = sourceProject(workspace, sourceNodeId)
          if (!fresh || fresh.project.id !== source.project.id || fresh.project.ssh || fresh.project.unavailable ||
            fresh.node.ssh || fresh.node.sshRemoteTmux || !sourceCanControl(fresh.node, this.deps.agentIdOf) ||
            resolvePath(fresh.project, fresh.node) !== filePath) return { ok: false, error: `${verb}-source-changed: inspect the source project before retrying` }
          storedGeometryNodes(fresh.project.nodes)
          const nodeKind = kind === 'image' ? 'editor' : 'video'
          const size = resolveDefaultNodeSize(this.deps.settings().defaultNodeSizes?.[nodeKind], kind === 'image' ? EDITOR_NODE_SIZE : VIDEO_NODE_SIZE, NODE_MIN_SIZES[nodeKind])
          fresh.project.nodes.push({ id, kind: nodeKind, position: placeRight(fresh.project, fresh.node, size),
            size, ...(kind === 'image' ? editorNodeData(filePath) : videoNodeData(filePath)), openedBy: sourceNodeId })
          const ropes = [...(fresh.project.ropes ?? [])]
          addEdge(ropes, sourceNodeId, id, 'ctrl')
          fresh.project.ropes = ropes
          editStarted = true
          return { ok: true, message: `showing ${kind} ${id}`, result: { id } }
        })
        if (edited.saved) {
          this.ownership.record(id, { sourceNodeId, projectId: source.project.id })
          await this.publishPersisted([source.project.id])
        }
        return edited.value
      } catch (error) {
        return { ok: false, error: editStarted ? `${verb}-save-uncertain: inspect list before repeating; ${String(error)}` : String(error) }
      }
    })
  }

  showWeb(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      if (!verified) return { ok: false, error: 'show-web-identity-refused: verified source required' }
      const flags = unsupportedFlags(args, new Set(['url', 'file', 'html']))
      if (flags) return { ok: false, error: `show-web: ${flags}` }
      if (['url', 'file', 'html'].filter((flag) => args[flag] !== undefined).length !== 1) return { ok: false, error: 'show-web: provide exactly one of --url, --file or --html' }
      const source = sourceProject(await this.readWorkspace(), sourceNodeId)
      if (!source || !sourceCanControl(source.node, this.deps.agentIdOf) || source.project.ssh || source.project.unavailable || isRemoteSessionNode(source.node)) {
        return { ok: false, error: 'show-web-source-refused: requires one available local project and control-capable source' }
      }
      let preview: { url?: string; filePath?: string }
      const resolveFile = (project: Project, node: CanvasNodeState) => {
        const raw = expandHomePath(args.file ?? '')
        const cwd = node.cwd || project.cwd
        return path.isAbsolute(raw) ? path.normalize(raw) : cwd && path.isAbsolute(cwd) ? path.resolve(cwd, raw) : undefined
      }
      if (args.url !== undefined) {
        const url = externalPreviewUrl(args.url)
        if (!url) return { ok: false, error: 'show-web-url-refused: use an external HTTP(S) URL without credentials; host localhost requires a preview gateway' }
        preview = { url }
      } else {
        if (!this.deps.webPreviews) return { ok: false, error: 'show-web-isolation-required: configure NODETERM_PREVIEW_ORIGIN on a distinct HTTPS hostname before previewing HTML' }
        try {
          const filePath = args.html !== undefined ? await this.deps.webPreviews.writeHtml(args.html) : resolveFile(source.project, source.node)
          if (!filePath) return { ok: false, error: 'show-web-path-refused: an absolute local HTML path is required' }
          await this.deps.webPreviews.readHtml(filePath)
          preview = { filePath }
        } catch (error) { return { ok: false, error: `show-web-file-refused: ${String(error)}` } }
      }
      const id = nextId('web')
      let editing = false
      try {
        const edited = await this.contentWriter.edit((workspace): ServerControlReply => {
          const fresh = sourceProject(workspace, sourceNodeId)
          if (!fresh || fresh.project.id !== source.project.id || fresh.project.ssh || fresh.project.unavailable || isRemoteSessionNode(fresh.node) ||
            !sourceCanControl(fresh.node, this.deps.agentIdOf) || (args.file !== undefined && resolveFile(fresh.project, fresh.node) !== preview.filePath)) {
            return { ok: false, error: 'show-web-source-changed: inspect the source before retrying' }
          }
          storedGeometryNodes(fresh.project.nodes)
          const size = resolveDefaultNodeSize(this.deps.settings().defaultNodeSizes?.web, WEB_NODE_SIZE, NODE_MIN_SIZES.web)
          fresh.project.nodes.push({ id, kind: 'web', position: placeRight(fresh.project, fresh.node, size), size,
            ...webNodeData(preview), ...(args.html !== undefined ? { title: 'HTML preview' } : {}), openedBy: sourceNodeId })
          fresh.project.ropes = [...(fresh.project.ropes ?? [])]
          addEdge(fresh.project.ropes, sourceNodeId, id, 'ctrl')
          editing = true
          return { ok: true, message: `showing web preview ${id}`, result: { id } }
        })
        if (edited.saved) {
          this.ownership.record(id, { sourceNodeId, projectId: source.project.id })
          await this.publishPersisted([source.project.id])
        }
        return edited.value
      } catch (error) { return { ok: false, error: `show-web-${editing ? 'save-uncertain: inspect list before repeating' : 'refused'}: ${String(error)}` } }
    })
  }

  async board(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    const flagError = unsupportedFlags(args, new Set(['project']))
    if (flagError) return { ok: false, error: `board: ${flagError}` }
    const workspace = await this.readWorkspace()
    const source = sourceProject(workspace, sourceNodeId)
    if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
    if (!sourceCanControl(source.node, this.deps.agentIdOf)) return { ok: false, error: 'source node is not a control-capable agent' }
    if (args.project !== undefined && args.project !== source.project.id) {
      return { ok: false, error: `board-project-refused: Server Edition reads only the caller's own project (${source.project.id})` }
    }
    const cards = source.project.nodes.filter((n) => this.inCallerProject(sourceNodeId, n.id, workspace, source.project) &&
      (n.id === sourceNodeId || this.ownsMutation(sourceNodeId, n.id, workspace, source.project)))
      .flatMap((n) => { const card = boardCard(n); return card ? [card] : [] })
    return { ok: true, ...boardVerbReply(source.project.kanban, cards) }
  }

  assign(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'column', 'before']))
      if (flagError) return { ok: false, error: `assign: ${flagError}` }
      let projectId: string | undefined
      let events: Array<{ nodeId?: string; event: NonNullable<BoardLogEntry['event']> }> = []
      let editStarted = false
      try {
        const edited = await this.contentWriter.edit((workspace): ServerControlReply => {
          const source = sourceProject(workspace, sourceNodeId)
          if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
          if (!sourceCanControl(source.node, this.deps.agentIdOf)) return { ok: false, error: 'source node is not a control-capable agent' }
          if (source.project.ssh || source.project.unavailable) return { ok: false, error: 'assign-project-refused: requires an available local project' }
          const id = (args.node ?? '').trim()
          const target = source.project.nodes.find((n) => n.id === id)
          const card = target && boardCard(target)
          if (!card) return { ok: false, error: `assign: --node names no session card (${id || 'missing'})` }
          const permitted = (nodeId: string) => this.inCallerProject(sourceNodeId, nodeId, workspace, source.project) &&
            (nodeId === sourceNodeId || this.ownsMutation(sourceNodeId, nodeId, workspace, source.project))
          if (!permitted(id)) return this.ownershipRefusal('assign', sourceNodeId, id)
          const before = (args.before ?? '').trim()
          if (before && !permitted(before)) return this.ownershipRefusal('assign', sourceNodeId, before)
          const plan = planBoardAssignment(source.project.kanban, source.project.id, id, args)
          if (!plan.ok) return plan
          events = boardLogEvents(plan.previous, plan.next, (nodeId) => {
            const node = source.project.nodes.find((n) => n.id === nodeId)
            return node && boardCard(node) ? boardCard(node)!.title || 'Untitled' : ''
          })
          projectId = source.project.id
          editStarted = true
          source.project.kanban = plan.next
          const where = plan.columnId ? plan.next.columns.find((c) => c.id === plan.columnId)!.title : 'Ungrouped'
          return { ok: true, message: `moved ${card.title || id} to ${where}`, result: { node: id, column: plan.columnId } }
        })
        if (edited.saved && projectId) {
          await this.publishPersisted([projectId])
          for (const { nodeId, event } of events) await this.logRun(projectId, { nodeId: nodeId ?? args.node, event })
        }
        return edited.value
      } catch (error) {
        return { ok: false, error: editStarted ? `assign-save-uncertain: inspect board before repeating; ${String(error)}` : String(error) }
      }
    })
  }

  geometry(verb: GeometryControlVerb, sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flags: Record<GeometryControlVerb, readonly string[]> = {
        ungroup: ['group'], move: ['nodes', 'group'], resize: ['nodes', 'width', 'height'],
        place: ['nodes', 'x', 'y', 'dx', 'dy'], arrange: ['nodes', 'group', 'layout', 'cols', 'gap'],
        align: ['nodes', 'edge']
      }
      const flagError = unsupportedFlags(args, new Set(flags[verb]))
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      let projectId: string | undefined
      let editStarted = false
      try {
        const result = await this.contentWriter.edit((workspace): ServerControlReply => {
          const source = sourceProject(workspace, sourceNodeId)
          if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
          if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
            return { ok: false, error: 'source node is not a control-capable agent' }
          }
          if (source.project.ssh || source.project.unavailable) {
            return { ok: false, error: `${verb}-project-refused: geometry requires an available local project` }
          }
          // Explicit ids are checked even for a no-op; a cloned id never borrows creator proof.
          const explicit = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
          if (args.group && source.project.nodes.some((n) => n.id === args.group)) explicit.push(args.group)
          const refusal = (id: string): ServerControlReply | undefined => {
            if (!this.inCallerProject(sourceNodeId, id, workspace, source.project)) {
              return { ok: false, error: `${verb}-project-refused: ${id} is not exclusively in the caller's project` }
            }
            if (!this.ownsMutation(sourceNodeId, id, workspace, source.project)) return this.ownershipRefusal(verb, sourceNodeId, id)
          }
          for (const id of explicit) {
            if (nodeProjects(workspace, id).length) {
              const denied = refusal(id)
              if (denied) return denied
            }
          }
          const live = storedGeometryNodes(source.project.nodes)
          const settings = this.deps.settings()
          const plan = planGeometryCommand(verb, args, live, {
            grid: settings.snapToGrid ? settings.gridSize : 0, edges: source.project.ropes ?? []
          })
          if (!plan.reply.ok || !plan.changed) return plan.reply
          const next = applyStoredGeometry(source.project.nodes, plan.nodes)
          const nextById = new Map(next.map((n) => [n.id, n]))
          const affected = new Set(source.project.nodes.filter((n) =>
            stableStringify(n) !== stableStringify(nextById.get(n.id))).map((n) => n.id))
          // Moving/resizing a frame also changes its descendants' canvas footprint, even when
          // their parent-relative coordinates stay equal. Include every nested descendant.
          for (const node of source.project.nodes) {
            let parent = node.parentId
            while (parent) {
              if (affected.has(parent)) { affected.add(node.id); break }
              parent = source.project.nodes.find((n) => n.id === parent)?.parentId
            }
          }
          for (const id of affected) {
            const denied = refusal(id)
            if (denied) return denied
          }
          projectId = source.project.id
          editStarted = true
          source.project.nodes = next
          const removed = new Set([...affected].filter((id) => !nextById.has(id)))
          if (removed.size) {
            source.project.bridges = source.project.bridges?.filter((e) => !removed.has(e.source) && !removed.has(e.target))
            source.project.ropes = source.project.ropes?.filter((e) => !removed.has(e.source) && !removed.has(e.target))
          }
          return plan.reply
        })
        if (result.saved && projectId) await this.publishPersisted([projectId])
        return result.value
      } catch (error) {
        if (editStarted) return { ok: false, error: `${verb}-save-uncertain: inspect list --geometry on before repeating this command; ${String(error)}` }
        return { ok: false, error: String(error instanceof Error ? error.message : error) }
      }
    })
  }

  group(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['nodes', 'label', 'color']))
      if (flagError) return { ok: false, error: `group: ${flagError}` }
      let color: NodeColor | undefined
      if (args.color !== undefined) {
        // Names and mixed-case hex resolve to the one canonical palette value; anything else is
        // the same refusal as before. Only the resolved value is persisted.
        color = resolveNodeColor(args.color)
        if (color === undefined) return { ok: false, error: invalidNodeColorMessage() }
      }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = (args.nodes ?? '').split(',').map((id) => id.trim()).filter(Boolean)
      const unowned = this.unownedMutation(sourceNodeId, ids, workspace, source.project)
      if (unowned) return this.ownershipRefusal('group', sourceNodeId, unowned)
      const resolvable = ids.filter((id) => source.project.nodes.some((node) => node.id === id))
      if (!resolvable.length) {
        return { ok: false, error: 'group: none of the given node ids exist' }
      }
      const grouped = groupPersistedNodes(
        source.project.nodes,
        resolvable,
        source.project.nodes.filter((node) => node.kind === 'group').length,
        args.label ? oneLine(args.label) : undefined,
        color
      )
      if (!grouped) {
        return {
          ok: false,
          error:
            'group: nodes must be siblings in one container and may not include an ancestor with its descendant'
        }
      }

      source.project.nodes = grouped.nodes
      await this.castAndSave(workspace)
      this.ownership.record(grouped.groupId, {
        sourceNodeId,
        projectId: source.project.id
      })
      await this.publishPersisted([source.project.id])
      const skipped = ids.length - resolvable.length
      const note = skipped ? ` (${skipped} unknown id(s) skipped)` : ''
      return {
        ok: true,
        message: `grouped ${resolvable.length} node(s) into ${grouped.groupId}${note}`,
        result: { groupId: grouped.groupId, grouped: resolvable, skipped }
      }
    })
  }

  /**
   * `list`: the caller's canvas as the desktop's `list` answers it — the SAME rows and text
   * (@shared/control-listing), built from the saved project and this edition's runtime facts (the
   * status mirror, #521's errored turns, station reports and hand-overs). Two desktop-only facts are
   * never claimed: DROPPED and a stalled delivery are measured by a browser tab, so a row falls back
   * to the agent's mirrored state (or AGENT STATUS UNCONFIRMED), never a guessed one.
   *
   * Visibility follows this edition's ownership rule: the caller's own node and the nodes it spawned
   * during this server run. Rows are judged against the WHOLE project (a dep the caller cannot see
   * is still not "deleted"), then filtered.
   */
  async list(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    const flagError = unsupportedFlags(args, new Set(['geometry', 'project']))
    if (flagError) return { ok: false, error: `list: ${flagError}` }
    const workspace = await this.readWorkspace()
    const source = sourceProject(workspace, sourceNodeId)
    if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
    if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
      return { ok: false, error: 'source node is not a control-capable agent' }
    }
    if (args.project !== undefined && args.project !== source.project.id) {
      return {
        ok: false,
        error: `list-project-refused: Server Edition lists only the caller's own project (${source.project.id})`
      }
    }
    const nodes = source.project.nodes
    const statuses: Record<string, { state?: AgentState; lastTurnError?: { at: number } }> = {}
    const outcomes: Record<string, ListedOutcome> = {}
    const handovers: Record<string, StationHandoverRecord> = {}
    for (const n of nodes) {
      const state = this.deps.stateOf(n.id)
      statuses[n.id] = { state, ...(this.lastTurnErrored.has(n.id) ? { lastTurnError: { at: 0 } } : {}) }
      const outcome = this.deps.outcomeOf?.(n.id)
      if (outcome) outcomes[n.id] = outcome
      const handover = this.deps.handoverOf?.(n.id)
      if (handover) handovers[n.id] = handover
    }
    const rows = storedNodeListing(
      nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        pendingLaunch: n.pendingLaunch,
        agentId: effectiveAgentId(n, this.deps.agentIdOf),
        issueRef: n.issueRef,
        position: n.position,
        size: n.size,
        parentId: n.parentId,
        collapsed: n.collapsed
      })),
      statuses,
      {},
      this.now(),
      outcomes,
      handovers
    ).filter(
      (row) =>
        row.id === sourceNodeId ||
        this.ownsMutation(sourceNodeId, row.id, workspace, source.project)
    )
    return {
      ok: true,
      result: rows,
      message: controlListingText(rows, { geometry: listGeometryRequested(args) }) || '(no nodes)'
    }
  }

  rename(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'title']))
      if (flagError) return { ok: false, error: `rename: ${flagError}` }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const id = (args.node ?? '').trim()
      const projects = nodeProjects(workspace, id)
      if (projects.length && (projects.length !== 1 || projects[0].id !== source.project.id)) {
        return {
          ok: false,
          error: `rename-project-refused: ${id} is not exclusively in the caller's project`
        }
      }
      const target = source.project.nodes.find((node) => node.id === id)
      if (!target) return { ok: false, error: `rename: no node with id ${id}` }
      if (!this.ownsMutation(sourceNodeId, id, workspace, source.project)) {
        return this.ownershipRefusal('rename', sourceNodeId, id)
      }

      const title = oneLine(args.title ?? '')
      const renamed = { ...target, title, titleAuto: false }
      source.project.nodes = source.project.nodes.map((node) =>
        node.id === id ? renamed : node
      )
      await this.castAndSave(workspace)
      // Metadata only. In particular, Server Edition never mirrors `/rename` into the pane.
      await this.publishPersisted([source.project.id])
      return { ok: true, message: `renamed ${id} to "${title}"` }
    })
  }

  /** `run --node <id>` (#925): deliver a node's retained launch now. The control scope applies:
   *  nodes the caller spawned during this server run, or (`project` scope) any node of its project. */
  run(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.runInternal(sourceNodeId, args, verified)
  }

  /** Called only by the authenticated owner IPC, sharing the scheduler's serial execution. */
  async runFromOwner(nodeId: string, expectedCommand: string): Promise<HostLaunchReply> {
    const reply = await this.runInternal(nodeId, { node: nodeId }, true, { expectedCommand })
    return { ...reply, started: (reply.result as { started?: unknown } | undefined)?.started === true }
  }

  private runInternal(sourceNodeId: string, args: Record<string, string>, verified: boolean, owner?: { expectedCommand: string }): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      if (!verified) {
        return { ok: false, error: 'run-identity-refused: Server Edition canvas control requires verified node identity' }
      }
      const flagError = unsupportedFlags(args, new Set(['node', 'project']))
      if (flagError) return { ok: false, error: `run: ${flagError}` }
      const id = (args.node ?? '').trim()
      const workspace = await this.loadForEdit()
      if (this.stopped) return { ok: false, error: 'run-not-saved: host canvas control stopped; no session was started' }
      const holders = nodeProjects(workspace, id)
      if (owner) {
        if (holders.length !== 1 || holders[0].ssh || holders[0].unavailable) return { ok: false, error: 'run-host-target-refused: requires one available local project' }
        const held = holders[0].nodes.find((node) => node.id === id)?.pendingLaunch
        if (held && (held.executor !== 'server' || held.command !== owner.expectedCommand)) return { ok: false, error: 'run-host-stale-request: inspect the current queued launch before retrying' }
        if (this.delivered.get(id) === owner.expectedCommand && held?.attempted !== false) return { ok: true, result: { started: true }, message: 'launch was already delivered' }
        if (!held || held.executor !== 'server' || held.command !== owner.expectedCommand) return { ok: false, error: 'run-host-stale-request: inspect the current queued launch before retrying' }
      }
      const spawned = this.ownsSpawn(sourceNodeId, id)
      if (!owner && !spawned && this.controlScope !== 'project') return this.ownershipRefusal('run', sourceNodeId, id)
      // Resolve through the ownership record, never by first id match: node ids repeat across
      // projects (a committed project.json opened from a second folder), and `attach()` is keyed
      // by id alone, so a stranger copy sorting first would be claimed while the owned session is
      // typed into. `close` resolves the same way. A `--project` naming any other project is the
      // desktop's lookup inside the named project coming up empty. Under the `project` scope a node
      // the caller did not spawn resolves to the caller's own project, which `ownsMutation` has
      // checked is the only project holding that id.
      const noNode: ServerControlReply = { ok: false, error: `run: no node with id ${id}` }
      let projectId = owner ? holders[0].id : spawned ? this.ownership.ownerOf(id)!.projectId : undefined
      if (projectId !== undefined && args.project !== undefined && args.project !== projectId) return noNode
      if (projectId === undefined) {
        const source = sourceProject(workspace, sourceNodeId)
        if (!source || !this.ownsMutation(sourceNodeId, id, workspace, source.project)) {
          return this.ownershipRefusal('run', sourceNodeId, id)
        }
        projectId = source.project.id
        if (args.project !== undefined && args.project !== projectId) return noNode
      }
      const project = workspace.projects.find((p) => p.id === projectId)
      const node = project?.nodes.find((n) => n.id === id)
      if (!project || !node) return noNode
      const held = node.pendingLaunch
      if (!held?.command) return { ok: false, error: `run-nothing-queued: ${id} has no queued launch` }
      // A remote node is NEVER spawned locally, and this launcher only spawns locally. Refuse
      // before the claim, leaving the held launch untouched (the desktop's startHeadless guard).
      if (isRemoteSessionNode(node)) {
        return {
          ok: false,
          error: `run-remote-unsupported: ${id} is an SSH node; the Server Edition cannot start it`
        }
      }
      // Write-ahead, exactly as open() does before its own delivery. Nothing is started unless the
      // claim landed: a refused save (canvas control is stopping) leaves the launch queued as it was.
      node.pendingLaunch = { ...held, attempted: true, manualOnly: true }
      if (!(await this.castAndSave(workspace))) {
        return {
          ok: false,
          error: `run-not-saved: ${id} was not started: the canvas could not be written (canvas control is stopping); its launch stays queued`
        }
      }
      const launched = await this.launch(project, node, held.command)
      if (launched.outcome === 'delivered') this.noteDelivered(id, held.command)
      // As open() does: an agent this spawned fresh has not had its first real turn yet, so a
      // later `--after` on it must not be released by the CLI's boot `done` blip.
      if (node.agentId && launched.fresh) this.awaitingFirstWorking.add(id)
      // The launch took time: only its outcome is written, onto a fresh read (`savePatches`).
      await this.savePatches(launched.outcome === 'delivered' ? [clearLaunch(project.id, id, held.command)] : [])
      await this.publishPersisted([project.id])
      return launched.outcome === 'delivered'
        ? {
            ok: true,
            message: `started ${id}; agent startup is not confirmed`,
            result: { ids: [id], id, started: true, startedIds: [id], queued: false, queuedIds: [] }
          }
        : {
            ok: true,
            message: launched.reason === 'account-unavailable' ? `${id} stays queued: restore or choose its local account before using Run now.` :
              launched.reason === 'prompt-file-missing' ? `${id} stays queued: restore its prompt file before using Run now.` :
              `${id} stays queued (${launched.reason}); launch retained for Run now`,
            result: { ids: [id], id, started: false, startedIds: [], queued: true, queuedIds: [id], reason: launched.reason }
          }
    })
  }

  color(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'color']))
      if (flagError) return { ok: false, error: `color: ${flagError}` }
      const color = resolveNodeColor(args.color)
      if (color === undefined) return { ok: false, error: invalidNodeColorMessage() }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = [...new Set((args.node ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
      const unowned = this.unownedMutation(sourceNodeId, ids, workspace, source.project)
      if (unowned) return this.ownershipRefusal('color', sourceNodeId, unowned)
      const changed = ids
        .map((id) => source.project.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNodeState => !!node)
        .map((node) => ({ ...node, color }))
      if (!changed.length) {
        return { ok: false, error: 'color: none of the given node ids exist in the caller project' }
      }
      const byId = new Map(changed.map((node) => [node.id, node]))
      source.project.nodes = source.project.nodes.map((node) => byId.get(node.id) ?? node)
      await this.castAndSave(workspace)
      await this.publishPersisted([source.project.id])
      const skipped = ids.length - changed.length
      const note = skipped ? ` (${skipped} unknown id(s) skipped)` : ''
      return {
        ok: true,
        message: `colored ${changed.length} node(s) ${color}${note}`,
        result: { colored: changed.map((node) => node.id), skipped, color }
      }
    })
  }

  /** A team is validated and persisted as one batch before any session starts. */
  orchestrate(verb: 'spawn-team' | 'verify', sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      if (!verified) return { ok: false, error: `${verb}-identity-refused: requires verified node identity` }
      const flagError = unsupportedFlags(args, new Set(verb === 'spawn-team' ? ['team', 'label', 'dry-run'] :
        ['node', 'agent', 'lenses', 'focus', 'synthesis', 'label']))
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      if (!dryRunRequested(args) && this.deps.releaseHeadlessAfterWork && !this.deps.ptyManager.persistentSpawnAvailable()) {
        return { ok: false, error: `${verb}-backend-unavailable: headless execution requires a persistent backend` }
      }
      const initialWorkspace = await this.readWorkspace()
      const initial = sourceProject(initialWorkspace, sourceNodeId)
      if (!initial || !sourceCanControl(initial.node, this.deps.agentIdOf)) return { ok: false, error: `${verb}-source-refused: requires a control-capable source in one saved project` }
      if (initial.project.ssh || initial.node.ssh || initial.node.sshRemoteTmux || initial.project.unavailable) return { ok: false, error: `${verb}-host-refused: requires an available local project` }
      let origin = initial.node
      let roles: PlannedTeamRole[]
      let lenses: string[] | undefined
      if (verb === 'spawn-team') {
        const parsed = parseTeamSpec(args.team ?? '', SERVER_AGENTS)
        if (!parsed.ok) return { ok: false, error: `${verb}: ${parsed.error}` }
        roles = planIndependentTeam(parsed.roles)
      } else {
        const targetId = (args.node ?? '').trim()
        const target = initial.project.nodes.find((n) => n.id === targetId)
        if (!target || !this.inCallerProject(sourceNodeId, targetId, initialWorkspace, initial.project) ||
          (targetId !== sourceNodeId && !this.ownsMutation(sourceNodeId, targetId, initialWorkspace, initial.project))) {
          return this.ownershipRefusal(verb, sourceNodeId, targetId)
        }
        const targetAgent = effectiveAgentId(target, this.deps.agentIdOf)
        const agent = args.agent || targetAgent
        if (target.kind !== 'terminal' || !targetAgent || !canContextLink(targetAgent) || !agent || !SERVER_AGENTS.has(agent) || !canContextLink(agent as AgentId)) {
          return { ok: false, error: 'verify-agent-refused: target and reviewers must support linked context on this backend' }
        }
        const shimPath = this.deps.contextShimPath?.()
        if (!shimPath) return { ok: false, error: 'verify-context-unavailable: linked context is not initialized on this host' }
        const plan = planVerification({ targetId, targetTitle: target.title || targetId, agent, shimPath,
          hostPlatform: process.platform, lenses: args.lenses, focus: args.focus, synthesis: args.synthesis })
        roles = plan.roles; lenses = plan.lenses; origin = target
      }
      const proofOf = (node: CanvasNodeState) => stableStringify({ kind: node.kind, agent: effectiveAgentId(node, this.deps.agentIdOf),
        session: this.deps.sessionOf?.(node.id) ?? node.agentSessionId, cwd: node.cwd, account: node.accountId, ssh: node.ssh, remote: node.sshRemoteTmux })
      const originProof = proofOf(origin)
      const settings = this.deps.settings()
      const accountFor = (role: PlannedTeamRole, project: Project, from: CanvasNodeState, current: Settings): string | undefined => {
        const inherited = effectiveAgentId(from, this.deps.agentIdOf) === role.agent ? from.accountId : undefined
        const id = inherited || (role.agent === 'claude' ? project.defaultAccountId : undefined)
        if (!id || (role.agent !== 'claude' && role.agent !== 'codex')) return undefined
        const account = (role.agent === 'claude' ? current.claudeAccounts : current.codexAccounts)?.find((a) => a.id === id)
        if (!account || account.pending || account.host) throw new Error(`${verb}-account-refused: ${id} is not a ready local ${role.agent} account`)
        return id
      }
      let accounts: Array<string | undefined>
      try {
        accounts = roles.map((role) => accountFor(role, initial.project, origin, settings))
        for (const [index, role] of roles.entries()) {
          const id = accounts[index]
          if (id) {
            const home = role.agent === 'claude' ? claudeConfigDirFor(id) : codexHomeForAccount(platform().userDataDir, id)
            if (!(await fs.stat(home)).isDirectory()) throw new Error('account home unavailable')
          }
          if (role.promptFile && !(await fs.stat(role.promptFile)).isFile()) throw new Error(`prompt file unavailable: ${role.promptFile}`)
        }
      } catch (error) { return { ok: false, error: `${verb}-input-refused: ${String(error)}` } }
      if (dryRunRequested(args)) return { ok: true, message: `Dry run: would open ${roles.length} team member(s) in ${args.label || 'Team'}. Nothing was opened.`,
        result: { dryRun: true, label: args.label || 'Team', roles: roles.map(({ afterNodes: _n, afterRoles: _r, ...role }) => role) } }
      const probes = await Promise.all([
        this.deps.cliCaps(), this.deps.grokCaps(), this.deps.codexCaps(), this.deps.codexSharedIdentity()
      ]).catch(() => null)
      if (!probes) return { ok: false, error: `${verb}-backend-unavailable: capability probes failed; no nodes were created` }
      const [caps, grokCaps, codexCaps, sharedIdentity] = probes
      const launchInfo = await this.deps.projectLaunchInfo?.(initial.project.id).catch(() => null)
      if (roles.some((r, i) => r.agent === 'codex' && accounts[i] && !sharedIdentity)) return { ok: false, error: `${verb}-account-refused: managed Codex identity is unavailable` }
      const launches = await Promise.all(roles.map((role) => launchPromptFor({ ...role, localFs: true }, {
        saveUpload: (name, bytes) => saveUpload(platform().userDataDir, name, bytes), encodeBase64: (text) => Buffer.from(text, 'utf8').toString('base64')
      })))
      const ids = roles.map(() => nextId('term'))
      const groupId = nextId('group')
      const commands = new Map<string, string>()
      let created: CanvasNodeState[] = []
      let project: Project | undefined
      let editStarted = false
      let requestTrust = false
      try {
        const edit = await this.contentWriter.edit((workspace): ServerControlReply => {
          const fresh = sourceProject(workspace, sourceNodeId)
          if (!fresh || fresh.project.id !== initial.project.id || fresh.project.cwd !== initial.project.cwd || fresh.project.ssh || fresh.project.unavailable ||
            fresh.node.ssh || fresh.node.sshRemoteTmux || !sourceCanControl(fresh.node, this.deps.agentIdOf)) return { ok: false, error: `${verb}-source-changed: inspect the source project before retrying` }
          const from = fresh.project.nodes.find((n) => n.id === origin.id)
          if (!from || proofOf(from) !== originProof || !this.inCallerProject(sourceNodeId, from.id, workspace, fresh.project) || from.ssh || from.sshRemoteTmux ||
            (verb === 'verify' && from.id !== sourceNodeId && !this.ownsMutation(sourceNodeId, from.id, workspace, fresh.project))) {
            return { ok: false, error: `${verb}-target-changed: inspect the target project before retrying` }
          }
          const current = this.deps.settings()
          const size = terminalSize(current)
          for (const [index, role] of roles.entries()) {
            if (accountFor(role, fresh.project, from, current) !== accounts[index]) return { ok: false, error: `${verb}-account-changed: review the selected account before retrying` }
          }
          created = roles.map((role, index) => {
            const agent = role.agent as BuiltinAgentId
            const config = AGENT_CONFIG[agent]
            const permissionMode = agent === 'claude' ? gatePermissionMode(resolvePermissionMode(fresh.project, current), caps.autoPermissionMode) : resolvePermissionMode(fresh.project, current)
            const sessionIdFlagSupported = supportsSessionIdFlag(agent, caps.sessionIdFlag, grokCaps.sessionIdFlag)
            const sessionId = sessionIdFlagSupported ? randomUUID() : undefined
            const launchOverride = projectLaunchOverride(agent, launchInfo, current)
            requestTrust ||= launchOverride.requestTrust
            const command = assembleLaunchCommand({ agentId: agent, initialPrompt: launches[index].prompt,
              promptFile: launches[index].promptFile, model: role.model, permissionMode, sessionId, sessionIdFlagSupported,
              launchCmdOverride: launchOverride.command, sharedIdentity,
              approvalCaps: { codexApprovalValues: codexCaps.approvalValues, codexNoDaemon: codexCaps.noDaemon ?? null }
            }, this.deps.env ?? process.env).command
            const after = [...role.afterNodes, ...role.afterRoles.map((i) => ids[i])]
            const awaitWorking = [...role.afterRoles.map((i) => ids[i]), ...role.afterNodes.filter((id) =>
              this.awaitingFirstWorking.has(id) || this.deps.stateVerified?.(id) !== true)]
            const mustWait = after.some((id) => awaitWorking.includes(id) || this.handedOver(id) || this.deps.stateVerified?.(id) !== true || this.deps.stateOf(id) !== 'done')
            if (!mustWait) commands.set(ids[index], command)
            const accountId = accounts[index]
            return { id: ids[index], kind: 'terminal', position: { x: 0, y: 0 }, size: { ...size },
              title: role.title || config.label, titleAuto: !role.title, color: agentAccountColor(agent, accountId, {
                claude: current.claudeAccounts ?? [], codex: current.codexAccounts ?? []
              }) ?? config.color, group: null, agentId: agent, cwd: from.cwd || fresh.project.cwd, openedBy: sourceNodeId,
              ...(accountId ? { accountId } : {}), ...(role.model ? { agentModel: role.model } : {}),
              ...(sessionId ? { agentSessionId: sessionId } : {}), pendingLaunch: { command, after, executor: 'server',
                attempted: !mustWait, ...(!mustWait ? { manualOnly: true } : {}), ...(awaitWorking.length ? { awaitWorking } : {}),
                ...(launches[index].promptFile ? { promptFile: launches[index].promptFile } : {}) }
            }
          })
          const grid = current.snapToGrid ? current.gridSize : 0
          const live = storedGeometryNodes([...fresh.project.nodes, ...created])
          const arranged = applyStoredGeometry([...fresh.project.nodes, ...created], arrangeNodes(live, ids, { layout: 'grid' }))
          const frame: CanvasNodeState = { id: groupId, kind: 'group', position: { x: 0, y: 0 }, size: { width: 200, height: 140 },
            title: args.label || (verb === 'verify' ? `Verify: ${from.title || from.id}` : 'Team'), color: '#8b8b8b', group: null, openedBy: sourceNodeId }
          const grouped = wrapStoredNodes(arranged, ids, frame, grid)
          if (!grouped) throw new Error('could not construct team frame')
          const group = grouped.find((n) => n.id === groupId)!
          group.position = placeBelowSource(fresh.project.nodes, sourceNodeId, { w: group.size.width, h: group.size.height }, { snapGrid: grid })!
          created = grouped.filter((n) => ids.includes(n.id))
          const ropes = [...(fresh.project.ropes ?? [])]
          const bridges = [...(fresh.project.bridges ?? [])]
          for (const [index, role] of roles.entries()) {
            addEdge(ropes, sourceNodeId, ids[index], 'ctrl')
            if (canContextLink(effectiveAgentId(fresh.node, this.deps.agentIdOf)!) && canContextLink(role.agent as AgentId)) addEdge(bridges, sourceNodeId, ids[index], 'link')
            for (const dep of [...role.afterNodes, ...role.afterRoles.map((i) => ids[i])]) {
              const id = waitRopeId(dep, ids[index])
              if (!ropes.some((edge) => edge.id === id)) ropes.push({ id, source: dep, target: ids[index] })
              addEdge(bridges, ids[index], dep, 'link')
            }
          }
          project = fresh.project
          editStarted = true
          project.nodes = grouped; project.ropes = ropes; project.bridges = bridges
          return { ok: true }
        })
        if (!edit.value.ok || !edit.saved || !project) return edit.value.ok ? { ok: false, error: `${verb}-not-saved: no sessions were started` } : edit.value
        for (const id of [...ids, groupId]) this.ownership.record(id, { sourceNodeId, projectId: project.id })
        for (const node of created) { this.strictArms.add(node.id); this.strictLaunchIdentities.set(node.id, launchIdentity(project, node)) }
        if (requestTrust) { try { void this.deps.requestAgentsTrust?.(project.id) } catch { /* next launch can ask again */ } }
        await this.publishPersisted([project.id])
        const launch = await this.startCreated(project, created, commands, true)
        const result = { groupId, memberIds: ids, ...launch, ...(lenses ? { targetId: origin.id, lenses, reviewerIds: ids.slice(0, lenses.length), judgeId: ids[lenses.length] ?? null } : {}) }
        if (launch.failed.length) return { ok: false, error: launchFailedError(created.filter((n) => launch.failed.includes(n.id)).map((n) => ({
          id: n.id, reason: launch.reasons[n.id], retained: !!n.pendingLaunch
        })), verb), result }
        return { ok: true, message: `opened ${ids.length} member(s) in group ${groupId}; launch delivery does not confirm agent startup`, result }
      } catch (error) {
        return { ok: false, error: editStarted ? `${verb}-save-uncertain: inspect list before repeating; ${String(error)}` : String(error) }
      }
    })
  }

  async worktree(verb: 'open-worktree' | 'close-worktree', sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      if (!verified) return { ok: false, error: `${verb}-identity-refused: verified source required` }
      const allowed = new Set(verb === 'open-worktree' ? ['branch', 'base', 'path', 'group', 'dry-run'] : ['group', 'mode'])
      const unknown = Object.keys(args).filter((flag) => !allowed.has(flag))
      if (unknown.length) return { ok: false, error: `${verb}-unsupported-flags: ${unknown.join(', ')}` }
      if (!this.deps.worktrees) return { ok: false, error: `${verb}-backend-unavailable: worktree lifecycle is not initialized` }
      try {
        return await worktreeControl(verb, args, this.deps.worktrees, {
          writer: this.contentWriter, settings: this.deps.settings, stopped: () => this.stopped,
          actor: (workspace) => {
            const found = sourceProject(workspace, sourceNodeId)
            return found && !found.project.ssh && !found.project.unavailable && !isRemoteSessionNode(found.node) &&
              sourceCanControl(found.node, this.deps.agentIdOf) ? found : null
          },
          permitted: (workspace, project, id) => this.inCallerProject(sourceNodeId, id, workspace, project) &&
            (id === sourceNodeId || this.ownsMutation(sourceNodeId, id, workspace, project)),
          record: (groupId, projectId) => this.ownership.record(groupId, { projectId, sourceNodeId }),
          publish: (id) => this.publishPersisted([id]), newGroupId: () => nextId('group')
        })
      } catch (error) { return { ok: false, error: `${verb}-refused: ${String(error)}` } }
    })
  }

  /** Start a durable batch, then patch outcomes against fresh state. Never called before save. */
  private async startCreated(
    target: Project, created: CanvasNodeState[], commands: ReadonlyMap<string, string>, trackAgentStartup: boolean,
    isCurrent?: () => boolean
  ) {
    const failed: string[] = []
    // Why each one failed, reported per id (#925): a reply that says only "retained for Run now"
    // hides the reason Run now would repeat (`line-too-long`).
    const reasons: Record<string, HeadlessLaunchFailure> = {}
    const fail = (id: string, reason: HeadlessLaunchFailure): void => {
      failed.push(id)
      reasons[id] = reason
    }
    for (const node of created) {
      try {
        if (this.stopped || (isCurrent && !isCurrent())) { fail(node.id, 'cancelled'); continue }
        const currentWorkspace = (await this.contentWriter.edit((fresh) => fresh)).value
        const holders = nodeProjects(currentWorkspace, node.id)
        const currentProject = holders.length === 1 && holders[0].id === target.id ? holders[0] : undefined
        const currentNode = currentProject?.nodes.find((n) => n.id === node.id)
        if (!currentProject || currentProject.ssh || !currentNode || isRemoteSessionNode(currentNode) ||
          currentNode.kind !== node.kind || currentNode.agentId !== node.agentId || currentNode.accountId !== node.accountId ||
          currentNode.cwd !== node.cwd || currentProject.cwd !== target.cwd ||
          currentNode.pendingLaunch?.command !== node.pendingLaunch?.command) { fail(node.id, 'cancelled'); continue }
        if (!(await this.accountReady(node))) { fail(node.id, 'account-unavailable'); continue }
        if (!(await promptReadable(node.pendingLaunch?.promptFile))) { fail(node.id, 'prompt-file-missing'); continue }
        const command = commands.get(node.id)
        if (!command) {
          // Nothing to deliver now (a plain terminal, or a launch held for `--after`): spawn only.
          const result = await this.attach(target, node)
          if (!result.sessionId) fail(node.id, 'spawn-failed')
          else if (this.deps.releaseHeadlessAfterWork && result.persistent === false) fail(node.id, 'not-persistent')
          else if (trackAgentStartup && result.fresh) this.awaitingFirstWorking.add(node.id)
          if (this.deps.releaseHeadlessAfterWork) { this.attached.delete(node.id); this.deps.ptyManager.releaseHeadless(node.id) }
          continue
        }
        const launched = await this.launch(target, node, command, isCurrent)
        if (trackAgentStartup && launched.fresh) this.awaitingFirstWorking.add(node.id)
        if (launched.outcome === 'delivered') { this.noteDelivered(node.id, command); node.pendingLaunch = undefined }
        else fail(node.id, launched.reason)
      } catch {
        // The launcher answers its own failures; only the spawn-only `attach` above throws.
        fail(node.id, 'spawn-failed')
      }
    }

    // Creation and delivery are separate transactions. A refused/throwing send retains the
    // exact command for the user's Run now action; boot still cannot adopt persisted nodes.
    // The launches took time, so their outcomes are written onto a fresh read, never this copy.
    const outcomes: NodePatch[] = []
    for (const node of created) {
      const command = commands.get(node.id)
      if (failed.includes(node.id) && node.pendingLaunch) {
        node.pendingLaunch.manualOnly = true
        outcomes.push(claimLaunch(target.id, node.id, node.pendingLaunch.command, false))
      } else if (command && !node.pendingLaunch) {
        outcomes.push(clearLaunch(target.id, node.id, command))
      }
    }
    await this.savePatches(outcomes)
    await this.publishPersisted([target.id])
    const ids = created.map((node) => node.id)
    const queuedIds = created
      .filter((node) => node.pendingLaunch && !failed.includes(node.id))
      .map((node) => node.id)
    const deliveredIds = created
      .filter((node) => commands.has(node.id) && !node.pendingLaunch && !failed.includes(node.id))
      .map((node) => node.id)
    return { failed, reasons, ids, queuedIds, deliveredIds }
  }

  private open(
    sourceNodeId: string,
    verb: 'open-terminal' | 'open-agent',
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(
        args,
        // `run-now` (#925) is a no-op, since a server open already delivers immediately; only its
        // pairing with `--after` is refused, just below.
        verb === 'open-terminal'
          ? new Set(['count', 'cwd', 'cmd', 'after', 'after-success', 'success-deadline', 'project', 'run-now', 'group'])
          : new Set([
              'agent',
              'count',
              'cwd',
              'prompt',
              'after',
              'after-success',
              'success-deadline',
              'project',
              'model',
              'issue',
              'group',
              'run-now'
            ])
      )
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      // "Start now" and "start when X is done" contradict each other: refused in the desktop's
      // words, before anything is created, rather than silently opening an armed node.
      if (runNowRequested(args) && args.after) return { ok: false, error: RUN_NOW_AFTER_REFUSAL }
      if (runNowRequested(args) && args['after-success'] !== undefined) {
        return { ok: false, error: RUN_NOW_AFTER_SUCCESS_REFUSAL }
      }
      // `--after-success` (@shared/station-outcome): the shape was checked in `parseControlRequest`;
      // re-parsed here with the same grammar. The ids are folded into `after` — a success wait is
      // `--after` plus the station's report — so the existence, status-reporting and creator checks
      // below apply to them unchanged; the hold adds the report.
      const successParsed =
        args['after-success'] !== undefined ? parseAfterSuccessArg(args['after-success']) : undefined
      if (successParsed && !successParsed.ok) return { ok: false, error: `${verb}: ${successParsed.error}` }
      const successIds = successParsed?.ok ? successParsed.ids : []
      const successDeadline = parseSuccessDeadlineArg(args['success-deadline'])
      if (!successDeadline.ok) return { ok: false, error: `${verb}: ${successDeadline.error}` }
      const afterArg = successIds.length
        ? [
            ...new Set([
              ...(args.after ?? '').split(',').map((id) => id.trim()).filter(Boolean),
              ...successIds
            ])
          ].join(',')
        : args.after
      if (!verified) {
        return {
          ok: false,
          error: `${verb}-identity-refused: Server Edition ${verb} requires verified node identity`
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      const target = this.resolveTarget(workspace, source, verb, args, verified)
      if ('ok' in target) return target
      const group = coldResolveGroup(target.nodes, args.group, verb)
      if (!group.ok) return { ok: false, error: group.error }
      if (group.groupId && !this.ownsMutation(sourceNodeId, group.groupId, workspace, target)) {
        return this.ownershipRefusal(verb, sourceNodeId, group.groupId)
      }
      const groupCwd = coldGroupCwd(target.nodes, group.groupId, !!target.ssh)
      if (groupCwd) {
        try {
          if (!(await fs.stat(groupCwd)).isDirectory()) throw new Error('group folder unavailable')
          // A worktree binding alone is not proof that its checkout still exists.
          const binding = target.nodes.find((n) => n.worktree?.path === groupCwd)?.worktree
          if (binding) {
            const list = await this.deps.worktrees?.git.worktreeList(binding.repoPath)
            if (!list?.ok || !list.entries.some((e) => !e.prunable && e.path === binding.path)) throw new Error('worktree unavailable')
          }
        } catch { return { ok: false, error: `${verb}-group-cwd-unavailable: inspect and recover the frame checkout before opening work` } }
      }
      const originalNodes = group.groupId ? structuredClone(target.nodes) : undefined
      const after = this.resolveAfter(target, afterArg, verb)
      if (!Array.isArray(after)) return after
      const unownedAfter = this.unownedMutation(sourceNodeId, after, workspace, target)
      if (unownedAfter) return this.ownershipRefusal(verb, sourceNodeId, unownedAfter)
      // A success wait is only as good as the station's ability to REPORT: only an agent with canvas
      // control has `report-outcome`, so waiting on anything else could only end at the deadline.
      for (const depId of successIds) {
        const dep = target.nodes.find((candidate) => candidate.id === depId)
        if (!dep || !sourceCanControl(dep, this.deps.agentIdOf)) {
          return { ok: false, error: successDepRefusal(verb, depId) }
        }
      }
      const successHold: SuccessWaitHold | undefined = successIds.length
        ? { deps: successIds, deadlineAt: this.now() + successDeadline.ms }
        : undefined
      // `--issue`: resolved against the project the node OPENS IN, before anything is written. The
      // shape gate already ran in `parseControlRequest`; this re-parses with the same grammar.
      let issueRef: IssueRef | undefined
      if (verb === 'open-agent' && args.issue !== undefined) {
        const board = target.kanban?.github
        const repository = board
          ? (await this.deps.issueRepository?.(target.id).catch(() => null)) ?? board.repository ?? null
          : null
        const issue = resolveIssueArg(args.issue, repository)
        if (!issue.ok) return { ok: false, error: `open-agent: ${issue.error}` }
        issueRef = issue.ref
      }

      const settings = this.deps.settings()
      const nodeSize = terminalSize(settings)
      const caps = verb === 'open-agent' ? await this.deps.cliCaps() : null
      const grokCaps = verb === 'open-agent' ? await this.deps.grokCaps() : null
      const agentId = args.agent as BuiltinAgentId | undefined
      if (verb === 'open-agent' && (!agentId || !SERVER_AGENTS.has(agentId))) {
        return {
          ok: false,
          error: 'open-agent: Server Edition v1 supports --agent claude|codex|gemini'
        }
      }
      // The Server shell owns the same shared Codex app-server spine as desktop. Ask its boot-time
      // capability probe at the launch boundary: true routes through `nodeterm-codex`; every
      // unavailable/failed case stays on the safe bare command supplied by the shared assembler.
      const codexSharedIdentity =
        verb === 'open-agent' && agentId === 'codex'
          ? await this.deps.codexSharedIdentity().catch(() => false)
          : false
      // Which `--ask-for-approval` values this host's codex has. Asked only where it can matter,
      // right beside the other codex question. Every failure answers `null` = unknown = the
      // baseline vocabulary, which is the launch line this factory has always produced for Auto
      // and Bypass; only `untrusted` (gone since 0.149.0) depends on a real answer.
      const codexCaps =
        verb === 'open-agent' && agentId === 'codex'
          ? await this.deps.codexCaps().catch(() => UNKNOWN_CODEX_CLI_CAPS)
          : UNKNOWN_CODEX_CLI_CAPS

      const count = parseCount(args.count, verb === 'open-terminal' ? TERMINAL_LIMIT : AGENT_LIMIT)
      const created: CanvasNodeState[] = []
      const commands = new Map<string, string>()
      const ropes = [...(target.ropes ?? [])]
      const bridges = [...(target.bridges ?? [])]
      const startIndex = target.nodes.length
      const cwd = args.cwd || groupCwd || (target.id === source.project.id ? source.node.cwd : undefined) || target.cwd
      // Snapshot dependency state at the arm boundary. A `working` state is already positive
      // evidence that this fresh process made it through its boot composer; a later `done` may
      // release it. An unknown/waiting fresh spawn needs a working event after this snapshot.
      const afterStates = new Map(after.map((depId) => [depId, this.deps.stateOf(depId)]))
      for (const [depId, state] of afterStates) {
        if (state === 'working') this.awaitingFirstWorking.delete(depId)
      }
      const mustWait =
        // A `done` from before new work was handed over is not this wait's `done`
        // (core/station-handover.ts): the creation shortcut must not start the node on it.
        after.some((depId) => afterStates.get(depId) !== 'done' || this.handedOver(depId)) ||
        (!!successHold &&
          !successWaitSatisfied(successHold, (d) => this.successFacts(target, d), this.now()))
      const awaitWorking = after.filter((depId) =>
        afterStates.get(depId) !== 'done' &&
        afterStates.get(depId) !== 'working' &&
        this.awaitingFirstWorking.has(depId)
      )

      for (let i = 0; i < count; i++) {
        let command = args.cmd
        let title = `Terminal ${startIndex + i + 1}`
        let color: string = SYSTEM_NODE_COLORS[(startIndex + i) % SYSTEM_NODE_COLORS.length]
        let mintedSessionId: string | undefined
        let permissionMode
        if (verb === 'open-agent') {
          const config = AGENT_CONFIG[agentId as BuiltinAgentId]
          title = config.label
          color = config.color
          const resolvedMode = resolvePermissionMode(target, settings)
          permissionMode = agentId === 'claude'
            ? gatePermissionMode(resolvedMode, caps?.autoPermissionMode === true)
            : resolvedMode
          const sessionIdFlagSupported = supportsSessionIdFlag(
            agentId as AgentId,
            caps?.sessionIdFlag === true,
            grokCaps?.sessionIdFlag === true
          )
          mintedSessionId = sessionIdFlagSupported ? randomUUID() : undefined
          command = assembleLaunchCommand(
            {
              agentId: agentId as AgentId,
              // An issue-bound session's first prompt is the REFERENCE line, never the issue's text.
              initialPrompt: issueRef ? issueLaunchPrompt(issueRef, args.prompt) : args.prompt,
              permissionMode,
              sessionId: mintedSessionId,
              sessionIdFlagSupported,
              launchCmdOverride: settings.agentLaunchCommands?.[agentId as BuiltinAgentId],
              sharedIdentity: codexSharedIdentity,
              approvalCaps: {
                codexApprovalValues: codexCaps.approvalValues,
                codexNoDaemon: codexCaps.noDaemon ?? null
              },
              model: args.model
            },
            this.deps.env ?? process.env
          ).command
        }

        const id = nextId('term')
        // Persist before attempting delivery, including launches whose gates are already open.
        // A failed attach/send must leave the command available to the user's Run now action.
        const pendingLaunch = command
          ? {
              after,
              command,
              executor: 'server' as const,
              attempted: !mustWait,
              ...(!mustWait ? { manualOnly: true } : {}),
              ...(awaitWorking.length ? { awaitWorking: [...awaitWorking] } : {}),
              ...(successHold ? { afterSuccess: successHold } : {})
            }
          : undefined
        const node: CanvasNodeState = {
          id,
          kind: 'terminal',
          position: group.groupId ? groupSlot(target.nodes.filter((n) => n.parentId === group.groupId).length + i, nodeSize.width, nodeSize.height) :
            placeRight(target, source.node, nodeSize, created),
          size: { ...nodeSize },
          title,
          ...(verb === 'open-agent' ? { titleAuto: true } : {}),
          color,
          group: null,
          tags: [],
          cwd,
          ...(group.groupId ? { parentId: group.groupId } : {}),
          ...(verb === 'open-agent' ? { agentId: agentId as AgentId } : {}),
          ...(args.model && verb === 'open-agent' ? { agentModel: args.model } : {}),
          ...(issueRef && verb === 'open-agent' ? { issueRef } : {}),
          ...(mintedSessionId ? { agentSessionId: mintedSessionId } : {}),
          ...(source.node.accountId && verb === 'open-agent' && effectiveAgentId(source.node, this.deps.agentIdOf) === agentId &&
          (agentId === 'claude' || agentId === 'codex')
            ? { accountId: source.node.accountId }
            : {}),
          ...(pendingLaunch ? { pendingLaunch } : {})
        }
        created.push(node)
        if (command && !mustWait) commands.set(id, command)
        addEdge(ropes, source.node.id, id, 'ctrl')

        if (verb === 'open-agent') {
          const sourceAgent = effectiveAgentId(source.node, this.deps.agentIdOf)
          if (sourceAgent && canContextLink(sourceAgent) && canContextLink(agentId as AgentId)) {
            addEdge(bridges, source.node.id, id, 'link')
          }
          for (const depId of after) {
            const dep = target.nodes.find((candidate) => candidate.id === depId)
            const depAgent = dep ? effectiveAgentId(dep, this.deps.agentIdOf) : undefined
            if (depAgent && canContextLink(depAgent) && canContextLink(agentId as AgentId))
              addEdge(bridges, id, depId, 'link')
          }
        }
      }

      target.nodes.push(...created)
      if (group.groupId) {
        const frame = target.nodes.find((n) => n.id === group.groupId)!
        const size = groupSizeFor(target.nodes.filter((n) => n.parentId === group.groupId).length, nodeSize.width, nodeSize.height)
        frame.size = { width: Math.max(frame.size.width, size.width), height: Math.max(frame.size.height, size.height) }
        target.nodes = applyStoredGeometry(target.nodes, fitGeometryAncestors(storedGeometryNodes(target.nodes), group.groupId,
          settings.snapToGrid ? settings.gridSize : 0))
        const changed = originalNodes!.filter((before) => stableStringify(before) !== stableStringify(target.nodes.find((n) => n.id === before.id))).map((n) => n.id)
        const denied = this.unownedMutation(sourceNodeId, changed, workspace, target)
        if (denied) return this.ownershipRefusal(verb, sourceNodeId, denied)
      }
      target.ropes = ropes
      target.bridges = bridges
      // Creation is written BEFORE anything is launched, and a refused save (canvas control is
      // stopping) is a failure here: a launch into a node that is not on the canvas is an orphan
      // agent session nobody can see.
      if (!(await this.castAndSave(workspace))) {
        return {
          ok: false,
          error: `${verb}-not-saved: nothing was opened: the canvas could not be written (canvas control is stopping)`
        }
      }
      for (const node of created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: target.id })
      }
      await this.publishPersisted([target.id])
      if (issueRef) {
        for (const node of created) {
          await this.logRun(target.id, runStartedEvent(issueRef, {
            id: node.id,
            title: node.title,
            agentId: node.agentId,
            agentSessionId: node.agentSessionId
          }))
        }
      }

      const { failed, reasons, ids, queuedIds, deliveredIds } = await this.startCreated(
        target, created, commands, verb === 'open-agent'
      )
      const launchResult = { queued: queuedIds.length > 0, queuedIds, deliveredIds, failed }
      if (failed.length) {
        return {
          ok: false,
          error: launchFailedError(
            created
              .filter((node) => failed.includes(node.id))
              .map((node) => ({ id: node.id, reason: reasons[node.id], retained: !!node.pendingLaunch })),
            verb
          ),
          result: { ids, id: ids[0], after, ...launchResult, reasons, ...(successHold ? { afterSuccess: successHold.deps } : {}) }
        }
      }
      return {
        ok: true,
        message:
          `opened ${count} ${verb === 'open-agent' ? `${agentId} session` : 'terminal'}(s): ` +
          ids.join(', ') +
          (queuedIds.length ? `; queued: ${queuedIds.join(', ')}` : '') +
          (deliveredIds.length ? '; launch delivered; agent startup is not confirmed' : '') +
          (successHold ? `; waits for a reported success from: ${successHold.deps.join(', ')}` : ''),
        result: {
          ids,
          id: ids[0],
          after,
          ...launchResult,
          ...(issueRef ? { issue: `${issueRef.owner}/${issueRef.repo}#${issueRef.number}` } : {}),
          ...(successHold ? { afterSuccess: successHold.deps } : {})
        }
      }
    })
  }

  sticky(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const parsed = parseStickyArgs(args)
      if ('error' in parsed) return { ok: false, error: `sticky: ${parsed.error}` }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const candidates = source.project.nodes.map((node) => ({
        id: node.id,
        sticky: node.kind === 'sticky',
        title: node.title
      }))
      const resolved = resolveStickyRef(candidates, parsed.ref)
      if ('error' in resolved) return { ok: false, error: `sticky: ${resolved.error}` }

      let node: CanvasNodeState | undefined
      let created = false
      if ('id' in resolved) node = source.project.nodes.find((candidate) => candidate.id === resolved.id)
      else if (parsed.create) {
        created = true
        const stickySize = resolveDefaultNodeSize(
          this.deps.settings().defaultNodeSizes?.sticky,
          STICKY_NODE_SIZE,
          STICKY_NODE_MIN_SIZE
        )
        node = {
          id: nextId('sticky'),
          kind: 'sticky',
          position: placeRight(source.project, source.node, stickySize),
          size: stickySize,
          title: oneLine(parsed.ref) || 'Note',
          color: '#ffd60a',
          group: null,
          text: ''
        }
        source.project.nodes.push(node)
        const ropes = [...(source.project.ropes ?? [])]
        addEdge(ropes, source.node.id, node.id, 'ctrl')
        source.project.ropes = ropes
      } else {
        return {
          ok: false,
          error: `sticky: no note named "${parsed.ref}"; pass --create yes to create it`
        }
      }
      if (!node) return { ok: false, error: 'sticky: note disappeared while resolving it' }
      if (!created && !this.ownsMutation(sourceNodeId, node.id, workspace, source.project)) {
        return this.ownershipRefusal('sticky', sourceNodeId, node.id)
      }

      const write = applyStickyWrite(node.text ?? '', parsed.write)
      if ('error' in write) return { ok: false, error: `sticky: ${write.error}` }
      node.text = write.text
      node.textUpdatedAt = (this.deps.now ?? Date.now)()
      node.textUpdatedBy = source.node.title || source.node.id
      await this.castAndSave(workspace)
      if (created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: source.project.id })
      }
      await this.publishPersisted([source.project.id])
      return {
        ok: true,
        message: `${created ? 'created' : 'updated'} sticky ${node.id} (${write.mode})`,
        result: { id: node.id, created, mode: write.mode }
      }
    })
  }

  /**
   * Boot is intentionally inert. Creator proof is process-local and empty after restart, so even
   * sending a persisted command would control a session this process cannot attribute. Owner opens
   * and browser views are the only cold-spawn authority; current-run agent events drive arms below.
   */
  start(): Promise<void> {
    return Promise.resolve()
  }

  onAgentEvent(event: Pick<NormalizedAgentEvent, 'nodeId' | 'state' | 'errored' | 'newTurn'>): void {
    if (this.stopped || !event?.nodeId) return
    if (event.state === 'done' && event.errored === true) this.lastTurnErrored.add(event.nodeId)
    else if (event.newTurn === true) this.lastTurnErrored.delete(event.nodeId)
    if (event.state === 'working') this.awaitingFirstWorking.delete(event.nodeId)
    if (event.state === 'working' || event.state === 'done') void this.refreshArmed(event)
  }

  refreshArmed(observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): Promise<void> {
    return this.runExclusive(async () => {
      if (this.stopped) return
      // A READ-ONLY look: every working/done hook event lands here, and most find nothing armed or
      // nothing ready. Nothing is copied or saved until an arm actually moves; then each save goes
      // through `savePatches`, a fresh read with only this pass's own patches re-applied, because a
      // delivery below can take seconds and must never write back the view it started from.
      const view = await this.readWorkspace()
      const patches: NodePatch[] = []
      const changedProjects = new Set<string>()
      let unsaved = false
      const patch = (p: NodePatch): void => {
        patches.push(p)
        changedProjects.add(p.projectId)
        unsaved = true
      }

      for (const project of view.projects) {
        for (const node of project.nodes) {
          const pending = node.pendingLaunch
          if (!pending || pending.executor !== 'server' || !pending.command || pending.manualOnly) continue
          // A persisted arm surviving a restart is data, not creator proof. Only a node freshly
          // spawned for this caller during the current run may receive automatic input.
          if (!this.ownership.ownerOf(node.id)) continue
          const command = pending.command
          if (this.strictArms.has(node.id) && this.strictLaunchIdentities.get(node.id) !== launchIdentity(project, node)) {
            patch(claimLaunch(project.id, node.id, command, false))
            continue
          }
          if (!(await promptReadable(pending.promptFile)) || !(await this.accountReady(node))) {
            patch(claimLaunch(project.id, node.id, command, false))
            continue
          }
          let awaitWorking = pending.awaitWorking
          if (observed?.state === 'working' && awaitWorking?.includes(observed.nodeId) &&
            (!this.strictArms.has(node.id) || this.deps.stateVerified?.(observed.nodeId) === true)) {
            const depId = observed.nodeId
            const rest = awaitWorking.filter((id) => id !== depId)
            awaitWorking = rest.length ? rest : undefined
            // Persist the evidence even if the dependent PTY is temporarily unavailable. Losing
            // this mutation would strand the arm when the next event is the legitimate `done`.
            patch(dropAwaitWorking(project.id, node.id, command, depId))
          }
          for (const depId of awaitWorking ?? []) {
            if (!(observed?.state === 'working' && observed.nodeId === depId))
              this.awaitingFirstWorking.add(depId)
          }
          const ready = pending.after.every((depId) => {
            const stillExists = project.nodes.some((candidate) => candidate.id === depId)
            if (!stillExists) return true
            if (this.strictArms.has(node.id) && this.deps.stateVerified?.(depId) !== true) return false
            if (awaitWorking?.includes(depId)) return false
            if (this.handedOver(depId)) return false
            return observed?.nodeId === depId
              ? observed.state === 'done'
              : this.deps.stateOf(depId) === 'done'
          })
          if (!ready) continue
          // `--after-success`: every named station also REPORTED success. The persisted hold is
          // hand-editable input, so it is re-validated here — a malformed one never fires.
          const successHold = normalizeSuccessWaitHold(pending.afterSuccess)
          if (
            successHold &&
            !successWaitSatisfied(
              successHold,
              (d) => this.successFacts(project, d, observed),
              this.now()
            )
          )
            continue
          // `sessionExists` is a probe, whereas `createHeadless` is attach-or-create. Never call
          // the latter from boot/event reconciliation: a dead node stays dormant until its owner
          // explicitly opens it or a user views it. A probe failure also stays dormant because an
          // unreadable backend is not proof that delivery is safe.
          const live = this.attached.has(node.id) ||
            await this.deps.ptyManager.sessionExists(node.id).catch(() => false)
          if (!live) continue
          // Persist the attempt BEFORE input. A failed/uncertain send (or a crash before its
          // acknowledgement save) must never be replayed by an unrelated hook.
          patch(claimLaunch(project.id, node.id, command, true))
          const claim = await this.savePatches(patches)
          unsaved = false
          // Type ONLY what this pass claimed on disk: the save landed (a stopping factory refuses it)
          // and the claim applied to the fresh read (a teammate may have deleted the node, re-armed it
          // with another command, or claimed it, since the look above).
          if (!claim.saved || !claim.applied[patches.length - 1]) continue
          if (this.strictArms.has(node.id)) {
            const stillValid = await this.contentWriter.edit((fresh) => {
              const projects = nodeProjects(fresh, node.id)
              const project = projects.length === 1 ? projects[0] : undefined
              const current = project?.nodes.find((n) => n.id === node.id)
              return !!project && !!current && this.strictLaunchIdentities.get(node.id) === launchIdentity(project, current)
            })
            if (!stillValid.value) continue
          }
          if (!isLaunchShell(await this.deps.ptyManager.paneCommand(node.id).catch(() => null))) continue
          const delivered = this.strictArms.has(node.id) ?
            (await this.launch(project, node, command)).outcome === 'delivered' :
            (await this.deps.ptyManager.sendText(node.id, command).catch(() => false)) === true
          if (!delivered) continue
          this.noteDelivered(node.id, command)
          patch(clearLaunch(project.id, node.id, command))
        }
      }

      // A working event is definitive for every pending launch in this transaction. Keep the
      // process-local fresh-spawn index aligned even when several arms named the same dependency.
      if (observed?.state === 'working') this.awaitingFirstWorking.delete(observed.nodeId)

      if (unsaved) await this.savePatches(patches)
      if (changedProjects.size) await this.publishPersisted(changedProjects)
    })
  }

  stop(): void {
    this.stopped = true
    this.ownership.clear()
    this.strictArms.clear()
    this.strictLaunchIdentities.clear()
    this.delivered.clear()
    this.projectGrants.clear()
  }
}
