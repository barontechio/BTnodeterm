import { agentConfig, type AgentId, type BuiltinAgentId } from './agents/config'
import type { Settings } from './types'
import type { ProjectLaunchInfo } from './project-settings'

export function projectAgentDefault(info: ProjectLaunchInfo | null | undefined, settings: Settings): AgentId | undefined {
  const raw = info?.resolved.agents.defaultAgentId?.value
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) return undefined
  const known = !!agentConfig(id) || settings.customAgents.some((agent) => agent.id === id)
  return known && !settings.disabledAgents.includes(id) ? id : undefined
}

/** A project may choose only its default agent's literal command; shared commands need host trust. */
export function projectLaunchOverride(agentId: AgentId, info: ProjectLaunchInfo | null | undefined, settings: Settings): { command: string | undefined; requestTrust: boolean } {
  const raw = settings.agentLaunchCommands?.[agentId as BuiltinAgentId]
  const global = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  const fallback = { command: global, requestTrust: false }
  if (!info || projectAgentDefault(info, settings) !== agentId) return fallback
  const entry = info.resolved.agents.launchCmd
  const command = typeof entry?.value === 'string' ? entry.value.trim() : ''
  // Expanding shared ${env:...} would disclose host environment values via an agent's launch.
  if (!command || command.includes('${env:')) return fallback
  if (entry!.source === 'local' || info.trusted.agents) return { command, requestTrust: false }
  return { command: global, requestTrust: true }
}
