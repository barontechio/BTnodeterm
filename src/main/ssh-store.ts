import { app, ipcMain } from 'electron'
import path from 'node:path'
import { SshStore as CoreSshStore } from '../core/ssh-store'
import { IPC } from '../shared/ipc'
import type { SshServer } from '../shared/ssh'

/** Native owner-only registration; storage semantics are shared with Server. */
export class SshStore extends CoreSshStore {
  constructor(filePath?: string) { super(filePath ?? path.join(app.getPath('userData'), 'ssh-servers.json')) }
  registerIpc(): void {
    ipcMain.handle(IPC.sshList, () => this.list())
    ipcMain.handle(IPC.sshSave, (_event, server: SshServer) => this.save(server))
    ipcMain.handle(IPC.sshDelete, (_event, id: string) => this.remove(id))
    ipcMain.handle(IPC.sshImport, () => this.importCandidates())
  }
}
