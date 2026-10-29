// Background index of all Claude session transcripts under ~/.claude/projects AND every managed
// LOCAL account's {userData}/claude-accounts/<id>/projects. Built on launch + refreshed every 5
// min, incrementally by mtime, and persisted to userData so a relaunch doesn't cold re-scan.
// Search runs in-memory over the index. Read-only and local.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { platform } from './platform'
import type { ClaudeAccount, TranscriptSearchScope } from '../shared/types'
import { accountConfigDir, normalizeLinkedConfigDir } from './claude-accounts-core'
import { SESSION_ID_RE } from './transcript-reader'
import { sweepStaleTempFiles, writeFileAtomic } from './fs-atomic'
import {
  extractEntryFields,
  planRefresh,
  searchEntries,
  type ScanFile,
  type TranscriptIndexEntry,
  type TranscriptHit
} from './transcript-index-core'

export const TRANSCRIPT_INDEX_REFRESH_MS = 5 * 60 * 1000
const READ_CAP_BYTES = 5 * 1024 * 1024 // mirror transcript-reader: never read more than the tail

let entries: TranscriptIndexEntry[] = []
// True while the in-memory index holds changes the file does not. Cleared only by a write that
// landed, so a failed persist is retried on the next refresh instead of waiting for an unrelated
// transcript change — and a refresh that changed nothing still costs no 16 MB rewrite.
let dirty = false
let timer: NodeJS.Timeout | undefined
let accountsGetter: (() => ClaudeAccount[]) | undefined
let generation = 0
let closed = false
const refreshTasks = new Set<Promise<void>>()

function indexFilePath(): string {
  return path.join(platform().userDataDir, 'transcript-index.json')
}

// Every LOCAL transcript root to index: the system default plus each managed LOCAL account's
// projects dir. Remote accounts (a `host` set) live on another host's fs → not scanned here.
function projectsRoots(): string[] {
  return accountRoots().map((r) => r.root)
}

function accountRoots(): Array<{ root: string; accountId?: string }> {
  const roots: Array<{ root: string; accountId?: string }> = [
    { root: path.join(os.homedir(), '.claude', 'projects') }
  ]
  const userData = platform().userDataDir
  for (const acct of accountsGetter?.() ?? []) {
    if (acct.host || acct.pending) continue
    try {
      // A LINKED account indexes the user's OWN dir. Re-validated here rather than
      // trusted — settings.json is hand-editable — and an unusable value falls back to the managed
      // path, which simply contributes an absent root.
      const dir = normalizeLinkedConfigDir(acct.configDir) ?? accountConfigDir(userData, acct.id)
      roots.push({ root: path.join(dir, 'projects'), accountId: acct.id })
    } catch {
      /* invalid account id → skip that root (fail-open) */
    }
  }
  return roots
}

// Walk each root's <projectDir>/<sessionId>.jsonl, returning {sessionId, path, mtime}. Fail-open
// per root (a missing/unreadable account dir just contributes nothing).
async function scanTranscripts(epoch: number): Promise<ScanFile[]> {
  const out: ScanFile[] = []
  for (const root of projectsRoots()) {
    if (closed || generation !== epoch) return []
    let dirs: string[]
    try {
      dirs = await fs.promises.readdir(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      if (closed || generation !== epoch) return []
      let files: string[]
      try {
        files = await fs.promises.readdir(path.join(root, d))
      } catch {
        continue
      }
      for (const f of files) {
        if (closed || generation !== epoch) return []
        if (!f.endsWith('.jsonl')) continue
        const sessionId = f.slice(0, -'.jsonl'.length)
        if (!SESSION_ID_RE.test(sessionId)) continue
        const p = path.join(root, d, f)
        try {
          const st = await fs.promises.stat(p)
          out.push({ sessionId, transcriptPath: p, mtime: Math.floor(st.mtimeMs) })
        } catch {
          /* skip */
        }
      }
    }
  }
  return out
}

async function readTail(filePath: string): Promise<string> {
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const { buffer } = await fd.read({
          position: st.size - READ_CAP_BYTES,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n')
        return nl >= 0 ? s.slice(nl + 1) : s
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Read a persisted index. Anything unreadable is an empty index: the next refresh rebuilds it. */
export function loadPersistedIndex(file: string): TranscriptIndexEntry[] {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data.filter((entry) => entry && typeof entry === 'object' &&
      ['sessionId', 'transcriptPath', 'cwd', 'title', 'text'].every((key) => typeof entry[key] === 'string') &&
      Number.isFinite(entry.mtime)) : []
  } catch {
    return []
  }
}

/**
 * Persist the index; resolves false (never throws) when the write did not land.
 *
 * It was a bare `writeFile` of ~16 MB every 5 minutes while agents are active. A crash or power
 * loss mid-write left truncated JSON, which loads as an empty index and forces a cold rescan —
 * measured at ~779 MB read and ~3.2 s. Temp + rename
 * means a reader sees the old index or the new one, never half of either. Mode 0600 because the
 * file holds transcript text (it was 0644).
 */
export async function persistIndex(
  file: string,
  index: TranscriptIndexEntry[]
): Promise<boolean> {
  try {
    await writeFileAtomic(file, JSON.stringify(index), { mode: 0o600 })
    return true
  } catch {
    return false // best-effort: the caller keeps the index dirty and tries again next refresh
  }
}

// One refresh at a time. A cold scan of a large tree can outlast the interval, and two overlapping
// runs would race their persists (and the `dirty` flag) as well as reading every file twice.
let refreshing: Promise<void> | undefined
let refreshingGeneration = -1
/** Rescan and persist if owed — what launch and the 5-minute timer run. A call while a refresh is
 *  in flight joins it rather than starting a second scan. */
export function refreshTranscriptIndex(): Promise<void> {
  if (closed) return Promise.resolve()
  if (refreshing && refreshingGeneration === generation) return refreshing
  refreshingGeneration = generation
  const task = refreshOnce(generation).finally(() => {
    refreshTasks.delete(task)
    if (refreshing === task) refreshing = undefined
  })
  refreshing = task
  refreshTasks.add(task)
  return task
}

async function refreshOnce(epoch: number): Promise<void> {
  const scan = await scanTranscripts(epoch)
  if (closed || generation !== epoch) return
  const { toRead, keep } = planRefresh(entries, scan)
  // Only persist when the index actually changed (new/updated entries or dropped ones).
  const changed = toRead.length > 0 || keep.length !== entries.length
  const fresh: TranscriptIndexEntry[] = [...keep]
  for (const f of toRead) {
    if (closed || generation !== epoch) return
    const text = await readTail(f.transcriptPath)
    const { cwd, title, text: body } = extractEntryFields(text)
    fresh.push({
      sessionId: f.sessionId,
      transcriptPath: f.transcriptPath,
      cwd,
      mtime: f.mtime,
      title,
      text: body
    })
  }
  if (closed || generation !== epoch) return
  entries = fresh
  if (changed) dirty = true
  if (dirty) {
    const saved = await persistIndex(indexFilePath(), entries)
    if (!closed && generation === epoch) dirty = !saved
  }
}

export function searchTranscripts(query: string, scope: TranscriptSearchScope = {}): TranscriptHit[] {
  const roots = accountRoots().sort((a, b) => b.root.length - a.root.length)
  const rootFor = (file: string) => {
    const matches = roots.filter((r) => {
      const relative = path.relative(r.root, file)
      return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    })
    const first = matches[0]
    if (!first || matches.some((r) => path.resolve(r.root) === path.resolve(first.root) && r.accountId !== first.accountId)) return undefined
    return first
  }
  const eligible = entries.filter((entry) => {
    const root = rootFor(entry.transcriptPath)
    return root && (scope.accountId === undefined || (root.accountId ?? null) === scope.accountId) &&
      (scope.cwd === undefined || entry.cwd === scope.cwd)
  })
  return searchEntries(eligible, query, scope.limit, (p) => rootFor(p)?.accountId)
}

export function initTranscriptIndex(getAccounts?: () => ClaudeAccount[]): void {
  if (timer) clearInterval(timer)
  generation++
  closed = false
  dirty = false
  accountsGetter = getAccounts
  entries = loadPersistedIndex(indexFilePath())
  // Collect the legacy ownerless `<file>.tmp` shape once it is a day old. A pid-bearing temp left by
  // a crash inside writeFileAtomic is deliberately NOT collected (fs-atomic cannot prove its writer
  // dead across PID namespaces), so such an orphan stays until removed by hand.
  void sweepStaleTempFiles(indexFilePath())
  void refreshTranscriptIndex()
  timer = setInterval(() => void refreshTranscriptIndex(), TRANSCRIPT_INDEX_REFRESH_MS)
  if (timer.unref) timer.unref()
}

/** Retire the scanner before shell shutdown; old refreshes cannot repopulate a new lifetime. */
export async function stopTranscriptIndex(): Promise<void> {
  closed = true
  const epoch = ++generation
  if (timer) clearInterval(timer)
  timer = undefined
  await Promise.allSettled([...refreshTasks])
  if (generation === epoch) {
    entries = []
    accountsGetter = undefined
  }
}
