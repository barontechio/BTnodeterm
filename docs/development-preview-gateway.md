# Development preview gateway (not enabled)

The transport and bounded grant registry are implemented in `core/development-previews.ts`
and `server/development-preview.ts`. They are deliberately not mounted in Server Edition yet.
The existing static HTML preview remains script-disabled and is a different feature.

Each grant allocates a fresh random HTTPS hostname under an operator-provided preview base.
Deployment needs wildcard DNS and TLS and a reverse proxy that preserves the exact Host header,
routes only that preview suffix to this transport, and never serves application/auth/management
routes there. The preview base must use a separate registrable domain from the application.
The current constructor checks normalized HTTPS and parent/child hostname collisions; **it does
not yet validate the public suffix boundary**, so deployment configuration is not ready to expose.
Different grants never reuse an origin. Browser storage is isolated by hostname; upstream Cookie,
Authorization, proxy, management/debug and Referer headers are never forwarded, and Set-Cookie is
not returned. Cookie-based development-app login is consequently unsupported in this version.

The hostname is a short-lived bearer capability. Do not log or share it. A script served there
can use its own grant; it cannot obtain application credentials through this transport. Scripts
can navigate: the response CSP is not a navigation sandbox. Workers are disabled to prevent a
service worker persisting past revocation. The application must retain its existing independent
CSRF and authentication protections.

The host-only authority must resolve an approved record, not a browser-supplied URL or port.
Every resolve must prove owner lifetime, saved project/node membership, backend generation,
listener PID/birth/socket identity, destination host and port, and exclusion of management and
debug services. HTTP and WebSocket dispatch compare that fresh proof with the grant. The current
DevPortsReport alone is insufficient: its public shape intentionally omits process birth identity.
An OS-level destination replacement between proof and connection also needs a connected-socket
identity check before forwarding traffic; this adapter has not been implemented. Do not wire a
best-effort name/port check into the authority and advertise generation-safe previews.

Revocation, owner departure, expiry and stop close held HTTP/WS connections. There are bounded
grants, pending proof reads, connections, WebSocket payloads/buffers and request/header limits.
HTTP streams use pipe backpressure; WS sends pause the source until delivery completes. Redirects
are rewritten only within the approved upstream origin. WebSocket redirects are refused.

Remaining before enablement:

- Real local process/socket proof using existing ownership discovery, including dispatch-time
  socket identity, active-connection lifecycle invalidation and management-target exclusions.
- Approved-record owner RPCs, classification, capability negotiation, browser selection/stop UI,
  disconnect cleanup and isolated virtual-host HTTP/WS routing.
- Public-suffix-aware deployment validation and real DNS/TLS/reverse-proxy acceptance.
- SSH adapter retaining the existing transport identity and remote process proof; no new SSH
  implementation or raw arbitrary forwarding API is introduced here.

Tests run real local HTTP and WebSocket listeners through the transport. The authority is a
fixture: process replacement, owner departure and expiry assertions test registry decisions,
not real process attribution. These tests do not establish full gateway acceptance.
