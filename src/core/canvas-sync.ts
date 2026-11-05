// Canvas sync — the reflector.
//
// Every attached client (an Electron renderer, a Server-Edition browser tab) casts its LOCAL canvas
// mutations — nodes, edges and board items (@shared/kanban-ops) — on `canvas:mut`. This service
// stamps each one with a monotone `seq` and sends it back
// out on the same channel to EVERY attached client, so all clients converge on the same node set —
// a teammate's cursor never hovers over stale geometry, and a client whose canvas still held a node
// someone else deleted can no longer write it back on the next whole-file workspace.save.
//
// THE `seq` IS THE POINT, and it is the one piece of state here. Without a total order, two clients
// that edit the same node while each other's mutation is in flight apply them in OPPOSITE orders
// and diverge permanently — see the derivation in src/shared/canvas-order.ts, which is the client
// half of this contract. `seq` is server-authoritative: whatever the client put there is
// overwritten at ingest, so a client cannot forge its way to the front of the order.
//
// IT ECHOES TO THE SENDER TOO — that is deliberate, and it replaced the earlier sender-suppression.
// A sender's own echo is its ACK: it is the only way it learns where its edit landed in the total
// order, which is what lets it decide whether a peer's mutation supersedes its own optimistic
// state. The client drops the echo instead of re-applying it (canvas-order rule 1), so it does not
// fight its own optimistic state, and the publisher's `adopt` guard still means nothing is
// re-published: no loop.
//
// Beyond `seq` it is a pipe, not a store: it holds NO canvas state and persists nothing. The one
// policy it applies is sanitizing what it reflects (`sanitizeCanvasMutation`): a board op is
// repaired, and the exec boundary holds (@shared/node-exec) — `shell`/`ssh.extraArgs` never pass,
// and a held launch (`pendingLaunch`) passes only from an OWNER client to owner clients, stamped
// `origin: 'core'` (fanOutMutation). The canvas itself stays where it has always been — React Flow
// in each renderer — and the disk write stays with WorkspaceStore. On a Server Edition hosting a
// team, the canvas authority hears every stamped op through `setReflectedListener` — with the held
// launch stripped, whoever sent it — and writes shared projects' content from them
// (docs/hosted-team-relay.md); that is the authority's state, never this module's.
//
// NOT RATE-LIMITED, deliberately — unlike presence (see PRESENCE_RATE_BUDGETS). A presence cast is
// a SAMPLED signal whose loss is self-correcting: the next cursor frame carries the current
// position. A mutation is an EDGE: nothing supersedes it and nothing re-announces it, so a dropped
// one is LOST STATE — a node that never appears on a peer's canvas, or a delete that never lands
// (and then gets written back to disk by that peer's next save, which is the very bug Stage 3
// exists to fix). Legitimate traffic is also burstier than any bucket sized for it would survive:
// a drag emits at 20 Hz, and a bulk delete emits N mutations in ONE tick. What IS bounded is the
// PAYLOAD (see isCanvasMutation): an oversized or malformed mutation is refused at ingest, so a
// hostile cast cannot amplify into every peer's socket or wedge a peer's React Flow. If a budget
// is ever needed here, it must queue — never drop.
//
// No electron, no ws, no disk (see no-electron.test.ts).

import { platform, type CorePlatform } from './platform'
import { IPC } from '../shared/ipc'
import { isCanvasMutationBatch, canvasLayoutOf, applyCanvasLayout, type CanvasLayoutTuple } from '../shared/canvas-batch'
import {
  isCanvasMutation,
  isRefId,
  MUTATION_MAX_BYTES,
  sanitizeCanvasMutation,
  stableStringify
} from '../shared/canvas-mutations'
import { normalizeDynamicGroupState } from '../shared/dynamic-groups'
import { COLLAPSED_HEIGHT } from '../shared/node-geometry'
import { GROUP_PAD, GROUP_HEADER } from '../shared/canvas-geometry'
import { sanitizeInboundMutation } from '../shared/node-exec'
import { type ClientId } from '../shared/presence'
import type { CanvasMutation, CanvasMutationBatch, CanvasNodeState, MutationStamp } from '../shared/types'
import { oneLine } from '../shared/one-line'

export interface ClientMutationRejection {
  reason: string
  canonical?: CanvasMutation
  /** Host-only safe ACK when a fresh full correction is unavailable; null retains the pending
   * cast rather than replaying an unsafe optimistic structure. Never an actor permission. */
  acknowledgement?: CanvasMutation | null
}
type ClientMutationAdmission = (projectId: string, mutation: CanvasMutation, fromOwner: boolean) => ClientMutationRejection | null
const clientAdmissions = new WeakMap<CorePlatform, ClientMutationAdmission>()
type MutationObserver = (projectId: string, mutation: CanvasMutation, trusted: boolean) => void
const mutationObservers = new WeakMap<CorePlatform, MutationObserver>()
type BatchObserver = (projectId: string, batch: CanvasMutationBatch, trusted: boolean) => void
const batchObservers = new WeakMap<CorePlatform, BatchObserver>()
const batchSubscribers = new WeakMap<CorePlatform, Set<number>>()
const publishingOn = new WeakSet<CorePlatform>()
type CanvasStructureResolver = (projectId: string) => readonly CanvasNodeState[] | undefined
const structureResolvers = new WeakMap<CorePlatform, CanvasStructureResolver>()
interface StructuralRevision {
  revision: number
  layout: CanvasLayoutTuple | null
  /** A complete host publication outranks a preceding disk getter even after failed IO.
   * Clients never advance this provenance; absence is an explicit host fact too. */
  hostFacts?: { value: CanvasNodeState['dynamicGroup'] }
}
interface StructuralOrder { projects: Map<string, Map<string, StructuralRevision>>; count: number }
const structureOrders = new WeakMap<CorePlatform, StructuralOrder>()
export const CANVAS_STRUCTURE_MAX_ENTRIES = 65_536

/** Current host scene, including in-flight FIFO content. It supplies no actor/launch authority. */
export function setCanvasStructureResolver(resolve: CanvasStructureResolver | null): void {
  if (resolve) structureResolvers.set(platform(), resolve)
  else structureResolvers.delete(platform())
}

function structureCapacity(p: CorePlatform, projectId: string, mutations: readonly CanvasMutation[]): boolean {
  const order = structureOrders.get(p)
  const project = order?.projects.get(projectId)
  const added = new Set(mutations.flatMap((m) => m.op === 'upsert' ? [m.node.id] : m.op === 'remove' ? [m.id] : []))
  return (order?.count ?? 0) + [...added].filter((id) => !project?.has(id)).length <= CANVAS_STRUCTURE_MAX_ENTRIES
}

function noteStructure(p: CorePlatform, projectId: string, m: CanvasMutation, source: 'ordinary' | 'batch' | 'client'): void {
  if (m.op !== 'upsert' && m.op !== 'remove') return
  let order = structureOrders.get(p)
  if (!order) { order = { projects: new Map(), count: 0 }; structureOrders.set(p, order) }
  let project = order.projects.get(projectId)
  if (!project) { project = new Map(); order.projects.set(projectId, project) }
  const id = m.op === 'upsert' ? m.node.id : m.id
  const prior = project.get(id)
  // The canonical reducer's deletion causality still applies to host batch children. A stale
  // upsert rejected there must not make a deleted parent appear alive in this projection.
  if (m.op === 'upsert' && prior?.layout === null && typeof m.seen === 'number' && m.seen < prior.revision) return
  const layout = m.op === 'upsert' ? canvasLayoutOf(m.node) : null
  const membershipChanged = prior && (prior.layout?.parentId !== layout?.parentId || prior.layout?.kind !== layout?.kind)
  const changed = !prior || stableStringify(prior.layout) !== stableStringify(layout)
  // A first ordinary host snapshot (open/launch claim/patch) is not a structural barrier.
  // Legacy individual drags have no `seen` and must retain ordinary last-writer-wins behavior.
  // Changed batch tuples, tombstones and known membership changes establish an actual fence.
  const revision = ((source === 'batch' && changed) || m.op === 'remove' || membershipChanged) ? m.seq ?? 0 : prior?.revision ?? 0
  if (!prior) order.count++
  project.set(id, { revision, layout, hostFacts: source === 'client' ? prior?.hostFacts : {
    value: layout?.dynamicGroup
  } })
}

function preserveStructure(p: CorePlatform, projectId: string, mutation: CanvasMutation): {
  mutation: CanvasMutation; corrected: boolean; rejection?: ClientMutationRejection
} {
  if (mutation.op !== 'upsert' && mutation.op !== 'remove') return { mutation, corrected: false }
  const project = structureOrders.get(p)?.projects.get(projectId)
  const resolve = structureResolvers.get(p)
  let scene: readonly CanvasNodeState[] | undefined
  try { scene = resolve?.(projectId) } catch { /* unavailable is not absence */ }
  if (scene && (scene.length > 4096 || new Set(scene.map((n) => n.id)).size !== scene.length)) scene = undefined
  if (mutation.op === 'remove') {
    const saved = scene?.find((n) => n.id === mutation.id)
    const held = project?.get(mutation.id)
    const layout = held ? held.layout : saved ? canvasLayoutOf(saved) : undefined
    const canonical: CanvasMutation | undefined = held?.layout === null ? { op: 'remove', id: mutation.id } :
      saved ? { op: 'upsert', node: layout ? applyCanvasLayout(saved, layout) : saved } : undefined
    const ids = new Set([...(scene?.map((n) => n.id) ?? []), ...(project?.keys() ?? [])])
    const children = layout?.kind === 'group' && [...ids].some((id) => {
      const known = project?.get(id)
      return (known ? known.layout?.parentId : scene?.find((n) => n.id === id)?.parentId) === mutation.id
    })
    const slots = layout?.dynamicGroup === undefined ? undefined : normalizeDynamicGroupState(layout.dynamicGroup)
    const activeSlots = layout?.dynamicGroup !== undefined && (!slots || slots.reservations.some((slot) => slot.state === 'reserved'))
    if (!structureCapacity(p, projectId, [mutation]) || (resolve && !scene) || children || activeSlots) {
      return { mutation, corrected: false, rejection: {
        reason: 'The frame still has members or its current structure is unavailable. Move members before removing it.', canonical,
        ...(!canonical && resolve && !scene ? { acknowledgement: null } : {})
      } }
    }
    return { mutation, corrected: false }
  }
  const fence = project?.get(mutation.node.id)
  const canonical = scene?.find((n) => n.id === mutation.node.id)
  const current = fence ? fence.layout : canonical ? canvasLayoutOf(canonical) : undefined
  const correction = (): CanvasMutation | undefined => current === null ? { op: 'remove', id: mutation.node.id } :
    canonical ? { op: 'upsert', node: current ? applyCanvasLayout(canonical, current) : canonical } : undefined
  const refused = (reason: string) => ({ mutation, corrected: false, rejection: { reason, canonical: correction(),
    acknowledgement: current === null ? { op: 'remove' as const, id: mutation.node.id } :
      current ? { op: 'upsert' as const, node: applyCanvasLayout(mutation.node, current) } : null } })
  if (!structureCapacity(p, projectId, [mutation])) return refused('Canvas structural history is full; reload from a fresh host before retrying.')
  // Historical/unstamped snapshots cannot change a host-published coordinate frame.
  const stale = fence && fence.revision > 0 &&
    (typeof mutation.seen !== 'number' || !Number.isFinite(mutation.seen) || mutation.seen < fence.revision)
  if (stale && current === null) return refused('This node was removed after this edit began. Reload the project.')
  const node = stale && current ? applyCanvasLayout(mutation.node, current) : mutation.node
  const corrected = stableStringify(canvasLayoutOf(node)) !== stableStringify(canvasLayoutOf(mutation.node))
  // With no host structural facts or resolver, retain legacy standalone mutation behavior.
  if (!project?.size && !resolve) return { mutation: { ...mutation, node }, corrected }
  if (resolve && !scene) return refused('The host could not read the current canvas structure. Reload the project.')
  const lookup = (id: string): CanvasLayoutTuple | undefined => {
    if (id === node.id) return canvasLayoutOf(node)
    const published = project?.get(id)
    if (published) return published.layout ?? undefined
    const saved = scene?.find((n) => n.id === id)
    return saved ? canvasLayoutOf(saved) : undefined
  }
  const seen = new Set([node.id])
  let parent = node.parentId
  while (parent) {
    const frame = lookup(parent)
    if (!frame && !resolve && !project?.has(parent)) break // unknown legacy scene, not proof of absence
    if (!frame || frame.kind !== 'group' || seen.has(parent) || seen.size > 4096) {
      return refused('The edit names a missing, invalid or cyclic group. Reload the project before reparenting.')
    }
    seen.add(parent); parent = frame.parentId
  }
  if (node.kind !== 'group') {
    const ids = new Set([...(scene?.map((n) => n.id) ?? []), ...(project?.keys() ?? [])])
    if ([...ids].some((id) => id !== node.id && lookup(id)?.parentId === node.id)) {
      return refused('A frame with children cannot become another node kind.')
    }
  }
  // Validate only reservation footprints here. A normal multi-node UI gesture may publish
  // successive positions/growth separately; do not repack unrelated siblings on a single cast.
  const geometry = (n: CanvasLayoutTuple) => [n.kind, n.parentId, n.position, n.size, n.collapsed, n.premaxRect]
  if (!current || stableStringify(geometry(node)) !== stableStringify(geometry(current))) {
    const active = (frame: CanvasLayoutTuple) => {
      if (frame.dynamicGroup === undefined) return []
      const facts = normalizeDynamicGroupState(frame.dynamicGroup)
      if (!facts) throw new Error('canvas-reservation-facts-unavailable')
      return facts.reservations.filter((slot) => slot.state === 'reserved')
    }
    const ownSlots = node.kind === 'group' && current ? active(current) : []
    const validSize = () => Number.isFinite(node.size?.width) && Number.isFinite(node.size?.height) && node.size.width > 0 && node.size.height > 0
    if (ownSlots.length && (!validSize() || ownSlots.some((slot) =>
      slot.position.x < GROUP_PAD || slot.position.y < GROUP_PAD + GROUP_HEADER ||
      slot.position.x + slot.width + GROUP_PAD > node.size.width ||
      slot.position.y + slot.height + GROUP_PAD > node.size.height))) {
      return refused('This gesture would cut into reserved space. Use a group layout batch.')
    }
    let x = node.position.x, y = node.position.y, ancestor = node.parentId
    const ancestors = new Set<string>()
    while (ancestor && !ancestors.has(ancestor)) {
      ancestors.add(ancestor)
      const frame = lookup(ancestor)
      if (!frame) break
      const slots = active(frame)
      if (slots.length && (!validSize() || slots.some((slot) =>
        x < slot.position.x + slot.width && x + node.size.width > slot.position.x &&
        y < slot.position.y + slot.height && y + (node.collapsed ? COLLAPSED_HEIGHT : node.size.height) > slot.position.y))) {
        return refused('This gesture would occupy reserved space. Use a group layout batch.')
      }
      x += frame.position.x; y += frame.position.y; ancestor = frame.parentId
    }
  }
  return { mutation: { ...mutation, node }, corrected }
}

/** Observer callbacks are read-only: recursive Core publication cannot overtake the current
 * sequence on the wire or in the authority. A refused publisher has produced no effect. */
function publishInOrder(p: CorePlatform, publish: () => void): boolean {
  if (publishingOn.has(p)) return false
  publishingOn.add(p)
  try { publish(); return true }
  finally { publishingOn.delete(p) }
}
type DynamicGroupMetadataResolver = (projectId: string, nodeId: string) => CanvasNodeState['dynamicGroup']
const dynamicGroupMetadataResolvers = new WeakMap<CorePlatform, DynamicGroupMetadataResolver>()

/** Synchronous host facts, scoped to this platform. Absence means no facts, never client authority.
 * Install wherever saved dynamic groups can be edited, including after restore. */
export function setDynamicGroupMetadataResolver(resolve: DynamicGroupMetadataResolver | null): void {
  if (resolve) dynamicGroupMetadataResolvers.set(platform(), resolve)
  else dynamicGroupMetadataResolvers.delete(platform())
}

function preserveGroupMetadata(p: CorePlatform, projectId: string, mutation: CanvasMutation): {
  mutation: CanvasMutation; corrected: boolean
} {
  if (mutation.op !== 'upsert') return { mutation, corrected: false }
  const published = structureOrders.get(p)?.projects.get(projectId)?.get(mutation.node.id)?.hostFacts
  const facts = published !== undefined ? published.value : dynamicGroupMetadataResolvers.get(p)?.(projectId, mutation.node.id)
  const state = facts === undefined ? undefined : normalizeDynamicGroupState(facts)
  if ((facts !== undefined && !state) || (state && mutation.node.kind !== 'group')) {
    throw new Error('canvas-group-metadata-unavailable')
  }
  const corrected = stableStringify(mutation.node.dynamicGroup) !== stableStringify(state)
  if (!corrected) return { mutation, corrected: false }
  const node = { ...mutation.node }
  if (state) node.dynamicGroup = state
  else delete node.dynamicGroup
  return { mutation: { ...mutation, node }, corrected: true }
}

export function setCanvasMutationBatchObserver(observer: BatchObserver | null): void {
  if (observer) batchObservers.set(platform(), observer)
  else batchObservers.delete(platform())
}

export { isCanvasMutationBatch, CANVAS_BATCH_MAX_MUTATIONS, CANVAS_BATCH_MAX_BYTES } from '../shared/canvas-batch'

export type CanvasBatchPreflight = { ok: true } | { ok: false; error: string }

function prepareBatch(batch: CanvasMutationBatch, trusted: boolean): {
  stamped: CanvasMutationBatch; stripped: CanvasMutationBatch; vouched: CanvasMutationBatch
} | null {
  try {
    if (!isCanvasMutationBatch(batch)) return null
    const mutations = batch.mutations.map((m) => sanitizeCanvasMutation(m, trusted))
    if (mutations.some((m) => !m)) return null
    const clean = structuredClone(mutations as CanvasMutation[])
    const stamped = { mutations: clean.map((m, i) => stampMutation(m, seq + i + 1)) }
    const stripped = { mutations: stamped.mutations.map((m) => sanitizeInboundMutation(m)) }
    const vouched = { mutations: stamped.mutations.map((m) => ({ ...m, origin: 'core' as const })) }
    // Stamps and per-owner provenance are part of the wire budget too.
    return [stamped, stripped, vouched].every(isCanvasMutationBatch) ? { stamped, stripped, vouched } : null
  } catch { return null }
}

/** Current broadcast recipients, never a remembered list of departed clients. */
export function canPublishCanvasBatch(projectId: string, batch: CanvasMutationBatch,
  opts: { trusted?: boolean } = {}): CanvasBatchPreflight {
  if (!isRefId(projectId) || !prepareBatch(batch, opts.trusted !== false)) return { ok: false, error: 'canvas-batch-invalid' }
  const p = platform()
  if (publishingOn.has(p)) return { ok: false, error: 'canvas-batch-reentrant-publication' }
  if (!structureCapacity(p, projectId, batch.mutations)) return { ok: false, error: 'canvas-structure-capacity' }
  const live = new Set(p.clientIds())
  const supported = batchSubscribers.get(p)
  if (supported) for (const id of supported) if (!live.has(id)) supported.delete(id)
  if ([...live].some((id) => !supported?.has(id))) return { ok: false, error: 'canvas-batch-client-incompatible' }
  if (reflectedListener && !reflectedBatchListener) return { ok: false, error: 'canvas-batch-authority-incompatible' }
  return { ok: true }
}

/** Host-local observation in the same total order, including Core publications. This grants no
 * authority to publish or persist. Called before wire fan-out with owner-local launch provenance. */
export function setCanvasMutationObserver(observer: MutationObserver | null): void {
  if (observer) mutationObservers.set(platform(), observer)
  else mutationObservers.delete(platform())
}

/** Host-owned domain admission before a client op enters the total order. Core publishers keep
 * their own transaction checks. A refused optimistic edit receives a separate canonical op,
 * without its source tag, plus an addressed notice; it must not disappear without an answer.
 */
export function setClientMutationAdmission(admit: ClientMutationAdmission | null): void {
  if (admit) clientAdmissions.set(platform(), admit)
  else clientAdmissions.delete(platform())
}

function clientMutationRefused(p: CorePlatform, senderId: number, projectId: string, mutation: CanvasMutation, fromOwner: boolean): boolean {
  const admit = clientAdmissions.get(p)
  if (!admit) return false
  let rejection: ClientMutationRejection | null
  try { rejection = admit(projectId, mutation, fromOwner) }
  catch { rejection = { reason: 'The host could not validate this edit. Reload the project before retrying.' } }
  if (!rejection) return false
  reflectClientRefusal(p, senderId, projectId, mutation, fromOwner, rejection)
  return true
}

function reflectClientRefusal(p: CorePlatform, senderId: number, projectId: string, mutation: CanvasMutation,
  fromOwner: boolean, rejection: ClientMutationRejection): void {
  // Retire this sender's optimistic pending slot first. The refused value reaches neither the
  // authority nor another client. FIFO then lets the separate correction supersede that value.
  const target = mutation.op === 'upsert' ? mutation.node.id : mutation.op === 'remove' ? mutation.id : undefined
  const correction = isCanvasMutation(rejection.canonical) ? sanitizeCanvasMutation(rejection.canonical, true) : null
  const correctedTarget = correction?.op === 'upsert' ? correction.node.id : correction?.op === 'remove' ? correction.id : undefined
  const matching = correction && target && correctedTarget === target && isCanvasMutation(correction) ? correction : null
  const candidate = matching ?? (rejection.acknowledgement === undefined ? mutation : rejection.acknowledgement)
  if (candidate) {
    const candidateTarget = candidate.op === 'upsert' ? candidate.node.id : candidate.op === 'remove' ? candidate.id : undefined
    if (candidateTarget === target && isCanvasMutation(candidate)) {
      const echo = { ...candidate, src: mutation.src, seen: mutation.seen }
      fanOutMutation({ clientIds: () => [senderId], sendTo: p.sendTo.bind(p), isOwnerClient: p.isOwnerClient?.bind(p) },
        projectId, stampMutation(echo, ++seq), fromOwner)
    }
  }
  if (correction && target && correctedTarget === target && isCanvasMutation(correction)) {
    delete correction.src
    correction.seen = seq
    const stamped = stampMutation(correction, ++seq)
    tellListener(projectId, stamped, true)
    if (structureCapacity(p, projectId, [stamped])) noteStructure(p, projectId, stamped, 'client')
    fanOutMutation(p, projectId, stamped, true)
  }
  p.sendTo(senderId, IPC.canvasMutationRejected, projectId, oneLine(rejection.reason || 'The host refused this edit. Reload the project.').slice(0, 512))
}

// The ingest guard (`isCanvasMutation`) and its size cap live in `shared`, because the PUBLISHER
// must reach the same verdict BEFORE it casts: a mutation this reflector refuses is dropped
// silently, and a publisher that only learned about it by never hearing an ack would advance its
// baseline (never retrying the edit) and deafen that node to its peers for a whole pending TTL.
// Re-exported here because this is where the refusal is enforced, and where the tests look for it.
export { isCanvasMutation, MUTATION_MAX_BYTES }

/**
 * Every attached client the mutation goes to — INCLUDING the sender, whose copy is its ack (see the
 * header). Pure — exported for the test. `sender` is kept in the signature: it is the seam a policy
 * would need, and dropping it would make "the sender is included" look accidental rather than
 * chosen.
 */
export function reflectTargets(all: ClientId[], _sender: ClientId): ClientId[] {
  return all.slice()
}

/**
 * Stamp a client's mutation with its place in the total order, and BOUND the client-supplied stamp
 * fields it carries (`src`, `seen`; a client-supplied `origin` is dropped outright, below). Pure —
 * exported for the test.
 *
 * `src` is echoed to every peer, and a client could otherwise plant a megabyte there — or forge
 * another client's tag, which would only ever make that client ignore an edit meant for it, but is
 * still not something to reflect unchecked.
 *
 * `seen` is the sender's causal position (canvas-order rule 4): an upsert claiming to have seen a
 * node's delete is applied over it. It cannot legitimately reach the order this mutation is being
 * GIVEN (the sender can only have seen `seq`s already assigned), so it is clamped to `seq - 1`, and
 * a non-integer / negative value is dropped ("unstamped": judged exactly as before rule 4 existed).
 * That is HYGIENE, NOT PROTECTION: the clamp changes no verdict. Every remove ordered before this
 * mutation has a `seq` at most `seq - 1`, so a clamped forgery still counts as having seen it, and a
 * remove ordered after it supersedes it by `seq` alone. A forged `seen` resurrects a node a teammate
 * deleted either way; what bounds that is who may cast at all (`canvas:mut` is Editor-only on a
 * hosted team, src/core/relay/access-policy.ts).
 */
export function stampMutation<M extends CanvasMutation>(m: M, seq: number): M & MutationStamp {
  const stamped: M & MutationStamp = { ...m, seq }
  if (!isRefId(stamped.src)) delete stamped.src
  const seen = stamped.seen
  if (typeof seen !== 'number' || !Number.isInteger(seen) || seen < 0) delete stamped.seen
  else if (seen >= seq) stamped.seen = seq - 1
  // `origin: 'core'` is the core's own vouching (it lets a receiver take a held launch as sent), so a
  // client may never supply it. It is re-added below, per recipient, and only where it is true.
  delete (stamped as { origin?: unknown }).origin
  return stamped
}

/**
 * Deliver one stamped mutation to every client, deciding PER RECIPIENT whether the node's held launch
 * (`pendingLaunch`, machine-local — @shared/node-exec) goes with it. Pure over the platform —
 * exported for the test.
 *
 * `trusted` = the mutation came from an OWNER client or from the core itself. An owner recipient
 * then gets it with the launch and `origin: 'core'` (so two Server Edition tabs agree on who claimed
 * a launch — the exactly-once half); every other recipient (a relay peer, a hosted-team guest) gets
 * it WITHOUT the launch. An untrusted mutation carries no launch to anybody: a peer cannot arm,
 * re-arm or clear a launch on this machine.
 */
export function fanOutMutation(
  p: Pick<CorePlatform, 'clientIds' | 'sendTo' | 'isOwnerClient'>,
  projectId: string,
  stamped: CanvasMutation,
  trusted: boolean
): void {
  const vouched: CanvasMutation | null = trusted ? { ...stamped, origin: 'core' } : null
  const stripped = sanitizeInboundMutation(stamped)
  for (const id of p.clientIds()) {
    const owner = p.isOwnerClient?.(id) === true
    p.sendTo(id, IPC.canvasMut, projectId, vouched && owner ? vouched : stripped)
  }
}

/** The platform this reflector is already installed on. `on`/`onWithSender` COMPOSE on the same
 *  channel (ServerPlatform keeps an ordered SET per channel), so a second registration on the same
 *  platform would reflect every mutation twice. Keyed by platform, not a bare boolean, so a fresh
 *  boot (or a fresh test platform) registers again. */
let registeredOn: CorePlatform | null = null

/**
 * The total order. One counter for the whole process (not per project): `seq` is only ever compared
 * between mutations addressing the SAME node, and node ids are globally unique (a node id is a tmux
 * session name), so a single counter orders every canvas correctly and cannot be confused by a
 * client that switches projects. Reset with the registration, so a fresh boot starts from 0 — which
 * is safe because a client's ordering state (canvas-order) is per Canvas mount and starts empty too.
 */
let seq = 0

/**
 * The one in-process listener of the total order: the Server Edition canvas authority
 * (core/canvas-authority.ts, docs/hosted-team-relay.md), which writes shared projects' content from
 * the ops it hears here. Module-level, like `seq`, and deliberately NOT cleared by `initCanvasSync`:
 * the shell that sets it owns it, and clears it on close.
 */
let reflectedListener: ((projectId: string, m: CanvasMutation) => void) | null = null
let reflectedBatchListener: ((projectId: string, batch: CanvasMutationBatch) => void) | null = null

export function setReflectedBatchListener(fn: typeof reflectedBatchListener): void {
  reflectedBatchListener = fn
}

/**
 * Set (or, with null, clear) the listener every reflected op reaches. It is called SYNCHRONOUSLY,
 * right after the stamp, in both ingest paths (a client cast and `publishCanvasMutation`), so call
 * order is seq order. The authority depends on that: its own published diff echoes back through
 * here while it is still publishing. A refused op never reaches it.
 */
export function setReflectedListener(fn: ((projectId: string, m: CanvasMutation) => void) | null): void {
  reflectedListener = fn
}

/** Hand one stamped op to the listener. A throw is logged, never let into the fan-out: every client
 *  must still get the op, whatever the authority made of it.
 *
 *  The listener gets the op WITHOUT its held launch (`pendingLaunch`), even when an owner sent it:
 *  the authority's state carries no exec field (core/canvas-authority.ts rule 1), and a launch
 *  reaches disk only through a save's own exec carry, into the machine-local index. Its reducer
 *  would drop an unvouched launch anyway; stripping it here keeps it out of the op log too. */
function tellListener(projectId: string, stamped: CanvasMutation, trusted = false): void {
  try { mutationObservers.get(platform())?.(projectId, stamped, trusted) }
  catch (err) { console.warn('[canvas-sync] the host mutation observer threw', err) }
  if (!reflectedListener) return
  try {
    reflectedListener(projectId, sanitizeInboundMutation(stamped))
  } catch (err) {
    console.warn('[canvas-sync] the reflected-op listener threw', err)
  }
}

/**
 * Publish a mutation originated by the core itself (for example a headless Server Edition
 * control request). It takes the same validation, execution-field sanitization and total-order
 * stamp as a browser cast, then fans out to every connected canvas. Disk persistence remains the
 * caller's responsibility; this function is only the live convergence leg.
 *
 * `trusted` (default true) = the op speaks for the held launch (`pendingLaunch`): owner clients get
 * it vouched (`origin: 'core'`), so its launch, or its ABSENCE, is authoritative there. Server canvas
 * control needs exactly that (a headless delivery CLEARS the launch on every owner tab). The canvas
 * authority passes `false`: its state holds no launch at all (core/canvas-authority.ts rule 1), so a
 * vouched copy of its outside-edit diff would clear every armed node it touched on every owner tab.
 * Untrusted, it carries no launch to anybody and each owner keeps its own, exactly as for a peer's
 * cast.
 */
export function publishCanvasMutation(
  projectId: string,
  mutation: CanvasMutation,
  opts: { trusted?: boolean } = {}
): boolean {
  if (!isRefId(projectId) || !isCanvasMutation(mutation)) return false
  const trusted = opts.trusted !== false
  const clean = sanitizeCanvasMutation(mutation, trusted)
  if (!clean) return false
  const p = platform()
  if (!structureCapacity(p, projectId, [clean])) return false
  return publishInOrder(p, () => {
    const stamped = stampMutation(clean, ++seq)
    tellListener(projectId, stamped, trusted)
    noteStructure(p, projectId, stamped, 'ordinary')
    fanOutMutation(p, projectId, stamped, trusted)
  })
}

/** Host-only: there is intentionally no client ingress handler for this channel. */
export function publishCanvasMutationBatch(projectId: string, batch: CanvasMutationBatch,
  opts: { trusted?: boolean } = {}): boolean {
  if (!canPublishCanvasBatch(projectId, batch, opts).ok) return false
  const trusted = opts.trusted !== false
  const prepared = prepareBatch(batch, trusted)
  if (!prepared) return false
  const p = platform()
  const recipients = p.clientIds()
  const { stamped, stripped, vouched } = prepared
  return publishInOrder(p, () => {
    seq += stamped.mutations.length
    // Authority must finish the entire reducer fold before ANY external observer sees this edit.
    reflectedBatchListener?.(projectId, stripped)
    for (const m of stamped.mutations) noteStructure(p, projectId, m, 'batch')
    for (const m of stamped.mutations) {
      try { mutationObservers.get(p)?.(projectId, m, trusted) }
      catch (err) { console.warn('[canvas-sync] the host mutation observer threw', err) }
    }
    try { batchObservers.get(p)?.(projectId, stamped, trusted) }
    catch (err) { console.warn('[canvas-sync] the host batch observer threw', err) }
    for (const id of recipients) {
      p.sendTo(id, IPC.canvasMutationBatch, projectId, trusted && p.isOwnerClient?.(id) === true ? vouched : stripped)
    }
  })
}

/** Install the `canvas:mut` reflector. Call once at boot, after initPlatform(). */
export function initCanvasSync(): void {
  const p = platform()
  if (registeredOn === p) return
  registeredOn = p
  seq = 0
  structureOrders.set(p, { projects: new Map(), count: 0 })
  const supported = new Set<number>()
  batchSubscribers.set(p, supported)
  p.onWithSender(IPC.canvasBatchSubscribe, (senderId: number, subscribed: unknown) => {
    if (!p.clientIds().includes(senderId)) return
    if (subscribed === true) supported.add(senderId)
    else supported.delete(senderId)
  })
  const receiveMutation = (senderId: number, projectId: unknown, mutation: unknown): void => {
    // Which canvas the edit belongs to is client-supplied too, and it is reflected verbatim.
    if (!isRefId(projectId)) return
    if (!isCanvasMutation(mutation)) return
    if (publishingOn.has(p)) {
      // A synchronous adapter/observer may reenter ingress. Treat it like the next transport
      // turn, with detached input and a fresh connected-sender check, rather than interleave ops.
      let detached: CanvasMutation
      try { detached = structuredClone(mutation) } catch { return }
      queueMicrotask(() => {
        if (registeredOn === p && p.clientIds().includes(senderId)) receiveMutation(senderId, projectId, detached)
      })
      return
    }
    publishInOrder(p, () => {
      // Stamped ONCE, here: the order every client will agree on. The sender is in the target list —
      // its copy is the ack that tells it where its own edit landed (see the header).
      // What is stamped is the CLEAN op (`sanitizeCanvasMutation`), so every client receives the same
      // bytes rather than each repairing the raw cast on its own:
      //  - the exec-enabling node fields (`shell`, `ssh.extraArgs`) are stripped HERE too, so they are
      //    not even reflected to the other clients: a peer must not be able to put a program name or
      //    an `-o ProxyCommand=…` into anybody's canvas (@shared/node-exec). Every receiver strips
      //    them again on apply — this is the cheap upstream half;
      //  - a held launch (`pendingLaunch`) is kept only when the SENDER is an owner client, and then
      //    forwarded only to owner clients (fanOutMutation);
      //  - a kanban op is rebuilt by `sanitizeKanbanOp` (unknown fields dropped, a label colour off the
      //    palette → `default`, an invalid rank / priority / dueAt / category dropped), keeping its
      //    `src` / `seen` so the order can still judge it. Kanban fields land in a git-shared
      //    project.json, and the authority sanitizes again before it writes (the two-seam rule);
      //  - a remove or an edge op is rebuilt from the fields its op defines (and its stamp), so no extra
      //    field a client attached is forwarded to every peer.
      const fromOwner = p.isOwnerClient?.(senderId) === true
      let clean = sanitizeCanvasMutation(mutation, fromOwner)
      if (!clean) return
      let corrected = false
      try {
        const structural = preserveStructure(p, projectId, clean)
        if (structural.rejection) {
          reflectClientRefusal(p, senderId, projectId, clean, fromOwner, structural.rejection)
          return
        }
        clean = structural.mutation
        const normalized = preserveGroupMetadata(p, projectId, clean)
        if (!isCanvasMutation(normalized.mutation)) throw new Error('canvas-group-metadata-oversized')
        clean = normalized.mutation
        corrected = structural.corrected || normalized.corrected
      } catch {
        reflectClientRefusal(p, senderId, projectId, clean, fromOwner, {
          reason: 'The host could not preserve group reservations. Reload the project before retrying.'
        })
        return
      }
      if (clientMutationRefused(p, senderId, projectId, clean, fromOwner)) return
      if (corrected && clean.src) {
        // Retire the sender's optimistic slot, then apply the canonical metadata even to that sender.
        // A same-src echo alone would be ignored as an ACK, leaving stale reservations on its UI.
        fanOutMutation({ clientIds: () => [senderId], sendTo: p.sendTo.bind(p), isOwnerClient: p.isOwnerClient?.bind(p) },
          projectId, stampMutation(clean, ++seq), fromOwner)
        // Keep the client's original causal position: correcting metadata is not permission to
        // recreate a frame deleted since this drag began.
        clean = { ...clean }
        delete clean.src
      }
      const stamped = stampMutation(clean, ++seq)
      noteStructure(p, projectId, stamped, 'client')
      tellListener(projectId, stamped, fromOwner)
      fanOutMutation(
        { clientIds: () => reflectTargets(p.clientIds(), senderId), sendTo: p.sendTo.bind(p), isOwnerClient: p.isOwnerClient?.bind(p) },
        projectId,
        stamped,
        fromOwner
      )
    })
  }
  p.onWithSender(IPC.canvasMut, receiveMutation)
}
