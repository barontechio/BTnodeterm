/** Private browser join markers. No server connection IDs or owner APIs live here. */
const connections = new Set<string>()
export function markBrowserTeamConnection(id: string): void { connections.add(id) }
export function forgetBrowserTeamConnection(id: string): void { connections.delete(id) }
export function isBrowserTeamConnection(id: string): boolean { return id.startsWith('browser-team-') || connections.has(id) }
