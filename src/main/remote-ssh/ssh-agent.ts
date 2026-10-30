import { app } from 'electron'
import { AppSshAgent, agentSockPath as coreAgentSockPath, instanceSockId as coreInstanceSockId } from '../../core/remote-ssh/ssh-agent'
export { AppSshAgent } from '../../core/remote-ssh/ssh-agent'
function dataDirKey(): string {
  if (process.env.NT_USER_DATA) return process.env.NT_USER_DATA
  try { return app?.getPath('userData') ?? 'default' } catch { return 'default' }
}
export function agentSockPath(key = dataDirKey()): string { return coreAgentSockPath(key) }
export function instanceSockId(key = dataDirKey()): string { return coreInstanceSockId(key) }
// Preserve the native instance's namespace even before CorePlatform initialization.
export const appSshAgent = new AppSshAgent(undefined, agentSockPath())
