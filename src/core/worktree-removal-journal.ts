import { randomUUID } from 'node:crypto'
import type { GroupWorktree } from '../shared/worktree'
import type { WorktreeGitEvidence } from './worktree-git-evidence'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isSafeNodeId } from '../shared/safe-id'
import { isAncestorPath, isValidGitRef } from '../shared/worktree'
import { readRegularFileNoFollow } from './read-regular-file'
import { writeFileDurableAtomic } from './fs-atomic'

const MAX_RECORDS = 128
const MAX_BYTES = 4 * 1024 * 1024
type Phase = 'prepared' | 'removed' | 'recovered'
export interface WorktreeRemovalIntent {
  projectId: string
  groupId: string
  repoPath: string
  worktreePath: string
  branch: string
  fallbackCwd: string
  /** Canonical directory identity from the host's actual stat, before Git dispatch. */
  directoryStamp: string
  /** Hashes of saved execution identities; no command text or credentials in the journal. */
  members: Array<{ nodeId: string; binding: string }>
}
export interface WorktreeRepairPlan {
  /** Expected post-repair execution bindings, including account/session/model/held intent. */
  members: Array<{ nodeId: string; binding: string }>
  /** Exact content-written/index-not-yet-written bindings for the existing split store. */
  staged?: Array<{ nodeId: string; binding: string }>
  /** Retain host dispatch quarantine even after metadata repair; never a launch grant. */
  manualStart: string[]
}
export interface WorktreeRebindPlan {
  state: 'prepared' | 'bound'
  directoryStamp: string
  repoStamp: string
  git: WorktreeGitEvidence
  targetGit: WorktreeGitEvidence
  binding: GroupWorktree
  members: WorktreeRepairPlan['members']
  staged: WorktreeRepairPlan['members']
}
export type WorktreeProvenance = { kind: 'recorded-directory' } | {
  kind: 'observed-missing'; observedAt: number; ancestor: string; ancestorStamp: string; repoStamp: string; git: WorktreeGitEvidence
}
export interface WorktreeRemovalRecord extends Omit<WorktreeRemovalIntent, 'directoryStamp'> {
  directoryStamp?: string
  provenance: WorktreeProvenance
  id: string; createdAt: number; phase: Phase
  repair?: WorktreeRepairPlan
  rebind?: WorktreeRebindPlan
}
interface Options {
  /** The existing hook/data-directory ownership verdict; a second app instance cannot write. */
  ownsFiles(): boolean
  persist?(file: string, data: string): Promise<void>
}

function record(raw: unknown): WorktreeRemovalRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('worktree-journal-invalid-record')
  const row = raw as WorktreeRemovalRecord
  const fields = new Set(['id', 'createdAt', 'phase', 'projectId', 'groupId', 'repoPath', 'worktreePath', 'branch', 'fallbackCwd', 'directoryStamp', 'members', 'repair', 'provenance', 'rebind'])
  const absolute = (value: unknown) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') &&
    path.isAbsolute(value) && path.resolve(value) === value && path.parse(value).root !== value
  if (Object.keys(row).some((key) => !fields.has(key)) ||
    ![row.id, row.projectId, row.groupId].every((id) => typeof id === 'string' && isSafeNodeId(id)) ||
    ![row.repoPath, row.worktreePath, row.fallbackCwd].every(absolute) || row.repoPath === row.worktreePath ||
    isAncestorPath(row.worktreePath, row.fallbackCwd) || typeof row.branch !== 'string' || !isValidGitRef(row.branch) ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 || !['prepared', 'removed', 'recovered'].includes(row.phase) ||
    !Array.isArray(row.members) || !row.members.length || row.members.length > 32 ||
    row.members.some((member) => !member || typeof member.nodeId !== 'string' || !isSafeNodeId(member.nodeId) ||
      typeof member.binding !== 'string' || !/^[0-9a-f]{64}$/.test(member.binding) || Object.keys(member).some((key) => key !== 'nodeId' && key !== 'binding')) ||
    new Set(row.members.map((member) => member.nodeId)).size !== row.members.length ||
    !row.members.some((member) => member.nodeId === row.groupId)) throw new Error('worktree-journal-invalid-record')
  const stamp = (value: unknown) => typeof value === 'string' && /^\d+:[1-9]\d*$/.test(value)
  const origin = row.provenance
  if (!origin || (origin.kind !== 'recorded-directory' && origin.kind !== 'observed-missing'))
    throw new Error('worktree-journal-invalid-provenance')
  if (origin.kind === 'recorded-directory') {
    if (Object.keys(origin).length !== 1 || !stamp(row.directoryStamp)) throw new Error('worktree-journal-invalid-provenance')
  } else if (Object.keys(origin).some((key) => !['kind', 'observedAt', 'ancestor', 'ancestorStamp', 'repoStamp', 'git'].includes(key)) ||
    row.directoryStamp !== undefined || row.phase === 'prepared' || !Number.isSafeInteger(origin.observedAt) || origin.observedAt <= 0 ||
    typeof origin.ancestor !== 'string' || !path.isAbsolute(origin.ancestor) || path.resolve(origin.ancestor) !== origin.ancestor ||
    !isAncestorPath(origin.ancestor, row.worktreePath) || origin.ancestor === row.worktreePath ||
    !stamp(origin.ancestorStamp) || !stamp(origin.repoStamp) || !origin.git ||
    Object.keys(origin.git).some((key) => !['gitDirectory', 'commonDirectory', 'fingerprint'].includes(key)) ||
    !absolute(origin.git.gitDirectory) || !absolute(origin.git.commonDirectory) ||
    typeof origin.git.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(origin.git.fingerprint)) throw new Error('worktree-journal-invalid-provenance')
  if (row.repair !== undefined) {
    const repair = row.repair
    const validMembers = (members: WorktreeRepairPlan['members']) => Array.isArray(members) && members.length === row.members.length &&
      members.every((member) => member && row.members.some((old) => old.nodeId === member.nodeId) &&
        typeof member.binding === 'string' && /^[0-9a-f]{64}$/.test(member.binding) &&
        Object.keys(member).every((key) => key === 'nodeId' || key === 'binding')) &&
      new Set(members.map((member) => member.nodeId)).size === members.length
    if (!repair || row.phase === 'prepared' || Object.keys(repair).some((key) => !['members', 'staged', 'manualStart'].includes(key)) ||
      !validMembers(repair.members) || (repair.staged !== undefined && !validMembers(repair.staged)) ||
      !Array.isArray(repair.manualStart) || new Set(repair.manualStart).size !== repair.manualStart.length ||
      repair.manualStart.some((id) => !row.members.some((member) => member.nodeId === id)))
      throw new Error('worktree-journal-invalid-repair')
  }
  if (row.rebind !== undefined) {
    const plan = row.rebind; const binding = plan?.binding
    const validMembers = (members: WorktreeRepairPlan['members']) => Array.isArray(members) && members.length === row.members.length &&
      new Set(members.map((member) => member?.nodeId)).size === members.length && members.every((member) => member &&
        row.members.some((original) => original.nodeId === member.nodeId) && typeof member.binding === 'string' &&
        /^[0-9a-f]{64}$/.test(member.binding) && Object.keys(member).every((key) => ['nodeId', 'binding'].includes(key)))
    if (!plan || row.phase !== 'recovered' || !row.repair ||
      Object.keys(plan).some((key) => !['state', 'directoryStamp', 'repoStamp', 'git', 'targetGit', 'binding', 'members', 'staged'].includes(key)) ||
      !['prepared', 'bound'].includes(plan.state) || !stamp(plan.directoryStamp) || !stamp(plan.repoStamp) || !plan.git ||
      Object.keys(plan.git).some((key) => !['gitDirectory', 'commonDirectory', 'fingerprint'].includes(key)) ||
      !absolute(plan.git.gitDirectory) || !absolute(plan.git.commonDirectory) || !/^[0-9a-f]{64}$/.test(plan.git.fingerprint) ||
      !plan.targetGit || Object.keys(plan.targetGit).some((key) => !['gitDirectory', 'commonDirectory', 'fingerprint'].includes(key)) ||
      !absolute(plan.targetGit.gitDirectory) || plan.targetGit.commonDirectory !== plan.git.commonDirectory || !/^[0-9a-f]{64}$/.test(plan.targetGit.fingerprint) ||
      !binding || Object.keys(binding).some((key) => !['repoPath', 'path', 'branch', 'baseRef', 'createdByApp'].includes(key)) ||
      binding.path !== row.worktreePath || binding.repoPath !== row.repoPath || binding.branch !== row.branch ||
      typeof binding.baseRef !== 'string' || !isValidGitRef(binding.baseRef) || binding.createdByApp !== false ||
      !validMembers(plan.members) || !validMembers(plan.staged)) throw new Error('worktree-journal-invalid-rebind')
  }
  return structuredClone(row)
}
const overlaps = (a: string, b: string) => isAncestorPath(a, b) || isAncestorPath(b, a)

/** Write-ahead recovery facts, never deletion authority. Prepared records are not safe to retry:
 * a crashed process may already have dispatched Git. Recovered rows retain a path tombstone until
 * a domain adapter explicitly rebinds a newly verified checkout. No RPC is exposed here.
 * Unlike short-lived orchestration facts, corruption and unknown versions stop writes; no row is
 * discarded or silently migrated. One owning core serializes mutations and waits for durable IO.
 */
export class WorktreeRemovalJournal {
  private rows: WorktreeRemovalRecord[] = []
  private loaded = false
  private faulted = false
  private persisted: string | null = null
  private quarantined = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  constructor(readonly file: string, private readonly options: Options) {
    if (!path.isAbsolute(file)) throw new Error('worktree-journal-absolute-file-required')
  }

  private owner(): void {
    if (!this.options.ownsFiles()) { this.faulted = true; throw new Error('worktree-journal-owner-required') }
  }
  private ready(): void {
    this.owner()
    if (!this.loaded || this.faulted) throw new Error('worktree-journal-unavailable: reload and inspect recovery state')
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const running = this.chain.then(work); this.chain = running.catch(() => {})
    return running
  }
  private async read(): Promise<string | null> {
    const raw = await readRegularFileNoFollow(this.file, MAX_BYTES)
    if (raw !== null) return raw
    try { await fs.lstat(this.file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    throw new Error('worktree-journal-unreadable')
  }
  load(): Promise<WorktreeRemovalRecord[]> {
    return this.serial(async () => {
      this.owner()
      try {
        const raw = await this.read()
        let next: WorktreeRemovalRecord[]
        if (raw === null) {
          next = []
        } else {
          const parsed = JSON.parse(raw)
          if (!parsed || parsed.kind !== 'worktree-removals' || ![1, 2, 3, 4].includes(parsed.version) ||
            !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error('worktree-journal-invalid-envelope')
          if (parsed.version >= 3 && Object.keys(parsed).some((key) => !['kind', 'version', 'records'].includes(key)))
            throw new Error('worktree-journal-invalid-envelope')
          if (parsed.version < 4 && parsed.records.some((row: WorktreeRemovalRecord) => row?.rebind !== undefined))
            throw new Error('worktree-journal-invalid-envelope')
          if (parsed.version === 1 && parsed.records.some((row: WorktreeRemovalRecord) => row?.repair !== undefined))
            throw new Error('worktree-journal-invalid-envelope')
          if (parsed.version < 3 && parsed.records.some((row: WorktreeRemovalRecord) => row?.provenance !== undefined))
            throw new Error('worktree-journal-invalid-envelope')
          next = parsed.records.map((row: WorktreeRemovalRecord) => record(parsed.version < 3
            ? { ...row, provenance: { kind: 'recorded-directory' } } : row))
          if (new Set(next.map((row) => row.id)).size !== next.length || next.some((row, index) =>
            next.slice(0, index).some((previous) => overlaps(row.worktreePath, previous.worktreePath))))
            throw new Error('worktree-journal-conflicting-records')
        }
        this.owner(); this.publishRows(next); this.persisted = raw; this.loaded = true; this.faulted = false
        return this.list()
      } catch (error) { this.faulted = true; throw error }
    })
  }
  list(): WorktreeRemovalRecord[] { this.ready(); return structuredClone(this.rows) }
  /** Committed local facts only. Preserve known quarantines after uncertain IO/ownership loss;
   * an unreadable journal with no known rows does not invent restrictions on existing panes. */
  isNodePending(nodeId: string): boolean { return this.quarantined.has(nodeId) }
  private publishRows(next: WorktreeRemovalRecord[]): void {
    this.rows = next
    this.quarantined = new Set(next.flatMap((row) => row.phase !== 'recovered' ? row.members.map((member) => member.nodeId) : row.repair?.manualStart ?? []))
  }
  /** A cheap host policy hint, including unavailable facts. It grants no read/write authority. */
  needsAdmission(): boolean {
    try { return !this.loaded || this.faulted || this.rows.length > 0 || !this.options.ownsFiles() }
    catch { return true }
  }
  reservedPaths(): string[] { this.ready(); return this.rows.filter((row) => row.rebind?.state !== 'bound').map((row) => row.worktreePath) }
  blocks(canonicalDirectory: string): boolean {
    this.ready()
    if (!path.isAbsolute(canonicalDirectory) || path.resolve(canonicalDirectory) !== canonicalDirectory)
      throw new Error('worktree-journal-canonical-path-required')
    return this.rows.some((row) => row.rebind?.state !== 'bound' && isAncestorPath(row.worktreePath, canonicalDirectory))
  }
  private async commit(next: WorktreeRemovalRecord[], assertCurrent?: () => void): Promise<void> {
    this.ready()
    const data = JSON.stringify({ kind: 'worktree-removals', version: 4, records: next })
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('worktree-journal-capacity')
    try {
      if (await this.read() !== this.persisted) throw new Error('worktree-journal-changed: reload before writing')
      this.ready()
      assertCurrent?.()
      await (this.options.persist ?? ((file, text) => writeFileDurableAtomic(file, text, { mode: 0o600, assertDispatch: assertCurrent })))(this.file, data)
      this.owner(); assertCurrent?.(); this.publishRows(next); this.persisted = data
    } catch (error) {
      // A first record may have reached disk even though publication was not acknowledged.
      // Retain its known members in memory too; a later verified load reconciles the facts.
      for (const row of next) for (const id of row.phase !== 'recovered' ? row.members.map((member) => member.nodeId) : row.repair?.manualStart ?? [])
        this.quarantined.add(id)
      this.faulted = true; throw error
    }
  }
  prepare(intent: WorktreeRemovalIntent): Promise<WorktreeRemovalRecord> {
    const captured = structuredClone(intent)
    return this.serial(async () => {
      this.ready()
      const next = record({ ...captured, id: randomUUID(), createdAt: Date.now(), phase: 'prepared', provenance: { kind: 'recorded-directory' } })
      if (this.rows.length >= MAX_RECORDS) throw new Error('worktree-journal-capacity')
      if (this.rows.some((row) => overlaps(row.worktreePath, next.worktreePath))) throw new Error('worktree-journal-path-reserved')
      await this.commit([...this.rows, next])
      return structuredClone(next)
    })
  }
  /** A host-observed missing checkout, never a prior inode or a claim that Git was dispatched. */
  observeMissing(proposed: WorktreeRemovalRecord, assertCurrent: () => void): Promise<WorktreeRemovalRecord> {
    const captured = record(proposed)
    if (captured.provenance.kind !== 'observed-missing' || captured.phase !== 'removed' || captured.repair)
      return Promise.reject(new Error('worktree-journal-invalid-provenance'))
    return this.serial(async () => {
      this.ready(); assertCurrent()
      if (this.rows.length >= MAX_RECORDS) throw new Error('worktree-journal-capacity')
      if (this.rows.some((row) => row.id === captured.id || overlaps(row.worktreePath, captured.worktreePath)))
        throw new Error('worktree-journal-path-reserved')
      await this.commit([...this.rows, captured], assertCurrent)
      return structuredClone(captured)
    })
  }
  /** Persist the bounded old/new binding plan before any terminal or metadata repair effect.
   * This is host-private recovery evidence, not authorization to launch or send input. */
  planRepair(id: string, plan: WorktreeRepairPlan, assertCurrent: () => void): Promise<WorktreeRemovalRecord> {
    const captured = structuredClone(plan)
    return this.serial(async () => {
      this.ready(); assertCurrent()
      const index = this.rows.findIndex((row) => row.id === id)
      if (index < 0 || this.rows[index].phase !== 'removed') throw new Error('worktree-journal-recovery-required')
      if (this.rows[index].repair) {
        if (JSON.stringify(this.rows[index].repair) !== JSON.stringify(captured)) throw new Error('worktree-journal-repair-changed')
        return structuredClone(this.rows[index])
      }
      const next = structuredClone(this.rows)
      next[index] = record({ ...next[index], repair: captured })
      await this.commit(next, assertCurrent)
      return structuredClone(next[index])
    })
  }
  markRemoved(id: string): Promise<WorktreeRemovalRecord> { return this.advance(id, 'prepared', 'removed') }
  markRecovered(id: string): Promise<WorktreeRemovalRecord> { return this.advance(id, 'removed', 'recovered') }
  private advance(id: string, from: Phase, to: Phase): Promise<WorktreeRemovalRecord> {
    return this.serial(async () => {
      this.ready()
      const index = this.rows.findIndex((row) => row.id === id)
      if (index < 0 || (this.rows[index].phase !== from && this.rows[index].phase !== to)) throw new Error('worktree-journal-invalid-transition')
      if (this.rows[index].phase === to) return structuredClone(this.rows[index])
      const next = structuredClone(this.rows); next[index].phase = to
      await this.commit(next); return structuredClone(next[index])
    })
  }
  prepareRebind(id: string, plan: WorktreeRebindPlan, assertCurrent: () => void): Promise<WorktreeRemovalRecord> {
    const captured = structuredClone(plan)
    return this.serial(async () => {
      this.ready(); assertCurrent()
      const index = this.rows.findIndex((row) => row.id === id)
      if (index < 0 || this.rows[index].phase !== 'recovered' || captured.state !== 'prepared') throw new Error('worktree-journal-recovery-required')
      if (this.rows[index].rebind) {
        if (JSON.stringify(this.rows[index].rebind) !== JSON.stringify(captured)) throw new Error('worktree-journal-rebind-changed')
        return structuredClone(this.rows[index])
      }
      const next = structuredClone(this.rows); next[index] = record({ ...next[index], rebind: captured })
      await this.commit(next, assertCurrent); return structuredClone(next[index])
    })
  }
  /** Release only verified path restriction. Keep original evidence and per-node manual quarantine. */
  markRebound(id: string, assertCurrent: () => void): Promise<WorktreeRemovalRecord> {
    return this.serial(async () => {
      this.ready(); assertCurrent()
      const index = this.rows.findIndex((row) => row.id === id)
      if (index < 0 || this.rows[index].phase !== 'recovered' || this.rows[index].rebind?.state !== 'prepared')
        throw new Error('worktree-journal-recovery-required')
      const next = structuredClone(this.rows); next[index].rebind!.state = 'bound'
      await this.commit(next, assertCurrent); return structuredClone(next[index])
    })
  }
  /** Caller already proved a new binding; never use this to dismiss an uncertain deletion. */
  releaseRebound(id: string): Promise<void> {
    return this.serial(async () => {
      this.ready()
      const row = this.rows.find((candidate) => candidate.id === id)
      if (!row || row.phase !== 'recovered' || row.repair?.manualStart.length) throw new Error('worktree-journal-recovery-required')
      await this.commit(this.rows.filter((candidate) => candidate.id !== id))
    })
  }
  /** Domain already proved the original directory identity and Git binding still exist, with
   * fresh owner approval to keep them. Prepared alone is NOT that proof: a crash may follow Git. */
  releaseKept(id: string, proof: { verify(): Promise<void>; assertCurrent(): void }): Promise<void> {
    return this.serial(async () => {
      this.ready()
      const row = this.rows.find((candidate) => candidate.id === id)
      if (!row || row.phase !== 'prepared') throw new Error('worktree-journal-recovery-required')
      await proof.verify()
      this.ready(); proof.assertCurrent()
      await this.commit(this.rows.filter((candidate) => candidate.id !== id), proof.assertCurrent)
    })
  }
  idle(): Promise<void> { return this.chain.then(() => {}) }
}
