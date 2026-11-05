import { expect, it } from 'vitest'
import { browserTeamConnectPolicy, browserTeamRelayOrigin } from './browser-join-policy'

it('extracts only exact configured relay origins and refuses CSP injection/wildcards', () => {
  expect(browserTeamConnectPolicy('wss://relay.example:8443/path?x=1')).toBe("connect-src 'self' wss://relay.example:8443;")
  expect(browserTeamConnectPolicy('ws://127.0.0.1:9999')).toBe("connect-src 'self' ws://127.0.0.1:9999;")
  for (const endpoint of ['wss://*.example', 'wss://x;script-src', 'https://relay.example', 'ws://public.example', 'wss://u:p@relay.example', 'invalid']) {
    expect(browserTeamRelayOrigin(endpoint)).toBeNull()
    expect(browserTeamConnectPolicy(endpoint)).toBe("connect-src 'self';")
  }
})
