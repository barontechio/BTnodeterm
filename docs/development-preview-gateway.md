# Optional local development preview gateway

Server Edition can expose an explicitly approved local development service through an isolated
HTTPS origin. The default installation does not construct its authority, transport or timer,
and never scans processes or creates SSH forwards for this feature. Static HTML previews remain
a separate, script-disabled surface.

## Supported first slice

The adapter requires Linux `/proc`, the existing tmux ownership discovery and an IPv4 loopback
or wildcard listener. The operator approves exact project/node/port/argv records. The owning
browser selects an opaque discovered record through the terminal's **Preview** button, then
**Allow preview** and **Open preview**. **Stop** revokes it and closes existing HTTP/WS connections.
Closing/unmounting the owning node view also releases its known grants. Grants and records expire
within five minutes; a lost open reply is never automatically retried.

This is an active preview with scripts and forms. Each grant uses a fresh random hostname and an
opaque-origin response sandbox. Cookies, localStorage, IndexedDB and service workers are
unavailable. Apps requiring those features, workers or custom CORS request headers are unsupported
in this slice. Module loads and HTTP/WS HMR with relative gateway URLs are supported. Absolute
localhost URLs in an application's generated content may need its development-server configuration
adjusted; the gateway does not rewrite arbitrary source code or silently reach viewer localhost.
The CSP is not a claim that a script cannot navigate to another site.

## Operator configuration

Set all three variables before starting an intentionally configured Server instance:

```sh
NODETERM_PUBLIC_ORIGIN=https://term.example.com
NODETERM_DEV_PREVIEW_ORIGIN=https://preview.example.net
NODETERM_DEV_PREVIEW_TARGETS='[{"projectId":"project-id","nodeId":"terminal-id","port":5173,"argv":["node","/srv/project/node_modules/vite/bin/vite.js","--port","5173"]}]'
```

`argv` must exactly match the running process's NUL-separated `/proc/PID/cmdline`. Do not put
secrets in it. Approve only intended HTTP development applications, never administrative services.
The configuration is host-private and is not an RPC argument or workspace setting. The policy
rejects privileged/ephemeral ports, standard debugger/container-management ports, known browser/
debug/management commands, the app port and the live hook-server port. The destination is always
host loopback, never a URL, hostname or port supplied by a browser request. No configuration
implicitly grants a relay guest the owner's preview API.

Deployment needs wildcard DNS and TLS for `*.preview.example.net`, and a reverse proxy preserving
the original Host and WebSocket upgrades to the same Server listener. The preview base hostname
and all its subdomains are reserved: unknown/expired grants cannot fall through to application,
auth or management routes, even for `/ws` or `/login`. Do not log or share grant hostnames: each
is a short-lived bearer capability. Proxy access logs must redact them.

The application and preview base must have different registrable domains according to the
public suffix list, including private suffixes (`tldts`). IP literals, unknown suffixes,
parent/child and sibling domains sharing a registrable domain are refused. Fresh grant names
are checked after URL assignment and can never replace an existing grant key. A wildcard domain
alone would still allow sibling Domain cookies; the opaque sandbox additionally removes cookie
and storage access between previews. Both checks are required.

## Identity and lifetime

`core/dev-ports.ts` retains its public report unchanged and offers a host-private evidence observer.
The authority uses its existing session/process association, then checks the process and pane
birth stamps, ancestor chain, listening inode and exact argv. A second discovery and proof close
the initial PID-reuse window. A host-local live-session identity and saved unique project/node
membership are checked throughout. SSH/unavailable/nonterminal nodes are refused.

Before forwarding any application bytes, the transport establishes TCP and checks the reverse
ESTABLISHED tuple against the approved process's FD table and birth identity. Ambiguous listeners,
reassigned sockets, process replacement, cross-project records and stale execution generations
fail closed. The connection proof is repeated for HTTP and WebSocket handshakes. Synchronous owner/project/
generation checks also guard dispatch and every WebSocket message after asynchronous proof. Established
sessions are revalidated approximately once per second; revocation/owner departure, expiry and
shutdown close their tracked sockets immediately. Already transmitted bytes cannot be retracted.
A service that transfers accepted sockets to a different worker process is refused in this slice.

Request headers use an allowlist: app authentication, Cookie, Authorization, Referer and
management/debug/proxy headers never reach upstream. Host/Origin are host-derived. Set-Cookie and
upstream policy headers are not returned. Opaque-origin module/fetch requests receive narrowly
configured `Access-Control-Allow-Origin: null`; no credential support is enabled. Only same-target
HTTP redirects are rewritten to the grant origin; WebSocket redirects are refused.

Grants, records, discovery/proof admission, connections, headers, process/FD reads and WS
payloads/buffers are bounded. HTTP uses streaming backpressure; WS delivery pauses the source
until each send finishes. No raw network tunnel, debugger or generic callback RPC is exposed.

## Limits and validation

The repository tests use real Linux tmux/process/listener/socket ownership, actual HTTP and WS
traffic through the Server HTTP/upgrade routers, generation invalidation and a real process
replacement. The live-generation getter in that fixture is injected; socket/process identity,
workspace persistence, owner RPC registration and HTTP/upgrade routing are real. Policy tests cover separate sites, owner-only RPCs and disabled mode. Renderer tests
cover opaque record selection, stop, late grants and absence of a localhost fallback. Other
transport tests use an explicit fixture authority; those do not establish process attribution.

This checkout has not exercised public wildcard DNS/TLS, a deployed reverse proxy or a physical
browser's CSP/storage behavior. Those are deployment acceptance requirements, not claimed test
results. No production service was deployed or restarted.

SSH previews remain unsupported. A future adapter must retain the existing SSH transport identity,
prove remote process birth/listener/accepted-socket ownership and close forwards on revocation.
Current same-port forwarding alone is insufficient. Windows, macOS, IPv6-only services,
non-tmux sessions and an optional controlled-browser worker remain separate follow-up adapters.
