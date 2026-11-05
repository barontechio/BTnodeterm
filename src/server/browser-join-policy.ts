import { allowedEndpoint } from '../core/relay/join-code'

/** Only the operator's relay origin enters the app CSP; invite/API input cannot widen it. */
export function browserTeamRelayOrigin(endpoint = process.env.NODETERM_RELAY_URL || 'wss://relay.nodeterm.dev'): string | null {
  try {
    const url = new URL(endpoint)
    if (!allowedEndpoint(endpoint) || url.username || url.password || url.hash || /[\s;'"*]/.test(url.host)) return null
    return url.origin
  } catch { return null }
}
export function browserTeamConnectPolicy(endpoint?: string): string {
  const origin = browserTeamRelayOrigin(endpoint)
  return `connect-src 'self'${origin ? ` ${origin}` : ''};`
}
