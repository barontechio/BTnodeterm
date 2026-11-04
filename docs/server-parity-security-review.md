# Server parity security review

## Worktree C staging candidate (2026-11-04)

This candidate composes reviewed manual shell recovery on base `6b2607a4`, without changing
native authenticated SSH readiness, notifications, joined/offline administration isolation,
relay transfer exclusion, license gates or development-preview restrictions. Source commits
`de92a023`, `ec4378cd`, `b21c67c1`, `29567d21`, `741a1558` map respectively to `a1d26ce9`,
`a12df86b`, `ca21d3bd`, `806c3d0a`, `0d4c0ba6`. Cherry-picks had no conflicts; the already
integrated readonly tmux descriptor prerequisite was not duplicated.

Explicit owner confirmation can resume a recovered plain Linux shell or verified single-pane local
tmux shell. The real backend performs atomic new-only creation (no attach-on-exists), then proves
actual process birth and, for tmux, server/session/pane and attached-client identity. The existing
node coordinator, held workspace FIFO and immutable serialized-byte durability receipts bind the
operation. Create/input admission belongs only to the exact captured live Session; neither a journal
label, browser field nor copied permit grants execution. Journal v5 retains manual-start quarantine
and observed history, including after owner departure or lost acknowledgement. Held commands, cold
starts and uncertain effects are never replayed. Known live effects require fresh exact reconciliation.

Original host global settings and actual project settings/local overlay/target/trust sources stay
bound through preparation, physical dispatch and final admission after every await and the actual
physical-current probe. Changed sources retain observed facts and refuse new admission; later
settings changes do not revoke an already admitted Session. Public errors expose stable categories,
not private process arguments, nonces, environment values or profile fingerprints. Agent/account
recovery, remote and unsupported backends, coordinated removal and account/restart remain separate
D/E work. This is not an OS-wide filesystem/process lock or production activation.

Both independent real-owner profile reproductions are closed: 38 focused cases passed with ordinary
default deadlines on production `29567d21`. The exact test-only `741a1558` follow-up passed all 12
backend cases independently, preserving original assertions and committed limits (5-second tests,
10-second hooks, with the existing two happy paths at 20 seconds). The author four-file parallel run
still had 38 passes and eight timeouts; older tmux refusal/timeout causes remain unclassified.
An observed fixture directory crossover is not proof of the historical refusal's cause. Extended
60-second diagnostic runs are not acceptance evidence. The staged product `0d4c0ba6` (documentation snapshot `e1f4f0f5`) passes 192 composition cases in
20 files at default deadlines with `--maxWorkers=4`, node/web typecheck and sequential Desktop/Server
builds. This includes real backend/profile recovery, owner WS/IPC, journal/coordinator, notification,
offline/relay and SSH namespace isolation. Core recovery/profile/PTY/trust/workspace source bytes
match reviewed `741a1558`; this subsequent documentation update does not change product bytes.
New integrated CI and coordinator acceptance remain required before release; component and focused
composition evidence do not establish a full aggregate gate.

Base `6b2607a4` Windows and CodeQL results were reported successful by the coordinator; Linux was
pending at this handoff. The accepted `1603bb51` base's 25,030 passes and 82 skips below remain
historical evidence. No fresh security scan or zero-alert claim is made for this C candidate.

## Native/notification candidate and dedicated base CI (2026-11-04)

Dedicated base `1603bb51` passes Linux default tests (25,030 passed, 82 skipped), types, both
builds, the Windows relevant subset and Dependency review. CodeQL analysis
[126850140247](https://github.com/barontechio/BTnodeterm/runs/126850140247) AND result gate
[126853989743](https://github.com/barontechio/BTnodeterm/runs/126853989743) succeed on security run
[41908689323](https://github.com/barontechio/BTnodeterm/actions/runs/41908689323). Success is not a
zero-alert claim: two warnings remain, with these reviewed data flows:

- `core/agent-env-ipc.ts:80`: file-backed gateway credentials intentionally authenticate discovery
  against the configured gateway. `redirect: 'error'` prevents following a credential-bearing
  redirect; real 302/307 negative cases retain the configured authority and make no request to the
  redirect destination. This remains a reported authentication-flow warning, not suppressed debt.
- `server/worktree-recovery.e2e.test.ts:115`: generic owner RPC serializes file-derived synthetic
  fixture metadata to its explicitly created `ws://127.0.0.1:<server.port>` WebSocket. The fixture
  uses its own temporary data directory, `Auth` session and loopback-bound server, not real user
  files, an external destination or a redirect. This reviewed fixture flow remains an annotation;
  no query, severity, threshold or test assertion was weakened to remove it.

The six moderate Minimatch packaging-chain audit entries remain unchanged debt. No new audit or
zero-warning conclusion is asserted. Historical failed local runs below remain recorded: the
original empty-reader cause is still unproved despite the dedicated base CI passing its four SSH
protocol cases and real transfer fixtures.

The new composition adds accepted native `28a5fb38` (integration `2b280d2a`, exact tree equality
before the next changes) and notifications `87b72f19`/`67825b4f`/`d2ab0fd8` (integrations
`b3350e60`/`d1fc5d80`/`196b6360`). Native readiness requires alive plus authenticated on the
captured connection; it is not a demonstrated auth escape or an asserted reader-causality fix.
Browser notifications are bounded open-page effects, tied to actual API/project/session and fresh
unique placement; real user activation plus explicit force gates permission, and actual Flow
landing gates focus. The initial navigation P2 is fixed with independent 159+11 checks and types.
Early transport close, disposal, stale/rebound/offline source refusal, native Desktop behavior and
joined/offline administration/transfer isolation are preserved. No new permission, role or license
bypass is introduced. The merged product composition `196b6360` passes 208 focused checks, node/web
types and sequential Desktop/Server builds. New merged quality/security CI is still required; base
success is not inherited.

That native/notification-only snapshot did not include Worktree C; the newer C candidate is described above.
D/E, external worker isolation, private mobile/backend behavior and production activation remain
pending. No Service Worker/Web Push/closed-page notification claim. Legacy ungroup `17bf6ade` is
code-accepted but not activated; canonical ungroup already uses shared geometry.

## Transfer composition history before dedicated base CI (2026-11-04)

Reviewed transfer sources `922e0755`, `526b05f3`, `ee6702c4`, `81b9bfd6` are integrated as
`7f2f4063`, `9f7b1de4`, `41a17ed1`, `e7ad991f`. Component review supports integration, not release
or a passing merged aggregate. The browser join/offline boundary retains an inert administration
base; remote transfers are explicitly absent on relay APIs, while actual owner HTTP redemption
requires the captured cookie principal and live owner/source identity. The merged 17-file regression
run passes 252 cases, including this boundary, guest/role policies,
license checks and real transfer protocols, and times out one existing anonymous-upload rename
case at five seconds. That failure remains recorded without a timeout change. Merged types and
both Desktop/Server builds pass; dedicated CI and final candidate acceptance remain separate.

The original review found renewable references after observed invalidity and a mismatch between
an absolute pathname claim and descriptor publication. Invalidity now latches permanently, including
missing/malformed read proofs and helper failure followed by late caller cancellation. The original
late-cancel reproduction retains its assertions/schedule; independent follow-up passes four
adversarial controls and 16 focused tests. Ordinary valid-media cancellation remains renewable.

The approved upload contract is explicitly narrower than atomic pathname immutability: final
authority targets the opened, checked directory/ancestor inode chain. Before-last-check invalidity
means no publication. A rename after that check can publish into the original moved folder; a
failed post-check reports UNKNOWN, never writes into the replacement, replays the body or unlinks
an unproved pathname. UI uncertainty text states that moved-folder possibility. Original external
race evidence remains valid under this stated contract. Uploads are create-only and require Linux
O_TMPFILE, xattrs, procfs, hardlinks and fsync; no general overwrite or all-filesystem guarantee.
Bounded references/streams, cookie/owner/source checks and physical transport cleanup remain
separate obligations. Real tests use a private ssh2 peer, not production or an actual sshd server.

`8ea31d98` types and both builds pass, but its full run has one empty-transcript SSH assertion
failure (24,959 passed, 109 skipped). Its cause remains open. The sole test-instrumented diagnostic
run `f2ddf7b6` was aborted by the coordinator's ten-minute limit with actual exit 130 after multiple
timeouts and a worker termination timeout; no final aggregate counts or causal fix are claimed.
Observed load 151 on 32 CPUs is context, not proof of the earlier failure's cause. Dedicated fresh
CI and coordinator review remain necessary for the merged candidate; production is not activated.

At that earlier snapshot, remote `4c3c9c67` quality/security runs passed with one medium gateway authentication-flow
warning. The six moderate minimatch packaging-chain audit entries below remain debt. No new scan,
zero-alert conclusion or remediation of native pre-auth readiness is claimed here. The separate legacy Server v1 ungroup correction `17bf6ade` is now accepted in code after 158
focused and nine independent checks, typecheck and the Server build; its original report and four
predecessor failures remain evidence. The duplicate-ID gap is fixed, but installation/activation
is pending. It is not imported here: canonical ungroup already uses shared geometry. Worktree C
and notifications were then in progress; current component status is recorded above. External
worker/mobile verification remains pending.

## Confirmed follow-up result and gateway redirect guard

Frozen `f6532fd9`, including the redirect guard and corrected fixtures, passes 24,911 tests
(109 skipped), typecheck and both production builds. Actual known-host contents remain unchanged.
The next documentation-only pushed head still requires its own remote quality/security checks.

CodeQL result [126793739074](https://github.com/barontechio/BTnodeterm/runs/126793739074) on
`c3cacbf7` succeeds: the five preceding annotations are absent. Windows quality and dependency
review also succeed. This result retains one medium warning in `core/agent-env-ipc.ts` for a stored
gateway key flowing to model discovery. That flow is intentional authentication, bounded by the
persisted gateway URL for host secret/environment references; caller-provided literal keys retain
their explicit pre-save test path. It is not arbitrary file-content transmission.

Review nevertheless identified an additional redirect concern: Fetch can retain the compatibility
`x-bf-vk` header across origins. `43e22f35` now refuses redirects in discovery, matching the other
host credential protocols. Two real loopback authorities reproduce an unwanted second request on
the predecessor for both HTTP 302 and 307; corrected code authenticates only to the configured
gateway and the redirect destination receives no request. All 65 focused gateway/credential/context
checks and typecheck pass. No query or threshold is weakened, and no report is dismissed here.

The new aggregate remains pending. Its prior `d07c2f57` run passes 24,906 tests and fails three
remote screen-dialog assertions because that fixture omitted the required context namespace;
`02090566` supplies it without changing assertions. The 12 real preview/SSH protocol cases pass
after `d07c2f57` supplies the same fixture arguments on physical process respawn. Actual known-host
contents remain unchanged. Fresh full/CI verification covers these final changes; the six moderate
minimatch packaging-chain audit entries below remain unresolved.

## Follow-up scan and current corrections (2026-11-04)

The result gate [126780177650](https://github.com/barontechio/BTnodeterm/runs/126780177650) on
`94baab42` reports three high and two medium findings. Its Linux quality and dependency review pass;
successful CodeQL analysis still does not mean the result gate passed. Previous shell/cookie
annotations are absent. The five remaining annotations are being addressed without suppression:

- Two high reports point to `core/transcript-index.ts`: pathname stat followed by separate open or
  unbounded read can use a replaced/grown file. Candidate `3de4de23`, composed as `ff3b7399`, opens
  before fstat, validates a regular file and reads at most 5 MiB through that descriptor, retaining
  short-read byte counts and closing on every path. Author evidence is 205 focused checks, typecheck
  and both builds; eight predecessor failures distinguish its bounds/error/nonregular behavior.
  Independent review and a fresh CodeQL result remain required. Parent symlinks are not a newly
  established containment boundary, and Windows has no equivalent no-follow guarantee here.
- One high report remains in the atomic-file fixture's second pathname open. `7f6e7859` reads bytes
  from the retained original descriptor and verifies the current named inode afterward, preserving
  the unchanged-file assertion without a later path open.
- Two medium reports point to generated JavaScript in preview process fixtures. `7f6e7859` writes
  fixed fixture programs and supplies values through actual process arguments (the test dependency
  path uses an explicit fixture environment variable). Exact empty argv cases remain covered.

Windows quality also found a newly added test requiring successful directory fsync where the
platform returns `EPERM`. `7f6e7859` keeps that real-flush expiry schedule POSIX-specific and adds
an all-platform unsupported-flush refusal/handle-cleanup test. Production still refuses publication
without its durability acknowledgement; no Windows durability support is inferred from a mock.
Merged typecheck and filesystem-focused tests pass; actual gateway OS rechecks encountered local
PTY exhaustion, so fresh Linux/Windows CI is still required for this composition.

A fresh `npm audit --package-lock-only` now reports six moderate entries, zero high/critical.
All six derive from one [minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
updated November 4. It affects the Desktop packaging dependency chain (`minimatch`,
`@electron/universal`, `app-builder-lib`, `dmg-builder`, `electron-builder` and its Squirrel adapter).
The advisory lists 11.0.1 as fixed. Installed packaging consumers require minimatch 9/10, and current
electron-builder 26.18.0 still has those ranges. No forced major override or downgrade to builder
24 has been applied without compatibility evidence. Earlier patch-only zero-audit results below
are historical. The default branch's 27 alerts concern its older lockfile; this branch retains
DOMPurify 3.4.17, Sharp 0.35.5, Vite 7.3.7, fast-uri 3.1.9 and undici 6.29.1/7.30.1/8.12.3.

## Previous scan: four fixture findings (2026-11-04)

CodeQL result check [126744604453](https://github.com/barontechio/BTnodeterm/runs/126744604453)
on `4df5b36c` failed with one high and three medium findings. Linux/Windows quality, dependency
review and the CodeQL analysis job itself succeeded; successful analysis is not a passing result
gate. All four annotations point to test fixtures, and do not establish a production-service defect.

| Severity | Fixture | Report and correction in `624223bf` |
| --- | --- | --- |
| High | `src/core/fs-atomic.test.ts` | Potential path-check/read race. Retain an original file handle and compare the post-operation handle's bytes and inode, preserving the same-file/no-rewrite assertion. |
| Medium | `src/core/agents/hook-endpoint-file-sh.test.ts` | Environment-derived shell source path. Pass the real generated writer file as inherited descriptor 3 and use a fixed shell source command; the actual spaced-path quoting assertion remains and the descriptor closes in `finally`. |
| Medium | `src/server/development-preview.test.ts` | Missing `HttpOnly` on a decoy upstream cookie. Add the flag; the gateway must still strip the cookie entirely. |
| Medium | `src/server/development-preview.test.ts` | Missing `Secure` on the same decoy cookie. Add `Secure` and `SameSite=Strict`, retaining the credential-filtering assertion. |

The corrected fixtures pass 79 focused checks and typecheck. A fresh remote CodeQL result is still
required; no query, threshold or alert was suppressed/dismissed for these four reports. Earlier
dependency-audit and individual-alert decisions below describe their specific snapshots, not a
zero-alert claim about the current default branch.

## Earlier reviewed findings and dependency patch

Reviewed against fork integration PR #2, CodeQL check 123838127390 (2026-10-30).

The preview-source report (`js/file-system-race`, alert 1) pointed to a path stat/access before
open in `HeadlessNodeFactory.showFile`. Validation now opens once with nonblocking/no-follow flags,
checks that descriptor and its current named identity, and reads media signatures through the same
handle. The handle closes on every result. Real filesystem tests replace the name after open and
verify refusal, no saved node and a closed descriptor; final symbolic links are also refused.
The subsequent CodeQL check 123843811349 passed without the high-severity finding; the source
fix was verified by analysis rather than dismissing that report.

Six `js/file-access-to-http` reports describe intended protocol data flows. Each reads this
installation’s fixed-name identity/license store and sends explicitly selected protocol fields to a
configured authority. No caller supplies a filesystem path or network route to these helpers.
The device identifier is an anonymous installation id; an entitlement or license key is deliberately
the credential those APIs require. This differs from an arbitrary file-content upload. The individual
reports are reviewed as false positives for unintended disclosure, with the reason recorded on each.

| Alert | Source / request | Reviewed intent |
| --- | --- | --- |
| 2 | `core/license.ts`, license POST helper | Manual/stored key or signed entitlement to fixed license API routes |
| 3 | `core/license.ts`, status GET | Installation device id to its device-bound entitlement status route |
| 4 | `core/license.ts`, detail/release POST | Stored entitlement authorizes this installation’s license administration |
| 5 | `main/pairing-service.ts`, relay device mint | Host device id and entitlement/public pairing fields to the pairing authority |
| 6 | `main/remote/host-service.ts`, pairing token mint | Entitlement proof required to mint the owner’s pairing offer |
| 7 | `main/remote/standing-host.ts`, host token mint | Device identity, entitlement and possession proof to the relay authority |

These requests now refuse redirects so keys and proofs cannot be forwarded to a redirect target.
A two-authority HTTP fixture covers real 307 responses for activation and entitlement detail,
proving the second destination receives no request. Existing signature, device binding, expiry,
clock anchor, consent and host-only authorization checks remain enabled. No CodeQL query, severity
threshold, dependency review or paid entitlement gate is disabled.

The fork’s dependency review initially could not run because its dependency graph was disabled.
Enabled dependency/vulnerability analysis using the documented repository administration API;
the rerun passed. GitHub documents that this endpoint enables both alerts and the graph:
https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts

Upstream workflow execution still requires its maintainer’s authorization of fork PR runs.

Dependency patches were then isolated in a separate checkout and installed with lifecycle scripts
skipped. The existing source patches and Node (not Electron) node-pty rebuild were applied before
running the full suite. Only patch releases changed: DOMPurify 3.4.17, Sharp 0.35.5/libvips 1.3.4,
Vite 7.3.7, fast-uri 3.1.9 and undici 6.29.1/7.30.1/8.12.3 in their existing major lines. Both the
application floor and Monaco DOMPurify override were updated. The resulting lock audits with zero
reported vulnerabilities and passes 24,418 tests (109 skipped), typecheck and both builds on Linux.

The relevant runtime disclosures include [DOMPurify](https://github.com/advisories/GHSA-cg2g-xh64-v4q7)
and [Sharp/libvips](https://github.com/advisories/GHSA-wq5f-xc86-pv6w); the Vite patch covers its
[launch-editor advisory](https://github.com/advisories/GHSA-587h-7wmj-h5pm). No major dependency
migration or native ABI/toolchain upgrade is part of this patch.

The title-read snapshot's CodeQL check 123870469990 reports new fingerprints for the same fixed
license/pairing protocol flows (alerts 8–11); these were individually reviewed with the redirect
protections above retained. Alert 42 is a loopback test sending its newly minted temporary node
capability to its own in-process hook server, with no external authority or real secret. Each has
an individual false-positive rationale. Alert 28 observes the fixture's empty parent directory
before commit and compares inode identities after commit, deliberately testing the rename
transaction in its own temporary tree. No stat result authorizes a later production file read or
write. Check 123897989014 still identifies that intentional test observation; it was reviewed
individually as a false positive, preserving the atomic-move assertion. No query or check is disabled.
