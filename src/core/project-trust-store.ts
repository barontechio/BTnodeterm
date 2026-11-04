import { promises as fs, lstatSync } from 'fs'
import { captureManualProfileFile } from './worktree-manual-shell'
import { stableStringify } from '../shared/canvas-mutations'
import { readRegularFileNoFollow } from './read-regular-file'
import { createHash } from 'node:crypto'
import path from 'path'
import type { ProjectTrustFamily } from '../shared/project-settings'
import type { SshConnection } from '../shared/ssh'
import { sshHostKey } from '../shared/ssh'
import { platform } from './platform'
import { writeAtomic } from './workspace-store'

export interface ProjectTrustRecord {
  contentHash: string
  approvedAt: string
}

/** Location identity, NEVER a project id (ids are attacker-controlled — hostile-project-json). */
export function localTrustKey(cwd: string): string {
  return `local\0${path.resolve(cwd)}`
}

/**
 * `user@host:port` + remote path. The PORT is part of the location, not decoration: one `user@host`
 * is routinely several different machines — a container, a VM, a jump host behind the same DNS name
 * — separated by port alone (`sshAttachmentId` keys on host+user+port for exactly this reason). An
 * approval granted for the box on :2222 must never authorize the box on :22. An omitted port IS 22,
 * because that is what ssh dials, so the two spellings are one key.
 */
export function sshTrustKey(
  ssh: { server: Pick<SshConnection, 'host' | 'user' | 'port'>; remoteCwd: string }
): string {
  return `ssh\0${sshHostKey(ssh.server)}:${ssh.server.port ?? 22}\0${ssh.remoteCwd}`
}

export function hashTrustContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

type TrustFileEntry = Partial<Record<ProjectTrustFamily, ProjectTrustRecord>>
type TrustFile = Record<string, TrustFileEntry>

/**
 * File: {userData}/project-trust.json. Lazy-loaded, cached; malformed (unparsable/wrong-shape)
 * file → empty store (fail closed — an unreadable trust record must never be read back as
 * "trusted"). A read ERROR (EACCES/EMFILE/EIO…) is different from ABSENT/malformed: it is not
 * evidence the file is empty, so it is never cached and never healed by a write — `isTrusted` fails
 * closed without caching the emptiness, and `record`/`revoke` reject rather than writeAtomic an
 * empty store over the intact on-disk file.
 *
 * `record`/`revoke` serialize through an internal promise chain: both are read-modify-write over
 * the same in-memory + on-disk store, and two overlapping calls racing the read half would let the
 * later write silently clobber the earlier one's change.
 */
export class ProjectTrustStore {
  private cache: TrustFile | null = null
  private chain: Promise<unknown> = Promise.resolve()

  private get filePath(): string {
    return path.join(platform().userDataDir, 'project-trust.json')
  }

  private async load(): Promise<TrustFile> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {}
        return this.cache
      }
      // A non-ENOENT failure (EACCES/EMFILE/EIO…) is not evidence the file is absent — caching {}
      // here would let the next mutate() writeAtomic an empty store over the intact on-disk file,
      // silently destroying every recorded approval. Leave the cache unset so the next call
      // retries the read, and let this failure propagate to the caller.
      throw e
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TrustFile) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  /** Read-only original trust-source fence for a verified manual shell profile. Neither a
   * cached grant nor a later disk snapshot can silently stand in for the other. */
  async captureCurrent(): Promise<() => void> {
    const cache = await this.load()
    const file = this.filePath; const assertFile = captureManualProfileFile(file)
    const raw = await readRegularFileNoFollow(file, 1024 * 1024)
    assertFile()
    if (raw === null) {
      try { lstatSync(file); throw new Error('manual-shell-trust-source-unreadable') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const disk = raw === null ? {} : JSON.parse(raw)
    const captured = stableStringify(cache)
    if (!disk || typeof disk !== 'object' || Array.isArray(disk) || stableStringify(disk) !== captured)
      throw new Error('manual-shell-trust-source-unverifiable')
    return () => {
      if (this.filePath !== file || stableStringify(this.cache) !== captured) throw new Error('manual-shell-trust-source-changed')
      assertFile()
    }
  }

  async isTrusted(key: string, family: ProjectTrustFamily, contentHash: string): Promise<boolean> {
    let store: TrustFile
    try {
      store = await this.load()
    } catch {
      // Fail closed on a read error — never cached, so the next call retries the read.
      return false
    }
    return store[key]?.[family]?.contentHash === contentHash
  }

  /**
   * The stored approval for one family, or null when there is none. For DIALOG COPY only — "you
   * approved this on <date>, and it has changed since" — never as the basis of a grant: a caller
   * deciding whether something may RUN asks `isTrusted`, which compares the hash itself.
   *
   * Mirrors `isTrusted`'s posture on a read failure (catch → null, nothing cached) rather than
   * `record`/`revoke`'s (propagate): the same fail-closed answer as "no approval on file", which
   * for this caller costs a re-prompt, never an unearned yes.
   */
  async getRecord(key: string, family: ProjectTrustFamily): Promise<ProjectTrustRecord | null> {
    let store: TrustFile
    try {
      store = await this.load()
    } catch {
      return null
    }
    return store[key]?.[family] ?? null
  }

  async record(key: string, family: ProjectTrustFamily, contentHash: string, approvedAt: string): Promise<void> {
    return this.mutate((store) => {
      store[key] = { ...store[key], [family]: { contentHash, approvedAt } }
    })
  }

  async revoke(key: string, family?: ProjectTrustFamily): Promise<void> {
    return this.mutate((store) => {
      if (!store[key]) return
      if (!family) {
        delete store[key]
        return
      }
      const { [family]: _dropped, ...rest } = store[key]
      if (Object.keys(rest).length) store[key] = rest
      else delete store[key]
    })
  }

  private mutate(fn: (store: TrustFile) => void): Promise<void> {
    const run = this.chain.then(async () => {
      const store = await this.load()
      fn(store)
      this.cache = store
      await writeAtomic(this.filePath, JSON.stringify(store, null, 2))
    })
    this.chain = run.catch(() => {})
    return run
  }
}
