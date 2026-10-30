import { promises as fs, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from './fs-atomic'
import { parseSshConfig, type ParsedSshHost, type SshServer } from '../shared/ssh'

/**
 * Stores saved SSH servers in ssh-servers.json. Keeps a synchronous cache so reads are
 * immediate; writes are atomic (temp + rename). The file path is injectable for tests.
 */
export class SshStore {
  private cache: SshServer[] = []
  private readonly path: string
  /** Serializes flushes so concurrent un-awaited saves publish in order. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(filePath: string, private readonly homeDir: string = os.homedir()) {
    this.path = filePath
    try {
      const raw = readFileSync(this.path, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.cache = parsed as SshServer[]
    } catch {
      this.cache = []
    }
  }

  list(): SshServer[] { return structuredClone(this.cache) }

  save(server: SshServer): Promise<SshServer[]> {
    const requested = structuredClone(server)
    return this.edit((current) => {
      const index = current.findIndex((candidate) => candidate.id === requested.id)
      if (index >= 0) current[index] = requested
      else current.push(requested)
      return current
    })
  }

  remove(id: string): Promise<SshServer[]> {
    return this.edit((current) => current.filter((server) => server.id !== id))
  }

  private edit(change: (current: SshServer[]) => SshServer[]): Promise<SshServer[]> {
    const run = this.writeChain.then(async () => {
      const next = change(this.list())
      await writeFileAtomic(this.path, JSON.stringify(next, null, 2), { mode: 0o600 })
      this.cache = next
      return this.list()
    })
    this.writeChain = run.then(() => {}, () => {})
    return run
  }

  /** Parse the user's `~/.ssh/config` into importable hosts (empty if it doesn't exist). */
  async importCandidates(): Promise<ParsedSshHost[]> {
    try {
      const text = await fs.readFile(path.join(this.homeDir, '.ssh', 'config'), 'utf-8')
      return parseSshConfig(text)
    } catch {
      return []
    }
  }

}
