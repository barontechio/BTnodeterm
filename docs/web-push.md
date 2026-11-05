# Browser notifications with the page closed

Server Edition can send generic **finished turn** and **needs response** notifications through the
browser's standard Web Push provider. No nodeterm account, mobile app or private push backend is
involved. This is separate from open-page notifications and paired-phone push.

In Settings → Notifications, select a local project on this server and click **Enable browser push**.
Allow this site's notifications when the browser asks. The selected project's local agent terminals
are covered even when its tab, every browser page, or the project tab is closed. The host process
must stay running and receive the agent's real status hooks. Enable is always an explicit click;
reading settings and incoming events never ask permission. A browser subscription covers one project;
enabling again replaces that subscription's scope. Select a local project before managing it.

Click a notification to focus an existing app page or open one. The server validates its saved
project, unique node placement, current CLI session, consent and authenticated owner again before
Canvas uses its ordinary project reopen/focus path. Reloads can wait for project/session hydration.
A deleted/replaced terminal or a revoked/expired login cannot be opened by an old notification.
There is no URL credential and clicking never types into a terminal or approves an agent request.

**Disable browser push** revokes host consent before removing the browser subscription. Signing out,
signing out everywhere, or the underlying login expiring also stops future dispatch. Closing a page
or WebSocket does not revoke consent. Consent lasts at most 30 days and never outlives the login;
enable again after signing in or expiration. Removing notification permission in site settings stops
browser delivery too. A provider may already have accepted an in-flight generic alert when you revoke;
a delivered notification grants no access, and its click is revalidated. Clear old notices in the OS
notification center if desired.

Delivery depends on the browser's background services, OS notification permission and power/network
policy. A provider acceptance is not proof that an OS displayed a notification. Force-quitting a
browser or disabling its background operation can prevent delivery. No guarantee of delivery is made.
Desktop Electron and relay/guest projects retain their existing notification behavior. This feature
has no paired-phone/mobile-app protocol or entitlement changes, and does not notify about SSH nodes.

Supported browsers must expose Push API, Service Workers and Notifications in a secure context.
Chromium/Firefox and Safari support varies with OS and settings. On iOS/iPadOS, WebKit documents
Web Push for Home Screen web apps starting with 16.4; ordinary browser tabs do not qualify. This
change does not add a web app manifest/install flow or certify iOS delivery. Use a supported desktop
browser, or an operator-provided properly installed web app, and verify delivery on the actual device.

## Operator setup

Serve the owning Server Edition at a dedicated, stable HTTPS origin through the existing trusted
proxy setup (`docs/SERVER.md`). Keep the server's data directory private and single-process owned.
Do not share the app origin with untrusted web applications or active previews.

Set these environment values on the **server process**:

```text
NODETERM_PUBLIC_ORIGIN=https://term.example.com
NODETERM_WEB_PUSH_SUBJECT=mailto:operator@example.com
NODETERM_WEB_PUSH_PROVIDERS=https://fcm.googleapis.com,https://updates.push.services.mozilla.com
```

The subject must be a valid `mailto:` or `https:` VAPID contact. The example providers are examples,
not automatic defaults. Approve only exact HTTPS origins of push services required by your browsers:
no paths, trailing slash, custom ports, IP literals, credentials or wildcards. To diagnose an unapproved
provider, inspect only `new URL(subscription.endpoint).origin` in a disposable browser; full endpoints
and subscription keys are private capabilities and must not be shared in logs/issues. Safari may
require a different provider origin. Permit outbound DNS/TLS to those providers in your firewall.
Never approve a host management endpoint as a push provider. All DNS answers must be public unicast;
requests pin a checked address while keeping TLS hostname verification. Private, mixed, translated,
reserved or loopback answers fail. No redirects, HTTP proxy environment or automatic request retries.

With missing/invalid configuration, inaccessible/corrupt/private-mode-invalid storage, or proxy-only
SSO without a password cookie, the UI reports unavailable/refused. It does not fabricate a successful
subscription. `NODETERM_HEADLESS=1` has no browser plane and does not initialize this service.

On first configured startup the host generates a P-256 VAPID key pair and saves it with grants in
`<dataDir>/web-push.json`, using mode 0600, unique atomic temps, file and parent-directory sync. Keep
this file in private backups. It contains private keys and subscription capabilities; never commit it.
No private VAPID key is sent to a browser. Restore the whole private store with the matching auth
sessions. Deleting/replacing/rotating its keys requires browser re-enrollment. Configuration/store
failure does not overwrite existing keys. Storage acknowledgement uncertainty disables this service
until a clean restart; no unknown send is repeated. Other app features remain available.

A grant is bound to the SHA-256 identity of the real cookie session (the bearer token is not stored
here), its browser endpoint/key pair, and one validated project. Relay peers, guests, agent RPCs and
proxy headers cannot administer it. Routes live under `/auth/web-push/`; changing operations require
an exact configured Origin, JSON POST, valid cookie, bounded input and current response lifetime.
Status and resolve reveal only the authenticated session's own subscription/receipt.

## Runtime contract and limits

`core/web-push.ts` subscribes through the Server adapter to the mirror's existing
`onInboxActionable` seam, after normalization, question classification and event deduplication. It
never reinterprets raw hook strings, replays a saved inbox, or depends on a live renderer. It checks
unresolved-event identity, exact current CLI session and globally unique local terminal placement
before and after asynchronous work. Interrupted/resolved/stale edges are skipped.

The encrypted RFC 8291 `aes128gcm` payload contains only version, random receipt id and kind. No
project/node/session id, title, transcript, path, pending-approval token or cookie travels in it.
`web-push` 3.6.7 creates encryption and RFC 8292 VAPID headers; our transport sends the generated
request with public-DNS pinning, fresh sockets, 3-second DNS and 10-second HTTP budgets, a 4 KiB
response cap and no redirects. Its stock `sendNotification` is not used because it accumulates
provider response bodies without a bound. Provider errors are deliberately not logged with secrets.

Limits: 32 subscriptions per host, 8 per login, 32 outstanding event jobs, 64 store mutations,
4 network sends, 1 KiB payload, 4 KiB HTTP input, 2 KiB endpoint. Events older than 2 minutes are
refused; provider TTL is 60 seconds. At most 1024 attempt/click receipts are kept for 24 hours;
capacity exhaustion drops new sends rather than evicting fresh dedup receipts. Each grant/event
attempt is durably reserved **before** dispatch. Timeouts, errors and ambiguous responses are not
retried. 404/410 removes only the exact subscription revision that sent, preserving a replacement.
Explicit disable/logout aborts only affected grant revisions on a best-effort basis. This is bounded,
best-effort notification, not a transactional delivery queue or audit of OS receipt.

The worker has only `push` and `notificationclick` handlers. It installs no fetch interception,
cache, offline shell, background sync or subscription renewal. Receipt fragments are untrusted
locators, authenticated against the current cookie and live host target; they are not authority.

## Verification and references

Focused service, auth/HTTP, endpoint/transport, click and existing-notification regression tests are
in `src/{core,server,renderer/bridge}/web-push*.test.ts`. The service/HTTP tests process a real
normalized host event without a page or WS. The transport fixtures check generated encrypted request bytes, pinned lookup and the real Node
socket lookup contract against a private loopback provider, including mixed DNS, redirects and
owner loss. The private provider decrypts the standard payload; its HTTP socket adapter is a test
fixture and does not alter production HTTPS/TLS enforcement.

`node scripts/web-push/browser-proof.cjs /absolute/evidence/directory` uses a **disposable** Chromium
profile and the unmodified production worker. It registers a real Service Worker, closes every app
page, dispatches a synthetic PushEvent through CDP, and observes a real persistent notification.
Permission is granted by CDP. This does **not** prove browser subscription, delivery from FCM/APNs/
Mozilla, background OS execution after browser exit, or a physical notification-center click. No
production credentials or user browser profile are used. Real provider/device acceptance remains
an operator check with their own consent and configuration.

Primary references consulted 2026-11-05:

- [W3C Push API](https://www.w3.org/TR/push-api/): subscriptions, permission and visible messages.
- [W3C Service Workers](https://www.w3.org/TR/service-workers/): worker lifetime without a document.
- [RFC 8291](https://www.rfc-editor.org/info/rfc8291/): encrypted Web Push content.
- [RFC 8292](https://www.rfc-editor.org/info/rfc8292/): VAPID application-server identity.
- [web-push source and API](https://github.com/web-push-libs/web-push): request generation and sender.
- [WebKit Home Screen Web Push](https://webkit.org/blog/13878/): iOS/iPadOS requirements and limits.
