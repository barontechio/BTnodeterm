import { randomUUID } from 'node:crypto'
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
export interface WorktreeRemovalRecord extends WorktreeRemovalIntent { id: string; createdAt: number; phase: Phase }
interface Options {
  /** The existing hook/data-directory ownership verdict; a second app instance cannot write. */
  ownsFiles(): boolean
  persist?(file: string, data: string): Promise<void>
}

function record(raw: unknown): WorktreeRemovalRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('worktree-journal-invalid-record')
  const row = raw as WorktreeRemovalRecord
  const fields = new Set(['id', 'createdAt', 'phase', 'projectId', 'groupId', 'repoPath', 'worktreePath', 'branch', 'fallbackCwd', 'directoryStamp', 'members'])
  const absolute = (value: unknown) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') &&
    path.isAbsolute(value) && path.resolve(value) === value && path.parse(value).root !== value
  if (Object.keys(row).some((key) => !fields.has(key)) ||
    ![row.id, row.projectId, row.groupId].every((id) => typeof id === 'string' && isSafeNodeId(id)) ||
    ![row.repoPath, row.worktreePath, row.fallbackCwd].every(absolute) || row.repoPath === row.worktreePath ||
    isAncestorPath(row.worktreePath, row.fallbackCwd) || typeof row.branch !== 'string' || !isValidGitRef(row.branch) ||
    typeof row.directoryStamp !== 'string' || !/^\d+:[1-9]\d*$/.test(row.directoryStamp) ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 || !['prepared', 'removed', 'recovered'].includes(row.phase) ||
    !Array.isArray(row.members) || !row.members.length || row.members.length > 32 ||
    row.members.some((member) => !member || typeof member.nodeId !== 'string' || !isSafeNodeId(member.nodeId) ||
      typeof member.binding !== 'string' || !/^[0-9a-f]{64}$/.test(member.binding) || Object.keys(member).some((key) => key !== 'nodeId' && key !== 'binding')) ||
    new Set(row.members.map((member) => member.nodeId)).size !== row.members.length ||
    !row.members.some((member) => member.nodeId === row.groupId)) throw new Error('worktree-journal-invalid-record')
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
          if (!parsed || parsed.kind !== 'worktree-removals' || parsed.version !== 1 ||
            !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error('worktree-journal-invalid-envelope')
          next = parsed.records.map(record)
          if (new Set(next.map((row) => row.id)).size !== next.length || next.some((row, index) =>
            next.slice(0, index).some((previous) => overlaps(row.worktreePath, previous.worktreePath))))
            throw new Error('worktree-journal-conflicting-records')
        }
        this.owner(); this.rows = next; this.persisted = raw; this.loaded = true; this.faulted = false
        return this.list()
      } catch (error) { this.faulted = true; throw error }
    })
  }
  list(): WorktreeRemovalRecord[] { this.ready(); return structuredClone(this.rows) }
  blocks(canonicalDirectory: string): boolean {
    this.ready()
    if (!path.isAbsolute(canonicalDirectory) || path.resolve(canonicalDirectory) !== canonicalDirectory)
      throw new Error('worktree-journal-canonical-path-required')
    return this.rows.some((row) => isAncestorPath(row.worktreePath, canonicalDirectory))
  }
  private async commit(next: WorktreeRemovalRecord[]): Promise<void> {
    this.ready()
    const data = JSON.stringify({ kind: 'worktree-removals', version: 1, records: next })
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('worktree-journal-capacity')
    try {
      if (await this.read() !== this.persisted) throw new Error('worktree-journal-changed: reload before writing')
      this.ready()
      await (this.options.persist ?? ((file, text) => writeFileDurableAtomic(file, text, { mode: 0o600 })))(this.file, data)
      this.owner(); this.rows = next; this.persisted = data
    } catch (error) { this.faulted = true; throw error }
  }
  prepare(intent: WorktreeRemovalIntent): Promise<WorktreeRemovalRecord> {
    const captured = structuredClone(intent)
    return this.serial(async () => {
      this.ready()
      const next = record({ ...captured, id: randomUUID(), createdAt: Date.now(), phase: 'prepared' })
      if (this.rows.length >= MAX_RECORDS) throw new Error('worktree-journal-capacity')
      if (this.rows.some((row) => overlaps(row.worktreePath, next.worktreePath))) throw new Error('worktree-journal-path-reserved')
      await this.commit([...this.rows, next])
      return structuredClone(next)
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
  /** Caller already proved a new binding; never use this to dismiss an uncertain deletion. */
  releaseRebound(id: string): Promise<void> {
    return this.serial(async () => {
      this.ready()
      const row = this.rows.find((candidate) => candidate.id === id)
      if (!row || row.phase !== 'recovered') throw new Error('worktree-journal-recovery-required')
      await this.commit(this.rows.filter((candidate) => candidate.id !== id))
    })
  }
  idle(): Promise<void> { return this.chain.then(() => {}) }
}
