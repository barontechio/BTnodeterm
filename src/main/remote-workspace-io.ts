import path from 'path'
import { sshEndpointKey } from '../shared/ssh'
import type { Project } from '../shared/types'
import type { RemoteReadResult, RemoteWorkspaceIO } from '../core/workspace-store'
import { PROJECT_DIR, PROJECT_FILE } from '../core/workspace-files'
import { PROJECT_SETTINGS_FILE } from '../shared/project-settings'
import type { SshFs, SshFsRef } from './ssh-fs'

/** Resolves an SSH project's live control master; null while disconnected. */
type RefResolver = (projectId: string) => (SshFsRef & { remoteCwd?: string }) | null

export interface RemoteWorkspaceIOWithFlush extends RemoteWorkspaceIO {
  /** Runs every pending throttled trailing write NOW. Call before the masters are killed at quit. */
  flush(): Promise<void>
}

/**
 * Remote .nodeterm IO over the project's existing ControlMaster. Fail-open on writes: while the
 * project is disconnected a write is a quiet no-op (false) — the cache in workspace.json keeps
 * the project usable offline. Reads are CHECKED: a down connection or ssh failure reports
 * `error`, never `absent` — the reconciler treats only a real "no such file" as absence.
 * Writes are throttled per project (the renderer already debounces at 800 ms; a remote
 * round-trip per keystroke burst is still too chatty — spec says ~5 s). A throttled write is
 * acked optimistically; if the trailing run later fails, `onDropped` reports it back so the
 * store re-owes the mirror instead of believing it landed.
 *
 * The settings pair (`readSettings`/`writeSettings`, `.nodeterm/settings.json`) rides the same
 * connection but NOT the throttle — see `writeSettings`. `flush()` therefore still covers only
 * project.json's pending writes: a settings write has already been on the wire when it returns.
 */
export function makeRemoteWorkspaceIO(
  resolveRef: RefResolver,
  sshFs: SshFs,
  onDropped?: (projectId: string) => void
): RemoteWorkspaceIOWithFlush {
  const lastWrite = new Map<string, number>()
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }>()
  const WRITE_THROTTLE_MS = 5000

  const remotePath = (ssh: NonNullable<Project['ssh']>, file: string): string =>
    path.posix.join(ssh.remoteCwd, PROJECT_DIR, file)

  const matchingRef = (projectId: string, target: NonNullable<Project['ssh']>) => {
    const ref = resolveRef(projectId)
    if (!ref || sshEndpointKey(ref.conn) !== sshEndpointKey(target.server) ||
      (ref.remoteCwd !== undefined && ref.remoteCwd !== target.remoteCwd)) return null
    return ref
  }

  return {
    async read(projectId, ssh): Promise<RemoteReadResult> {
      const ref = matchingRef(projectId, ssh)
      if (!ref) return { status: 'error' }
      return sshFs.readTextChecked(ref, remotePath(ssh, PROJECT_FILE))
    },
    async write(projectId, ssh, content) {
      ssh = structuredClone(ssh)
      const run = async (): Promise<boolean> => {
        lastWrite.set(projectId, Date.now())
        // Re-resolve at fire time: a trailing write scheduled before a reconnect must use the
        // live master, and a dead one must report the drop instead of throwing.
        const ref = matchingRef(projectId, ssh)
        if (!ref) return false
        try {
          return await sshFs.writeText(ref, remotePath(ssh, PROJECT_FILE), content)
        } catch {
          return false
        }
      }
      if (!matchingRef(projectId, ssh)) return false
      const since = Date.now() - (lastWrite.get(projectId) ?? 0)
      if (since >= WRITE_THROTTLE_MS) {
        // Cancel any pending trailing write so a stale older payload can't fire AFTER this newer
        // one and clobber the final state (final-state-wins).
        const prev = pending.get(projectId)
        if (prev) clearTimeout(prev.timer)
        pending.delete(projectId)
        return run()
      }
      // Trailing write: acked optimistically; a later failure is reported via onDropped so the
      // store re-owes the mirror (the old fire-and-forget silently lost the payload).
      const fire = async (): Promise<void> => {
        pending.delete(projectId)
        if (!(await run())) onDropped?.(projectId)
      }
      const prev = pending.get(projectId)
      if (prev) clearTimeout(prev.timer)
      pending.set(projectId, { timer: setTimeout(() => void fire(), WRITE_THROTTLE_MS - since), run: fire })
      return true
    },
    async readSettings(projectId, ssh): Promise<RemoteReadResult> {
      const ref = matchingRef(projectId, ssh)
      if (!ref) return { status: 'error' }
      return sshFs.readTextChecked(ref, remotePath(ssh, PROJECT_SETTINGS_FILE))
    },
    // Deliberately NOT throttled, and deliberately not sharing project.json's throttle bookkeeping:
    // the 5 s window exists for canvas churn (a node dragged across the screen), while a settings
    // save is a cold, user-initiated act. Delaying or reordering one behind a canvas write would
    // make "Save" mean "maybe, in five seconds" — so this goes straight to the wire and reports the
    // real outcome. The store's cache-first write already makes a false here non-fatal.
    async writeSettings(projectId, ssh, content) {
      const ref = matchingRef(projectId, ssh)
      if (!ref) return false
      try {
        return await sshFs.writeText(ref, remotePath(ssh, PROJECT_SETTINGS_FILE), content)
      } catch {
        return false
      }
    },
    async flush() {
      const flushed = [...pending.values()]
      for (const p of flushed) clearTimeout(p.timer)
      pending.clear()
      await Promise.all(flushed.map((p) => p.run()))
    }
  }
}
