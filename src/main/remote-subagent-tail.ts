// Native delivery adapter for the shared remote subagent transcript tail.
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { createRemoteSubagentTail as createCore } from '../core/remote-subagent-tail'
export * from '../core/remote-subagent-tail'

export function createRemoteSubagentTail(win: BrowserWindow, remoteFile: Parameters<typeof createCore>[1]): ReturnType<typeof createCore> {
  return createCore((payload) => { if (!win.isDestroyed()) win.webContents.send(IPC.agentSubagentActivity, payload) }, remoteFile)
}
