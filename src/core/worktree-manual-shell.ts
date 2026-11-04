import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stableStringify } from '../shared/canvas-mutations'
import type { PtyCreateOptions } from '../shared/types'
import type { LocalTmuxExecution } from './local-tmux-execution'

export interface ManualShellProfile {
  backend: 'plain' | 'tmux'
  options: PtyCreateOptions
  fingerprint: string
}
export type ManualShellEvidence = { backend: 'plain'; pid: number; birth: string } | {
  backend: 'tmux'; socketPath: string; server: string; sessionId: string; paneId: string;
  panePid: number; paneBirth: string; clientPid: number; clientBirth: string
}
export const manualCreateBinding = (options: PtyCreateOptions): string =>
  createHash('sha256').update(stableStringify(options)).digest('hex')

/** Actual Linux process birth, never an OSC cwd or a name-only session verdict. */
export function manualProcessBirth(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('manual-shell-invalid-process')
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const birth = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  if (!/^\d+$/.test(birth)) throw new Error('manual-shell-unverifiable-process')
  return birth
}

export function manualFileStamp(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd, { bigint: true }); const named = fs.lstatSync(file, { bigint: true })
    const stamp = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
    if (!stat.isFile() || !stat.ino || !named.isFile() || stamp(stat) !== stamp(named))
      throw new Error('manual-shell-file-changed')
    return stamp(stat)
  } finally { fs.closeSync(fd) }
}

export interface ManualTmuxCreated {
  socketPath: string; server: string; sessionId: string; paneId: string; panePid: number; paneBirth: string
}
const format = '#{socket_path}|#{pid}|#{session_id}|#{pane_id}|#{pane_pid}'
export function parseManualTmuxCreated(raw: string): ManualTmuxCreated {
  const fields = raw.trim().split('|')
  if (fields.length !== 5 || !fields[0].startsWith('/') || !/^\d+$/.test(fields[1]) ||
    !/^\$\d+$/.test(fields[2]) || !/^%\d+$/.test(fields[3]) || !/^\d+$/.test(fields[4]))
    throw new Error('manual-shell-tmux-acknowledgement-unverifiable')
  const panePid = Number(fields[4]); const serverPid = Number(fields[1])
  return { socketPath: fields[0], server: `${serverPid}:${manualProcessBirth(serverPid)}`,
    sessionId: fields[2], paneId: fields[3], panePid, paneBirth: manualProcessBirth(panePid) }
}

/** New-only backend creation, not a preprobe followed by attach-or-create. The command itself
 * refuses an existing name. A failed/lost acknowledgement is uncertain and must never retry. */
export function createManualTmux(file: string, args: readonly string[], nonce: string,
  env: Record<string, string>, cwd: string, assertCurrent: () => void): ManualTmuxCreated {
  if (!/^[0-9a-f-]{36}$/.test(nonce)) throw new Error('manual-shell-invalid-intent')
  const command = args.indexOf('new-session')
  if (command < 0) throw new Error('manual-shell-invalid-tmux-command')
  const tail = args.slice(command + 1)
  while (tail[0] === '-A' || tail[0] === '-D') tail.shift()
  const actual = [...args.slice(0, command + 1), '-d', '-P', '-F', format, '-e', `NODETERM_RECOVERY_ID=${nonce}`,
    ...tail]
  assertCurrent()
  const response = execFileSync(file, actual, { encoding: 'utf8', env, cwd, timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })
  return parseManualTmuxCreated(response)
}

export function manualTmuxMatches(created: ManualTmuxCreated, live: LocalTmuxExecution): boolean {
  return created.socketPath === live.socketPath && created.server === live.server && created.sessionId === live.sessionId &&
    created.paneId === live.paneId && created.panePid === live.panePid && created.paneBirth === live.paneBirth
}

/** Synchronous final input proof: the painter may still exist after its backend pane was replaced.
 * Only these explicitly resumed sessions pay this check; ordinary sessions are unchanged. */
export function manualTmuxStillCurrent(file: string, socket: string, expected: ManualShellEvidence & { backend: 'tmux' }): boolean {
  try {
    if (manualProcessBirth(expected.clientPid) !== expected.clientBirth) return false
    const clients = execFileSync(file, ['-L', socket, 'list-clients', '-F', '#{client_pid}|#{session_id}'],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
      .map((row) => row.split('|')).filter((row) => row[0] === String(expected.clientPid))
    if (clients.length !== 1 || clients[0][1] !== expected.sessionId) return false
    const output = execFileSync(file, ['-L', socket, 'list-panes', '-s', '-t', expected.sessionId, '-F', format],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (output.includes('\n')) return false
    const actual = parseManualTmuxCreated(output)
    return actual.socketPath === expected.socketPath && actual.server === expected.server && actual.sessionId === expected.sessionId &&
      actual.paneId === expected.paneId && actual.panePid === expected.panePid && actual.paneBirth === expected.paneBirth
  } catch { return false }
}

/** Read-only freshness of an actual profile source, including proven absence. A missing file
 * must keep the same searchable canonical ancestor; a failed read is never absence. */
export function captureManualProfileFile(file: string): () => void {
  const inspect = (): string => {
    try {
      const stamp = manualFileStamp(file)
      const parent = fs.realpathSync.native(path.dirname(file))
      if (parent !== path.dirname(file) || fs.realpathSync.native(file) !== file) throw new Error('manual-shell-profile-source-redirected')
      const stat = fs.statSync(parent, { bigint: true })
      return `file:${stamp}:${stat.dev}:${stat.ino}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Distinguish a missing target from an existing dangling symlink or inaccessible parent.
      try { fs.lstatSync(file); throw new Error('manual-shell-profile-source-unverifiable') }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
      let parent = path.dirname(file)
      for (let depth = 0; depth < 128; depth++) {
        try {
          const stat = fs.lstatSync(parent, { bigint: true })
          if (!stat.isDirectory() || !stat.ino || stat.isSymbolicLink() || fs.realpathSync.native(parent) !== parent)
            throw new Error('manual-shell-profile-source-redirected')
          fs.accessSync(parent, fs.constants.R_OK | fs.constants.X_OK)
          return `absent:${parent}:${stat.dev}:${stat.ino}`
        } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
        const next = path.dirname(parent); if (next === parent) break; parent = next
      }
      throw new Error('manual-shell-profile-source-unverifiable')
    }
  }
  const captured = inspect()
  return () => { if (inspect() !== captured) throw new Error('manual-shell-profile-source-changed') }
}
