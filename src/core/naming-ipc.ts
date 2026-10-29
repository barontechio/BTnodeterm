// ✦ Name with AI: the two pty naming handlers, registered once here and called by BOTH shells.
// They used to live in src/main/index.ts while commit-message.ts was main-resident, and the Server
// Edition's bridge answered every request with a hard-coded "not available" — long after the
// module had moved to core. One registration keeps the two shells from drifting again.

import { existsSync } from 'fs'
import { IPC } from '../shared/ipc'
import type { Settings } from '../shared/types'
import { platform } from './platform'
import { claudeConfigDirFor } from './claude-config-dir'
import { claudeAccountEnv, generateGroupName, generateTerminalName } from './commit-message'

export interface NamingIpcDeps {
  /** The pane's recent output — the whole prompt; the agent never reads the terminal itself. */
  captureSession(persistKey: string): Promise<string>
  /** Truthy when the node's session runs on an SSH host (desktop only; the server has none). */
  sshRemoteForNode(persistKey: string): unknown
  getSettings(): Settings
}

export function registerNamingIpc(deps: NamingIpcDeps): void {
  // The naming agent runs LOCALLY on captured output, so it needs a cwd that exists on THIS
  // machine. An SSH-project node's `data.cwd` is a path on the REMOTE host — spawning there fails
  // (ENOENT) and the ✦ button silently did nothing. The cwd carries no meaning for naming (the
  // terminal output is in the prompt), so a remote node falls back to '' → runAgent's os.homedir().
  const localNamingCwd = (keys: string[], cwd: string): string =>
    keys.some((k) => deps.sshRemoteForNode(k)) ? '' : cwd

  // The naming agent runs under the NODE's managed Claude account (same resolution as the pty
  // spawn: a known, non-pending local account whose dir exists), else the system `~/.claude`.
  // Without this every ✦ request went out as the system login — which may be logged out or
  // expired even while the node's own account works fine.
  const namingEnv = (accountId?: string): NodeJS.ProcessEnv | undefined => {
    if (!accountId) return undefined
    const acct = deps.getSettings().claudeAccounts.find((a) => a.id === accountId)
    if (!acct || acct.pending || acct.host) return undefined
    const dir = claudeConfigDirFor(accountId)
    return existsSync(dir) ? claudeAccountEnv(process.env, dir) : undefined
  }

  platform().handle(
    IPC.ptyGenerateName,
    async (persistKey: string, cwd: string, accountId?: string) =>
      generateTerminalName(
        await deps.captureSession(persistKey),
        localNamingCwd([persistKey], cwd),
        deps.getSettings(),
        namingEnv(accountId)
      )
  )

  platform().handle(IPC.ptyGenerateGroupName, async (memberKeys: string[], cwd: string) => {
    const contents = await Promise.all(memberKeys.map((k) => deps.captureSession(k)))
    return generateGroupName(contents, localNamingCwd(memberKeys, cwd), deps.getSettings())
  })
}
