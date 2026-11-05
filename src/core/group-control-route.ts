import { isRemoteSessionNode } from '../shared/worktree'
import type { Workspace } from '../shared/types'

/** Backend selection only. Every host request still performs fresh identity/scope/target checks.
 * Keep Desktop's remote, custom-agent and native-Windows adapters for ordinary grouped opens. */
export function hostGroupedOpenRoute(input: {
  verb: string; args: Record<string, string>; sourceNodeId: string; workspace: Workspace; hostPlatform: string
}): 'host' | 'renderer' | 'unsupported-shell' {
  const { verb, args } = input
  if (!['open-terminal', 'open-agent', 'open-claude'].includes(verb)) return 'renderer'
  if (args.reservation !== undefined) return input.hostPlatform === 'win32' ? 'unsupported-shell' : 'host'
  if (!args.group || input.hostPlatform === 'win32') return 'renderer'
  if (verb === 'open-agent' && !['claude', 'codex', 'gemini'].includes(args.agent)) return 'renderer'
  const holders = input.workspace.projects.filter((project) => project.nodes.some((node) => node.id === input.sourceNodeId))
  if (holders.length !== 1) return 'host' // Named host refusal; never travel the user's canvas.
  const source = holders[0]
  if (source.ssh || isRemoteSessionNode(source.nodes.find((node) => node.id === input.sourceNodeId))) return 'renderer'
  const target = args.project === undefined ? source : input.workspace.projects.find((project) => project.id === args.project)
  return target?.ssh ? 'renderer' : 'host'
}
