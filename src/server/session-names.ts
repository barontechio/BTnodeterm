import { capabilityAgentId, canReadTitle, type AgentId } from '../shared/agents/config'
import { stableStringify } from '../shared/canvas-mutations'
import { IPC } from '../shared/ipc'
import type { CorePlatform } from '../core/platform'

export interface SessionNameTarget {
  projectId: string
  nodeId: string
  sessionId: string
  agentId: string
  accountId?: string
  cwd?: string
  projectCwd?: string
  remote: boolean
  accountAvailable: boolean
}
interface Dependencies {
  owner(clientId: number): boolean
  /** Saved node/project routing and the host's current session association, never wire metadata. */
  target(nodeId: string): SessionNameTarget | undefined
  read(sessionId: string, accountId?: string, agentId?: string): Promise<string | null>
}
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')

/** Both the owner RPC and background sweep use one node-bound host-routing check. */
export class ServerSessionNames {
  constructor(private readonly deps: Dependencies) {}

  private localTarget(nodeId: string): SessionNameTarget | undefined {
    const target = this.deps.target(nodeId)
    return target && !target.remote && target.accountAvailable && target.nodeId === nodeId &&
      canReadTitle(target.agentId as AgentId) ? target : undefined
  }

  available(nodeId: string): boolean { try { return !!this.localTarget(nodeId) } catch { return false } }

  async read(sessionId: unknown, accountId?: unknown, agentId?: unknown, nodeId?: unknown): Promise<string | null> {
    // Optional positional arguments become null inside JSON arrays (Electron preserves undefined).
    if (accountId === null) accountId = undefined
    if (agentId === null) agentId = undefined
    if (!bounded(sessionId) || !bounded(nodeId) || (accountId !== undefined && !bounded(accountId)) ||
      (agentId !== undefined && !bounded(agentId))) return null
    const current = (): SessionNameTarget | undefined => {
      const target = this.localTarget(nodeId)
      if (!target || target.sessionId !== sessionId || (accountId !== undefined && accountId !== target.accountId) ||
        (agentId !== undefined && capabilityAgentId(agentId) !== capabilityAgentId(target.agentId))) return undefined
      return target
    }
    try {
      const target = current()
      if (!target) return null
      const binding = stableStringify(target)
      const name = await this.deps.read(target.sessionId, target.accountId, target.agentId)
      const after = current()
      return after && stableStringify(after) === binding ? name : null
    } catch { return null }
  }

  register(platform: Pick<CorePlatform, 'handleWithSender'>): void {
    platform.handleWithSender(IPC.ptyReadSessionName, (senderId, sessionId, accountId, agentId, nodeId) =>
      this.deps.owner(senderId) ? this.read(sessionId, accountId, agentId, nodeId) : null)
  }
}
