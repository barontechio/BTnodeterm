// Native window adapter; bounded remote reads and parsing live in core.
import type { BrowserWindow } from 'electron'
import type { ContextWindowUsage } from '../shared/types'
import { IPC } from '../shared/ipc'
import { createRemoteContextTail as createCore } from '../core/remote-context-tail'
export * from '../core/remote-context-tail'

export function createRemoteContextTail(
  win: BrowserWindow | ((payload: ContextWindowUsage) => void),
  remoteFile: Parameters<typeof createCore>[1],
  opts?: Parameters<typeof createCore>[2]
): ReturnType<typeof createCore> {
  return createCore(typeof win === 'function' ? win : (payload) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.contextUpdate, payload)
  }, remoteFile, opts)
}
