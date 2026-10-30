import { setNativePassphrasePrompt, useNativeSsh } from '../../core/remote-ssh/native/native-runtime'
import path from 'path'
import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getMainWindow, sendToMain, type MainWindowLike } from '../main-window'
import { PassphrasePrompts, type PassphraseRecipient } from '../../core/remote-ssh/passphrase-prompts'
import { type SshConnection } from '../../shared/ssh'
import type { SshPassphraseRequest, SshProjectStatusEvent } from '../../shared/types'
import { allowMediaPath } from '../media-protocol'
import { makeSshProjectRunners } from '../../core/remote-ssh/ssh-process-runners'

import { hookServer } from '../../core/agents/hook-server'
import { nodeIdsForCanvas, remoteNodeTokenMinter, setRemoteNodeTokenWriter } from '../../core/agents/node-token-service'
import { setRemoteSessionEnvWriter } from '../../core/remote-ssh/session-env'
import { askpassServer } from './ssh-askpass'
import { appSshAgent } from './ssh-agent'

import { SshProjectManager, type SshProjectRunners as Runners } from '../../core/remote-ssh/ssh-project'
export { SshProjectManager, lastSshErrorLine, remoteCodexAccountSetupCommand, remoteCodexAppServerStartCommand } from '../../core/remote-ssh/ssh-project'
export type { ConnectResult } from '../../core/remote-ssh/ssh-project'

const passphrasePrompts = new PassphrasePrompts()
const promptRecipients = new Map<MainWindowLike, { recipient: PassphraseRecipient; depart(): void; id?: number }>()
function releasePromptWindow(window: MainWindowLike): void {
  const entry = promptRecipients.get(window); promptRecipients.delete(window); entry?.depart()
}
export function forgetSshPassphraseOwner(id: number): void {
  for (const [window, entry] of promptRecipients) if (entry.id === id) releasePromptWindow(window)
}
function nativePromptRecipient(): PassphraseRecipient | null {
  const window = getMainWindow(); if (!window) return null
  const previous = promptRecipients.get(window); if (previous) return previous.recipient
  let live = true; const listeners = new Set<() => void>()
  const owner = { active: () => live && getMainWindow() === window,
    onDeparture: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const recipient: PassphraseRecipient = { owner,
    request: (message) => {
      if (!owner.active()) return false
      try { window.webContents.send(IPC.sshPassphraseRequest, message); return true } catch { return false }
    },
    dismiss: (requestId) => { if (owner.active()) window.webContents.send(IPC.sshPassphraseDismiss, { requestId }) }
  }
  promptRecipients.set(window, { recipient, id: window.webContents.id, depart: () => {
    live = false; for (const listener of [...listeners]) listener(); listeners.clear()
  } })
  window.on('closed', () => releasePromptWindow(window))
  return recipient
}
export function promptForPassphrase(req: Omit<SshPassphraseRequest, 'requestId'>): Promise<string | null | undefined> {
  return passphrasePrompts.request(req, nativePromptRecipient())
}
export function resolvePassphrasePrompt(requestId: string, value: string | null): void {
  const recipient = nativePromptRecipient()
  if (recipient) passphrasePrompts.submit(recipient.owner, requestId, value)
}

/** In-process listeners for every project status event (beside the renderer push). Used by the
 *  dev-port forward registry to forget a disconnected project's forwards. */
const sshStatusListeners = new Set<(e: SshProjectStatusEvent) => void>()
export function onSshProjectStatus(listener: (e: SshProjectStatusEvent) => void): () => void {
  sshStatusListeners.add(listener)
  return () => sshStatusListeners.delete(listener)
}

export function initSshProject(
  onConnected?: (projectId: string) => void,
  askpassScriptPath?: string,
  /** Passed straight through to the manager's `onTunnelVerified` (see Runners). It lives on the
   *  caller because the resync it drives needs main's agent-status funnel and transcript readers,
   *  none of which this module knows about. */
  onTunnelVerified?: (projectId: string, controlPath: string, conn: SshConnection) => void,
  /** Resolves the standalone relay bundle (`out/main/codex-relay.js`, ws inlined) to upload to a
   *  Linux host. Injected by the caller (main/index.ts) so this module reads no build artifact
   *  itself. Undefined ⇒ no managed Codex runtime is installed, and every non-Codex path is
   *  unchanged (Server Edition passes nothing today — see the PR's I2 decision). */
  codexRelaySource?: () => Promise<string>,
  /** Current `settings.tmuxLeadPaneWidth` for the remote tmux conf (issue #119). Injected by
   *  main/index.ts because the settings store lives there; absent ⇒ 0 ⇒ pre-feature conf. */
  leadPaneWidth?: () => number,
  /** The managed Claude accounts pinned to a host (see Runners.claudeAccountIdsForHost). Injected
   *  for the same reason: the settings store lives in main/index.ts. */
  claudeAccountIdsForHost?: (hostKey: string) => string[],
  /** Agent-integration consent per host (see Runners.integrationsForHost / integrationReceipts). */
  integrations?: Pick<Runners, 'integrationsForHost' | 'integrationReceipts'>
): SshProjectManager {
  // No window reference is threaded through here on purpose: every renderer push resolves the
  // live window AT SEND TIME (getMainWindow/sendToMain), because a captured BrowserWindow goes
  // stale across a macOS close/reopen cycle (see main-window.ts).
  ipcMain.handle(IPC.sshPassphraseSubmit, (event, requestId: string, value: string | null) => {
    if (getMainWindow()?.webContents.id === event.sender.id) resolvePassphrasePrompt(requestId, value)
  })
  // WINDOWS (and NODETERM_NATIVE_SSH=1): OpenSSH cannot multiplex there, so every runner below is
  // served by the in-process transport instead (core/remote-ssh/native/). The manager does not
  // know: it still builds OpenSSH argv and reads OpenSSH-shaped answers. Decided ONCE here, at
  // boot, so a single app run never mixes the two transports for one ControlPath.
  const native = useNativeSsh()
  if (native) {
    setNativePassphrasePrompt(async (identityFile, req) =>
      (await promptForPassphrase({ identityFile, retry: req.retry, target: req.target })) ?? null
    )
  }
  const mgr = new SshProjectManager(makeSshProjectRunners({
    userDataDir: app.getPath('userData'),
    agent: appSshAgent, askpass: askpassServer, askpassScriptPath,
    onTunnelVerified,
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    codexRelaySource,
    leadPaneWidth,
    claudeAccountIdsForHost,
    ...integrations,
    // Per-node identity for REMOTE nodes. Both come from the same module the local materialiser
    // uses, so one canvas cannot be judged by two different rules depending on where it runs.
    nodeIdsForProject: (projectId) => nodeIdsForCanvas(projectId),
    nodeTokenMinter: () => remoteNodeTokenMinter(),
    onStatus: (e) => {
      for (const listener of [...sshStatusListeners]) {
        try {
          listener(e)
        } catch {
          // an in-process listener must never break the status push to the UI
        }
      }
      // sendToMain resolves the window AT SEND TIME (see main-window.ts): the `win` captured here
      // is destroyed and recreated by a macOS close/reopen, and sending to the stale reference is
      // silently dropped. The try/catch is the other half: webContents.send THROWS when the render
      // frame is disposed even though isDestroyed() is false (renderer crash, reload, quit), and a
      // status push must never be load-bearing. It used to abort connect() mid-flight, which left
      // a dead entry in the map, discarded the real ssh error, and on the disconnectAll path
      // orphaned every remaining master.
      try {
        sendToMain(IPC.sshProjectStatus, e)
      } catch {
        // a UI that cannot hear us changes nothing about the connection itself
      }
    }
  }))
  // The spawn-path leg of the remote materialiser: `pty-manager` (core) reaches the ControlMaster
  // through this registration, because the runner that owns it lives here, in main.
  setRemoteNodeTokenWriter((controlPath, nodeIds) => {
    void mgr.writeNodeTokenForNode(controlPath, nodeIds)
  })
  // Same seam, same shape: the pty spawn path stages a remote session's env file (gateway/custom
  // values, argv-free) through the manager that owns the ssh runner. See core/remote-ssh/session-env.ts.
  setRemoteSessionEnvWriter((controlPath, remotePath, content) => {
    void mgr.writeSessionEnvFile(controlPath, remotePath, content)
  })
  // Registered after `mgr` exists so the dialog can name the server: the askpass request carries
  // the asking master's pid, and only the manager can map it back to a connection.
  askpassServer.setPromptHandler((req) =>
    // A silent pre-warm never prompts: declining is what keeps a background dial from putting a
    // passphrase modal in front of a user who opened nothing. `null` is the same answer a decline
    // gives, so ssh abandons that key and the pre-warm's master simply fails, quietly.
    mgr.isQuietMasterPid(req.caller)
      ? Promise.resolve(null)
      : promptForPassphrase({ ...req, target: mgr.targetForMasterPid(req.caller) })
  )
  mgr.startWatchdog()
  ipcMain.handle(IPC.sshConnectProject, async (_e, projectId: string, conn: SshConnection, remoteCwd?: string) => {
    const res = await mgr.connect(projectId, conn, remoteCwd)
    // Connection is up (master in the map) → reconcile the remote project file with our cache.
    // Only fires on a successful connect; a throw above propagates without calling back.
    onConnected?.(projectId)
    return res
  })
  // `final`: the only USER-facing disconnect there is (a deleted project, or the connect dialog
  // dropping its browse master). Internal teardowns never reach here, which is what makes "no
  // connections left" a trustworthy signal to forget the key.
  ipcMain.handle(IPC.sshDisconnectProject, (_e, projectId: string) =>
    mgr.disconnect(projectId, { final: true })
  )
  ipcMain.handle(
    IPC.sshKillSessions,
    (_e, projectId: string, nodeIds: string[], opts?: { everySocket?: boolean }) =>
      mgr.killSessions(projectId, nodeIds, opts)
  )
  ipcMain.handle(IPC.sshListDir, (_e, projectId: string, dir: string) => mgr.listDir(projectId, dir))
  ipcMain.handle(IPC.sshMkdir, (_e, projectId: string, dir: string) => mgr.makeDir(projectId, dir))
  ipcMain.handle(IPC.sshUploadFile, (_e, projectId: string, localPath: string, fileName: string) =>
    mgr.uploadFile(projectId, localPath, fileName)
  )
  // The DESTINATION is resolved here, in main: the OS Downloads folder unless the renderer passed
  // a directory the user picked in the native folder dialog. The renderer never gets to name an
  // arbitrary local write target for a remote payload.
  ipcMain.handle(IPC.sshDownloadFile, (_e, projectId: string, remotePath: string, destDir?: string) =>
    mgr.downloadFile(projectId, remotePath, destDir || app.getPath('downloads'))
  )
  // A VideoNode in an SSH project plays a HOST file: pull it into the local media cache over the
  // ControlMaster, allowlist the cached copy, and hand back its nt-media:// URL.
  ipcMain.handle(IPC.sshMediaAllow, async (_e, projectId: string, remotePath: string) => {
    const r = await mgr.cacheMediaFile(
      projectId,
      remotePath,
      path.join(app.getPath('userData'), 'remote-media-cache')
    )
    return r.ok ? { ok: true, url: allowMediaPath(r.localPath) } : r
  })
  return mgr
}
