/** The legacy command always names Claude, including when a caller supplied --agent. */
export function controlOpenAgent(verb: 'open-agent' | 'open-claude', args: Record<string, string>): Record<string, string> {
  return verb === 'open-claude' ? { ...args, agent: 'claude' } : args
}
