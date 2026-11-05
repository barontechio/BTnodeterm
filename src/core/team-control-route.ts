import { BUILTIN_AGENT_IDS } from '../shared/agents/config'
import { LOCAL_HEADLESS_AGENTS } from '../shared/headless-agents'
import { parseTeamSpec } from '../shared/team-spec'
import { isRemoteSessionNode } from '../shared/worktree'
import type { Settings, Workspace } from '../shared/types'

/** Backend selection, not authorization. The host planner rechecks source, target and ownership. */
export function useHostTeamPlanner(input: {
  verb: 'spawn-team' | 'verify'; sourceNodeId: string; args: Record<string, string>; workspace: Workspace
  settings: Settings; hostPlatform: string; agentIdOf?(id: string): string | undefined
}): boolean {
  if (input.hostPlatform === 'win32' || input.args.project !== undefined) return false
  const projects = input.workspace.projects.filter((p) => p.nodes.some((n) => n.id === input.sourceNodeId))
  if (projects.length !== 1) return true // the host gives the named source refusal, without a UI effect
  const project = projects[0]
  const source = project.nodes.find((n) => n.id === input.sourceNodeId)!
  if (project.ssh || isRemoteSessionNode(source)) return false
  if (input.verb === 'spawn-team') {
    const known = new Set<string>([...BUILTIN_AGENT_IDS, ...input.settings.customAgents.map((agent) => agent.id)])
    const parsed = parseTeamSpec(input.args.team ?? '', known)
    return !parsed.ok || parsed.roles.every((role) => (LOCAL_HEADLESS_AGENTS as readonly string[]).includes(role.agent))
  }
  const target = project.nodes.find((node) => node.id === input.args.node)
  if (target && isRemoteSessionNode(target)) return false
  const agent = input.args.agent || (target && (target.agentId || input.agentIdOf?.(target.id)))
  return !agent || (LOCAL_HEADLESS_AGENTS as readonly string[]).includes(agent)
}
