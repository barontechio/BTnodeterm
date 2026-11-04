# Server capability parity implementation plan

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
60-second diagnostic runs are not acceptance evidence. New candidate composition checks and
integrated CI are required; component review does not establish an aggregate release gate.

Base `6b2607a4` Windows and CodeQL results were reported successful by the coordinator; Linux was
pending at this handoff. The accepted `1603bb51` base's 25,030 passes and 82 skips below remain
historical evidence. No fresh security scan or zero-alert claim is made for this C candidate.

Extend Server Edition with useful Desktop automation and browser equivalents while keeping one shared service implementation. Deliver the work as independently reviewable changes suitable for `eneskirca/nodeterm`; Desktop must benefit from each extraction and keep its existing behavior.

This is an implementation proposal. Work proceeds by the acceptance gates below, rather than by enabling every currently stubbed API. Server automation must work without an open browser tab. Interactive actions may require an authenticated owner, and native features retain their platform-specific implementations.

## Native readiness and browser notifications composition (2026-11-04)

Base `1603bb51` passed dedicated CI at default settings: Linux 25,030 tests (82 skipped;
1,789 files passed, eight skipped; 460.51 seconds), types and Desktop/Server builds. The Windows
relevant subset, Dependency review, CodeQL analysis and CodeQL result gate also passed.
[Linux evidence](https://github.com/barontechio/BTnodeterm/actions/runs/41908689784/job/126850141533),
[Windows evidence](https://github.com/barontechio/BTnodeterm/actions/runs/41908689784/job/126850142167)
and [security result](https://github.com/barontechio/BTnodeterm/runs/126853989743) belong to that base,
not to the new composition. All four SSH protocol cases and actual transfer fixtures passed there;
the cause of the earlier local empty-reader result remains unproved.

Accepted native source `28a5fb38` is integrated as `2b280d2a`. Its entire Git tree equals the
reviewed source tree `4e00cd7c4cb8c096d3036771ea4fec4c50bcbb43` before further integration. Native
master checks now require an alive, authenticated captured connection rather than pending registry
presence. This corrects readiness/results, not a demonstrated authentication escape or the earlier
empty-reader cause. Author 61 focused checks/types/Server build and independent 37 focused plus
two adversarial checks support the component.

Accepted notification sources `87b72f19`, `67825b4f`, `d2ab0fd8` are integrated as `b3350e60`,
`d1fc5d80`, `196b6360`. Browser open-page notifications require explicit force plus real user
activation to request permission. Clicks retain exact API/project/workspace-session and known CLI
session identity, fresh unique placement and actual React Flow landing. Disposal, early carrier
close, offline/rebound sources and stale membership refuse; a pending click is consumed once.
Native Desktop notification behavior, owner-only SSH/meter/principal APIs and the inert joined/
offline administration boundary remain intact; relay APIs still expose no remote transfer API.
The initial review's Flow-landing P2 is preserved and corrected. Final independent validation is
159 focused checks, 11 adversarial cases and types; author Desktop/Server builds pass. Earlier
independent real Chromium evidence covers the unchanged DOM adapter with a trusted input gesture,
CDP permission grant and a synthetic click on a native Notification, not physical OS-center delivery.

Integration conflicts were additive documentation appendices and the WS bridge import list; both
remote meters and notification imports were retained. No native or notification behavior was
rewritten during composition. The merged product
composition `196b6360` passes 208 focused checks in 19 files, node/web typecheck and sequential
Desktop/Server builds; this documentation-only update does not change those product bytes. A fresh
merged CI gate and coordinator review remain required before release.
No local full run is repeated under the loaded host, no timeout is increased, and no standalone
legacy ungroup factory is imported into this shared-geometry implementation.

At the native/notification-only snapshot, Worktree C was not integrated. The newer C candidate is
described above; D/E remain pending. Development-worker runtime isolation, private mobile/backend behavior and
production activation remain external limits. Notifications do not provide Service Worker,
Web Push or closed-page delivery. Standalone ungroup `17bf6ade` is code-accepted but not installed.

## Earlier local snapshots and transfer composition (2026-11-04)

Before dedicated CI on `1603bb51`, the accepted local aggregate was `f6532fd9`: 24,911 tests (109 skipped), typecheck and
Desktop/Server builds. The subsequent `8ea31d98` composition includes independently reviewed
recovered-checkout rebinding (integration `a727ad39`, `173887a6`, `7fb89952`)
and browser team joining (integration `a855ef46`, `994972d0`, `31d754cd`,
`8ea31d98`). Its types and both builds pass, but its full run has 24,959 passes, one failure and
109 skips: the third SSH protocol case (OpenSSH, already-closed connection) returned a found
transcript with no messages. The cause remains unproved; isolated passing runs do not fix it.

Streaming transfers are now composed as `7f2f4063`, `9f7b1de4`, `41a17ed1`, `e7ad991f`, from reviewed
sources `922e0755`, `526b05f3`, `ee6702c4`, `81b9bfd6`. The merged candidate passes typecheck and
both Desktop/Server builds. Its 17-file focused run passes 252 tests and times out one existing anonymous-upload rename case at five seconds; no timeout
was increased and that failure remains recorded. Fresh quality/security gates and coordinator
acceptance remain required. The last remote head `4c3c9c67` has passing CI;
its one medium gateway warning and six moderate minimatch packaging-chain audit entries are not
claims of zero security debt. No new production activation or upstream proposal is implied.

### SSH streaming transfer contract and evidence

Owner-only preparation binds an opaque, five-minute reference to the actual WebSocket owner,
host-private cookie principal, saved project/root/endpoint/control path/generation and, for node
attachments/media, the saved node/account/session/runtime identity. Relay and browser joined/offline
APIs cannot inherit this capability from the owning Server. Proxy authentication without a stable
cookie principal is unavailable. Observed source/proof invalidation is permanent, including a
caller cancellation arriving after the failed read. Ordinary cancellation alone preserves valid
renewable media. Remote failure never selects the Server's or viewer's local filesystem.

Shared Core carries file bodies over bounded HTTP/SSH streams, not terminal RPC: 128 MiB per file,
120-second operations, 64 global/16 owner references and 8 global/2 owner operations. The common SSH
gate retains custody until physical process/channel closure, including pending native opens and
cancellation. Downloads are single-use; signature-checked raster/audio/video media supports
cookie-authenticated GET/HEAD Range, with 206/416 responses. Directory/archive downloads and SVG/PDF
bulk media are outside this slice; the existing bounded PDF reader remains separate.

Uploads create new files only, with conflict for an existing name. Python 3 opens a no-follow
ancestor/file descriptor chain; Linux uploads require O_TMPFILE, user xattrs, hardlinks, procfs and
file/directory fsync. Unsupported hosts/filesystems refuse explicitly. An anonymous inode receives
the exact body, final authorization marker and durable nonce/size/SHA-256 receipt before no-replace
publication. No named partial file is created. The final grant targets the exact opened, verified
directory/ancestor inodes, not an atomic lock on their pathname. A move observed before the last
check prevents publication. A move after that check may publish the complete file in the moved
original directory; a failed post-check returns UNKNOWN, leaves the replacement untouched and
never triggers body replay or unsafe pathname cleanup. The UI explicitly mentions the original
folder even if moved and asks inspection before retrying. There is no overwrite/CAS guarantee.

Independent review of `ee6702c4` ran 107 focused checks, typecheck, six original adversarial cases
and real helper/namespace schedules, supporting this explicitly revised descriptor contract. It
found one remaining late-cancellation renewal defect. Follow-up `81b9bfd6` passes the unchanged
original reproduction plus three independent cancellation/header controls and 16 focused tests,
including actual OpenSSH/native loopback. No residual defect was demonstrated in that narrow
review. These fixtures use an ssh2 peer, encrypted temporary keys and executable-level private
`-F` configuration with strict pinned host keys; they are not an actual sshd interoperability or
all-platform/filesystem certificate. Native Channel listener warnings remain observations, not a
proved leak or proof of its absence.

A single diagnostic full run of test-only `f2ddf7b6` on `8ea31d98` was stopped at the coordinator's
ten-minute cap with observed exit 130 after unrelated timeouts and a worker termination timeout.
Host load reached 151 on 32 CPUs; this observation does not explain the original empty SSH reader.
No complete aggregate result or causal reader fix is claimed. No repeat full under that load is
part of this milestone; dedicated CI can supply the next full gate after candidate approval.

The standalone Server v1 ungroup correction `17bf6ade` is accepted in code after 158 focused and
nine independent checks, typecheck and the Server build. Its duplicate-ID policy gap is fixed;
installation/activation remains pending. It is a separate minimal legacy upstream backport: this
canonical branch already implements ungroup through shared geometry and does not import it.
At that transfer snapshot, C-phase worktree composition, notifications and native readiness were
pending. Native/notification component acceptance and new composition are recorded above; external
worker deployment, mobile behavior and production activation remain unverified.

The owner has authorized completing the unfinished useful parity work. The current delivery is
split into isolated worktree/session, SSH, and web/collaboration tracks. Shared contracts and
composition-root changes are integrated sequentially; no track writes another track's checkout.
Keep the existing upstream order (#1332, then #1333) and do not reopen the old export batch.
The project-scope safety fix is `bc18e843` on the remote scope branch and must be preserved;
the older local scope branch alone does not contain it. Both upstream proposals remain open.

The acknowledged member-recycle foundation is complete at `42d39167`, integrated as `a4b3e556`.
Its frozen Linux snapshot passes 24,648 tests (109 skipped), typecheck and Desktop/Server builds.
Independent review found no demonstrable defects after 250 existing tests, seven additional
behavioral cases and typecheck. Integration `a4b3e556` has the same `src` tree as that snapshot;
subsequent accepted changes are recorded below.
Backend-specific independent cases use mocks; physical macOS/Windows behavior is not newly claimed.
This foundation adds no deletion command or automatic launch/input.

Additional accepted deliveries are integrated independently:

| Delivery | Reviewed source | Integration | Verified boundary |
| --- | --- | --- | --- |
| Owner Codex history over SSH | `4b0a2790`, `3c3b85c3` | `dcb58484`, `635b3754` | Bounded remote-only rollout discovery; original saved/effective session, account and connection lifetime checks; 90 existing and two independent protocol cases |
| Shared project-scope safety | `b7c7bf5a` | `bb90eade` | Creator and unique placement checks, whole-close validation and current agent run capability; explicit owner plain-terminal run remains supported; 179 independently checked cases |
| Conservative clean Git removal | `3cb69c9d`, `60093574` | `f6f053d2`, `2c7d4210` | Refuses every ignored entry, rechecks Git/checkout identity at dispatch and preserves possible-effect recovery facts; 59 existing and 24 independent real-Git/fault cases; no deletion RPC |
| Disabled preview transport foundation | `be773620`, `de74f022` | `f9e19119`, `53638b0d` | Bounded HTTP/WS grants, revocation and cleanup; invalid DNS bases and grant collisions refused; 22 existing and 17 independent protocol scenarios; no live routing or advertised capability |
| Recorded missing-checkout recovery | `f43e4d52`, `52181464`, `5a95835b`, `306ce3f3` | `23cc23fe`, `a6d093b7`, `9ca4d4db`, `3121bc65` | Owner-approved plain local members; held FIFO repair, file/directory durability and persistent manual-start quarantine; 457 independent checks, including complete folder/app-data/inline recovery and expiry/partial-write faults |
| Remote agent context links | `46b1a20e`, `f85613d3` | `79389a95`, `d1c45507` | Separately verified agent proof, original edge revision and full caller/target identity retained through final HTTP publication; 106 independent checks and differential disclosure regressions |
| SSH protocol fixture isolation | `77094cfd`, `e2cdc90d`, `c878b835` | `00d93d2a`, `599a77d6`, `c878b835` | Real executable-level temporary configuration for both clients, pinned host checks, partial-setup cleanup and primary-error preservation; no production transport policy change |

Frozen integration `94baab42` (source `a92a1d95`) passes 24,822 tests (109 skipped), typecheck and
both production builds on Linux; remote Linux quality and dependency review also pass. Its remote
Windows and CodeQL findings require the separate corrections described below. Previous source
`c878b835` passed 24,769 tests, 73 focused checks, typecheck and both builds. Earlier snapshots `bb90eade`
and `1a2a57a9` passed 24,667 and 24,691 tests respectively, with 109 skipped each.

An earlier SSH fixture did not forward its temporary `-F` configuration at the executable boundary;
HOME alone does not isolate OpenSSH's passwd-derived configuration paths. Corrected fixtures now
pin temporary known-host files for both clients and retain true connection errors. The full
`c878b835` run leaves the actual user's known-host file unchanged. Existing host entries were not
removed. This demonstrated isolation defect does not establish the cause of every earlier sporadic
connect/reconnect timeout. A separate connection-completion change is still under review and is
excluded from this snapshot. Remote context publication's prior revocation defect and recovery's
owner-expiry/cache defects were corrected and independently re-reviewed before integration.

The owner-reported group-title clipping is also corrected in the shared renderer. Reviewed
commits `0154e751`, `363c1245` and `868beaab` are integrated as `a427f1b4`, `891f1113` and
`c9c8a7b2`. A CSS text mirror replaces the fixed 180px input, using actual shaped text while
limiting the capsule to the frame's width after zoom compensation. Narrow worktree controls
retain a single scrollable row and keyboard access. Derived widths are not stored. Independent
Chromium checks cover 504 layout cases, editing and external title updates, drag/color/actions,
and a differential regression proving all four focused arrow keys leave canvas geometry unchanged.
This is renderer verification on Linux, not a claim of a native device run or production deployment.

The following deliveries are composed in the locally validated `94baab42` snapshot. Security
analysis is tracked independently from its passing Linux aggregate:

| Candidate | Reviewed source / integration | Scope and remaining gate |
| --- | --- | --- |
| First-observed missing-checkout recovery | `8d826dff`, `5877712d` / `59c0dc1c`, `7c709e43` | Strict v3 provenance without invented prior inode/deletion facts; original canonical Git metadata retained through consent and dispatch. Independent follow-up: 449 focused/contract checks and 57 artifact executions across documented runs, typecheck; no actionable findings. Manual-start quarantine remains. |
| Opt-in live local development gateway | `2b737942`, `483f2784` / `c7d8ceac`, `1d00d462` | Linux/local tmux/IPv4 and exact operator-approved targets; actual attached tmux/socket/server/session/pane identity, reserved DNS aliases and exact argv. Independent 120 checks, typecheck and actual Chromium modules/fetch/preflight/HMR plus storage/worker refusal. See `development-preview-gateway.md`; deployment, SSH and isolated workers remain separate. |
| Capsule single-line mirror compatibility | `09f955fa` | CR/LF removal matches the HTML text input, preventing newline-dependent capsule height. Actual Chromium newline/Unicode cases and the existing 504-case layout matrix pass; six existing tests, typecheck and both builds pass. |
| Security/test compatibility | `624223bf`, `a92a1d95` | Harden three fixtures without CodeQL suppression; extend seven existing Kanban session mocks for the ports component's project lookup. 79 security-focused and 59 UI/host-focused checks pass; fresh aggregate and security results remain required. |

Frozen candidate `7c709e43` passed 24,776 tests but failed 45 assertions because seven Kanban
session mocks omitted `sessionForProject`, plus one unchanged session-host timeout. The mock-only
correction is `a92a1d95`; all 59 targeted checks, including the unchanged timed-out fixture, pass.
The earlier focused attempt also encountered local PTY exhaustion; availability recovered without
changing system limits or terminating unrelated sessions. Neither failed run is a green aggregate
certificate. The subsequent `94baab42` aggregate passes all 24,822 tests and both builds; actual
known-host contents remain unchanged. Observed-missing recovery and the local gateway are accepted
for isolated next-slice work. Remote security and supported-platform gates remain separate.

New candidates are composed after that frozen aggregate and require a fresh merged gate:

| Candidate | Reviewed source / integration | Evidence and boundary |
| --- | --- | --- |
| SSH connection lifetime and physical disconnect completion | `d417a102`, `49a10890`, `b5accce1`, `4e338a8e`, `c3711cbc` / `eeca50c4`, `0070dab3`, `e7d628ad`, `5e7f430e`, `236c4c46` | Independent 202 focused checks (three skipped), unchanged six-case matrix, five extra queue/close/joiner schedules and typecheck. Both prior P2s reproduced on the predecessor and corrected; cleanup ownership never confers application authority. |
| Owner-lived SSH context meters | `c01c8ba8` / `905d8c88` | Independent 103 checks and typecheck; author 281 focused checks and both builds. Bounded renewable owner demand, original runtime/account/session/endpoint proof, addressed existing context-store observations and immediate cookie-revocation cleanup; no local or quota fallback. |
| Security and Windows fixture corrections | `7f6e7859` | Fixed gateway fixture programs receive values as arguments instead of generated source. The expiry schedule requiring successful directory fsync is POSIX-specific; an all-platform failure test asserts no durable authority publication and handle cleanup on unsupported fsync. No production durability error is swallowed. |
| Descriptor-bounded local transcript index | `3de4de23` / `ff3b7399` | Author 205 focused checks, typecheck and both builds; independent review pending. Open/fstat/read one regular-file descriptor, at most 5 MiB, actual short-read bytes, no-follow/nonblocking where supported and unconditional close. This does not create a new parent-path containment or Windows no-follow guarantee. |

The new composition passes merged typecheck. Local preview OS rechecks later hit PTY exhaustion
again; fresh-runner CI is required rather than changing resource limits, skipping durability or
killing unrelated sessions. A prior merged focused run also returned an empty first OpenSSH chat;
the unchanged protocol rerun passed all four transport cases. Its cause is not established.
Neither partial run establishes an aggregate pass. The new CodeQL result and Windows run must
confirm their corrections. The lock audit now reports six moderate packaging-chain entries from
one minimatch advisory updated on November 4; see the security review, not historical zero-audit text.

Follow-up result: `c3cacbf7` passes the CodeQL result gate and Windows quality; none of the five
preceding findings remain. One medium model-gateway authentication-flow warning was reviewed;
`43e22f35` additionally refuses discovery redirects, with real 302/307 two-authority regressions.
The next local aggregate includes that change plus the screen-dialog context mock correction
`02090566`. The preceding `d07c2f57` run passes 24,906 tests and fails only those three incomplete
mock assertions. Its 12 real preview/SSH cases pass after retaining fixture arguments on respawn.
This is not yet a passing final aggregate, and no default-branch merge or deployment is implied.

| Track | Remaining functional deliveries | Acceptance boundary |
| --- | --- | --- |
| Worktrees and sessions | Verified rebinding, explicit manual resume, supported agent recovery, confirmed clean removal and coordinated restart/account adapters | Real owner approval, durable facts, actual PTY acknowledgement and conditional workspace repair; no replay of uncertain effects |
| SSH | Gate the composed connection/meter candidates; streaming transfers/media and additional readers where suitable parsers exist | Current remote endpoint/account/session/generation throughout IO, no local fallback, bounded resources and real transport fixtures |
| Web and collaboration | Browser team joining, supported notifications and optional isolated worker/control where an actual runtime is available | Approved process/port identity, isolated origins/profiles, existing protocol/role/pin checks and explicit deployment/external dependencies |

Removal must preserve sessions when Git refuses. A real Git fixture confirmed that ordinary
`git worktree remove` can delete ignored files; consent must disclose that loss or refuse those
files, rather than claiming that absence of `--force` preserves them. Recovery must distinguish
missing-before-recording from a previously observed directory; never fabricate an inode. A
reservation transition must stay inside the workspace FIFO and retain its fence through persistence.

The live orchestration host lacks several canvas capabilities, so visible sessions use the
available role launcher and supported grouping operations. Its `verify` verb is unavailable;
independent review uses separate visible reviewer sessions. Agent messaging remains disabled;
coordination uses explicit shared handoff artifacts and authorized linked-context reads. These
runtime limits do not authorize a transport or consent bypass. No Obsidian vault has been assigned,
so repository documentation remains canonical and no vault has been selected implicitly.

## Baseline and upstream delivery

Current integration validation (2026-10-30): the frozen owner kept-checkout recovery snapshot
`936db093` passes 24,639 tests (109 skipped), typecheck, Desktop production build and Server build.
It includes clean Git removal primitives, the backend-start barrier, durable recovery storage,
physical and canvas path admission, current context-link authorization/routing and canvas/store
reservation seams, pending-member quarantine and the complete owner kept-checkout recovery path.
Confirmed directory deletion and missing-checkout recovery remain pending. The preceding pushed
snapshot `5da8a7c2` passed Linux and
Windows quality, Dependency review and CodeQL analysis/gate; this delivery requires fresh CI.

Upstream delivery status was rechecked on 2026-10-30. PRs #1320–#1331 were closed by the fork owner
with the explanation that changes will be resubmitted in planned order, one at a time; their export
branches and local validations remain available. The active upstream proposals are
[Server list #1332](https://github.com/eneskirca/nodeterm/pull/1332) and its dependent
[project control scope #1333](https://github.com/eneskirca/nodeterm/pull/1333). Historical proposal
references and CI statuses below describe their earlier snapshots, not current open or accepted
PRs. Do not reopen or resubmit the old batch while this ordered delivery is in progress.

Implementation status: capability discovery and the explicit Server CI build are committed in
`dfc22a47`, the shared content writer in `2c9c7235`, and workspace-save concurrency in `814ac35b`.
The geometry extraction (`926988b7`) passes the complete suite: 24,207 tests with 109 skipped.
Desktop and Server now share a command planner (`cc4575ba`); Server geometry is connected through
the serialized writer with behavioral coverage for ownership, metadata, concurrency and authority
overlays. Board projection/assignment rules are shared in `8cc2444a`; Server `board` and `assign`
now use those rules and the queued writer (`581704e4`). Image editor data and the fixed Claude alias
are shared in `b9b670b7`; Server supports local image creation and the alias through its existing
launch path (`12ae2baa`). Naming is integrated from the existing `a7ed3062` change as `90e429b3`;
owner transcript search is shared in `52e83d0f`, with account-path identity and shutdown coverage.
Owner board-comment delivery is shared in `6f1ed10f`, and issue reporting uses the same verified,
project-scoped entrance in both shells. Team, review, placement, prompt and project launch-policy
planning are extracted into shared modules; the host execution service is in core. Local
`spawn-team`/`verify` now use that service in both editions, with complete-batch persistence,
verified dependency release and serialized owner recovery. Later delivery items below remain
planned work. Local worktree create/prepare/bind and non-destructive unbind are now connected to
the same core service in both editions; grouped Server opens inherit a verified checkout. Removal
and automatic recovery of missing checkout sessions remain dependent on the owner confirmation
and execution coordination work below. The PR 07 snapshot passed 24,275 tests with one obsolete
shutdown-order source assertion; retaining the expected cleanup order fixes that assertion.
The PR 08 snapshot passes all 24,288 tests (109 skipped) and both builds. Local audio/video
streaming and `show-video` are connected through scoped, expiring owner references and authenticated
HTTP Range responses. The first PR 09 Server CLI adapter now uses owner-confirmed host execution,
fresh branch/runtime proof and a reserved original-resume node. Desktop and Server UI now use the
same transaction through an owner-only entry; remaining restart/account orchestration is separate.
The PR 10 snapshot passes all 24,302 tests (109 skipped) and both builds. External URL previews
and optional isolated static HTML previews are now connected. Static HTML intentionally keeps
scripts disabled: resource CSP alone cannot contain a script's self-navigation. Script-enabled
interactive application execution remains part of the isolated worker track (PRs 18/19).

Two independent exports are proposed upstream, each based directly on `upstream/main` and passing
24,164 tests (109 skipped), typecheck and both builds: [geometry #1320](https://github.com/eneskirca/nodeterm/pull/1320)
and [media definitions #1321](https://github.com/eneskirca/nodeterm/pull/1321). Their remote CI/Security
workflow runs report `action_required`; the upstream maintainer must authorize those fork runs.
The integration through `be86cd38` is pushed to the fork as `up/server-media-streaming`. Upstream
acceptance is tracked separately from local implementation and validation.
The PR 11 snapshot passes all 24,324 tests (109 skipped) and both builds. The shared owner
confirmation broker and both UI adapters are implemented, with target/policy revalidation at
single-use permit consumption. Their command adapters (PR 13) remain the next delivery step.
The PR 12 snapshot passes all 24,338 tests (109 skipped) and both builds. Settings persistence now
has a serialized conditional-update seam, partial owner UI writes and durable owner-only pushes,
preventing modern browser edits from replacing unrelated host changes before PR 13 enables CLI sets.
The first PR 13 adapter now enables individually confirmed local `settings --set` in both shells,
with a conditional FIFO write and the same pure capability-consent setter as the UI. The remaining
write/removal adapters and execution coordination are still pending.
The settings snapshot passes all 24,362 tests (109 skipped). PR 14's managed Codex lifecycle is
now extracted into core and connected to native/Server owner lifetimes and the real browser bridge.
Its filesystem/RPC fixtures cover preparation, cross-tab rejection, disconnect, expiry and removal
exclusion. It retains the existing device-verification limitations of authenticated CLI switches;
node-wide write/branch/restart coordination remains a separate outstanding acceptance gate.
A real Server boot fixture now runs the generated POSIX CLI through hook authentication, persists
geometry and web nodes, refuses cross-project placement, posts a signed hook event and completes
an individually approved settings change over an authenticated owner WebSocket. Its HOME, endpoints,
files and tmux environment use the existing test sandboxes; it starts no agent CLI session.


The managed Codex snapshot passes all 24,371 tests (109 skipped) and both builds. PR 15's project
manager, remote hooks/freshness/tunnel repair, filesystem, atomic writes and SSH inventory have
moved into core, with compatibility exports and native shell adapters. The focused SSH suite passes
1,103 tests (5 skipped), including the existing real-shell truncation and transport fixtures.
Server SSH wiring and a shared owner prompt adapter remain separate work; the extraction does not
enable them by itself.

The shared SSH authentication services now include askpass, app-owned agent lifetime and the
owner-bound passphrase-response broker. Desktop consumes them and cancels prompts on document
departure; the Server connection adapter remains part of PR 16. Existing instance socket namespaces
are preserved. Focused tests cover wrong recipient, replay, expiry, reload and bounded cleanup.

The shared SSH authentication snapshot passes all 24,379 tests (109 skipped) and both builds.
Native/OpenSSH process runners and remote workspace reconciliation/throttling are now also shared
core services consumed by Desktop. Server routing and streaming transfers still require their
separate PR 16 adapter and multi-client scope validation.

A third independent upstream export, [SSH services #1322](https://github.com/eneskirca/nodeterm/pull/1322),
is based directly on upstream/main and passes 24,168 tests (109 skipped), typecheck and both builds.
The integrated SSH runner snapshot passes 24,379 tests (109 skipped) and both builds. A new optional
Git request scope captures each caller's resolver through awaits, including an explicit local mode
and an unavailable-remote refusal. The Server adapter still needs connection identity, project
routing and transfer validation before SSH is enabled.

The first PR 16 Server adapter now implements opt-in SSH inventory, lazy transport, owner-scoped
passphrase delivery, status, remote filesystem access, workspace reconciliation and connection-scoped
Git. Enable it with `NODETERM_SERVER_SSH=1` or `--ssh-projects`; keys, host config, file paths and
account homes belong to the server user. No browser credential store or agent forwarding is added.
Owner-only capability negotiation explains disabled/older hosts. Transfers and remote media are
explicitly unavailable pending their bounded streaming endpoints; remote transcript/context/usage
bindings and remaining SSH automation are still outstanding and must not fall back to local data.

The first Server SSH snapshot passes 24,399 tests (109 skipped), typecheck and both builds.
Both OpenSSH and native-SSH fixtures authenticate an encrypted temporary key over a real loopback
SSH server, reject another owner tab's passphrase response, read/write quoted remote filenames and
reconnect under a new connection generation. Queued SSH exec checks target and generation again
before spawning; Git captures the caller's project through awaits. Remote workspace writes also
compare the requested endpoint and folder at delayed dispatch, protecting Desktop too. An unused
agent adapter cannot unlink or unpublish another agent. Explicit unavailable Claude/Codex remote
contexts refuse; Codex login cancellation interrupts its wait and drops late results.

The independent [Claude remote refusal #1323](https://github.com/eneskirca/nodeterm/pull/1323)
passes 24,164 tests (109 skipped), typecheck and both builds. The latest SSH export passes 24,170.
The independent [license lifecycle #1324](https://github.com/eneskirca/nodeterm/pull/1324)
passes 24,170 tests (109 skipped), typecheck and both builds.
The shared license lifecycle snapshot passes 24,404 tests (109 skipped), typecheck and both builds:
requests/polls have a disposable host lifetime, mutations serialize, persistence is atomic/0600,
and new device identities are published synchronously without replacing an existing installation.

PR 20 now has its first Server adapter: `NODETERM_SERVER_LICENSE=1` / `--license` enables owner-only
administration and the existing licensed Live Links service. Checkout opens in the requesting
browser. Disabled/older hosts are distinguished from free enabled hosts; the normal Pro gate and
backend entitlement checks remain mandatory. Owner departure, shutdown, atomic failure and UI
capability fixtures cover the path. This Server snapshot passes 24,413 tests (109 skipped), typecheck and both builds.

Remote context/subagent tails, bounded SSH file reads and the streaming SSH setup runner are now
extracted into core, with native window/private-agent adapters. The existing 79 focused tests and
typecheck pass; the full extraction snapshot passes 24,413 tests (109 skipped) and both builds.
Server now wires the streaming SSH setup runner under existing per-location consent, sends consent
only to owners, and exposes only references matching the current saved destination. Real SSH
fixtures cover setup stdout/stderr and refusal after project deletion or key replacement. Full
transcript/context bindings remain the next integration step.

The integrated security and dependency-patch snapshot passes 24,418 tests (109 skipped),
typecheck and both builds, with zero npm audit advisories. The fork integration is tracked in
[draft PR #2](https://github.com/barontechio/BTnodeterm/pull/2). Linux, Windows, CodeQL and
dependency review also passed for the refreshed lock (`dd982171`). The review and per-alert decisions are recorded in
[the security review](server-parity-security-review.md).

Host node execution now has a bounded, owner-aware coordinator (`6249a946`) and a first
PtyManager integration. Claims refuse pre-existing pane writes, queued/physical controller
deliveries, creates and teardowns. Keyboard input receives an addressed, throttled refusal;
headless/raw/background writes, semantic launch, keys, recycle and destruction cannot enter
another action's node. Expired async continuations cannot create or write a different node.
Physical controller delivery remains fenced after its caller's response deadline. The focused
PTY/coordinator suite passes 724 tests (6 skipped); the complete foundation passes 24,427 tests
(109 skipped), typecheck and both builds. A fake session-host snapshot
is now explicitly isolated even when a real bundle exists on disk. No new write/branch command
is enabled by this foundation alone; their target/account/pane and consent adapters remain gates.

Group host operations now use `PtyManager.runNodeActions` / `NodeExecutionCoordinator.runMany`.
They atomically claim an immutable bounded member set, refuse a busy member or capacity overflow
without partial claims, and retain all fences after cancellation until actual backend settlement.
The same async continuation can act on every claimed member; expired detached work remains invalid.
This does not yet authorize worktree removal or reserve its filesystem path. The frozen combined
snapshot `63aa25ab` passes 24,488 tests (109 skipped), typecheck and both builds.

The first PR 13 `write` adapter is now implemented in core and connected to Server: a verified
local Claude terminal, current idle state, kernel-proven foreground process, empty styled composer,
unchanged saved execution/account/session identity and individual owner approval are all required.
Creator/project scope reuses the factory's existing process-local ownership ledger. Approval waits
outside queues; execution takes the host node claim and rechecks the target. A draft refusal sends
nothing; a possible paste/unknown submit reports uncertainty and never retries. Successful and
uncertain dispatches mark the existing handover tracker before releasing the node and withdraw
older outcomes, so late hooks cannot make a second write reuse the previous idle state. Desktop
retains its existing confirmation/waiver flow; the shared PTY boundary supplies its exclusion checks.
Other agents and SSH writes remain explicitly unavailable until their input/identity readers meet
the same checks. Removal and the remaining account/restart orchestration still require their own
coordinated adapters. Shared CLI/UI branching is described below.

The Server message-envelope adapter now also lives in core and delegates to a compound
PtyManager operation. One pane-write slot spans capture, paste, settlement and Enter, preventing
a competing application write or host action from entering the old gap between two public
`sendText` calls. Its behavioral regression holds the post-paste read, queues a competing write,
and checks submission finishes before that write. Partial/uncertain paste semantics are retained.

The combined confirmed-write/envelope snapshot passes 24,438 tests (109 skipped), typecheck,
Desktop production build and Server build. Its exact-text approvals, replacement/refusal/unknown
delivery fixtures and real Server CLI pre-send refusal are included in that full run.

The independent [atomic envelope submission #1326](https://github.com/eneskirca/nodeterm/pull/1326)
is based directly on upstream/main, with its own lockfile installation. It passes 24,165 tests
(109 skipped) both before and after building, typecheck and both builds. It also isolates the
fake host's final snapshot so a built bundle cannot start a real host during fixture cleanup.

Server mounted-node session-name polling is now connected to the existing per-agent core reader.
The optional trailing node id binds owner RPC and background sweep reads to the current saved
project/account and runtime session. Remote/unavailable/mismatched targets never search local
histories; metadata changes during a read discard its result. The browser's JSON-null optional
arguments are normalized; Native retains its existing IPC reader. The shared sweep rechecks
session/account/manual-title identity before publishing, prevents overlapping passes and discards
late publications after stop. Both Server close paths (and the already-running-server exit) stop
the sweep. Focused tests include a real Server owner WebSocket reading a real temporary title file.

This node-bound title snapshot passes 24,445 tests (109 skipped), typecheck and both builds.
The independent [session title freshness #1327](https://github.com/eneskirca/nodeterm/pull/1327)
exports the shared revalidation/lifetime fixes directly on upstream/main: 24,166 tests
(109 skipped), typecheck and both builds, with no dependency changes.

The next SSH increment adds authenticated-owner Claude chat/history reads for connected projects.
The shared bounded reader selects the current saved node's host, session and account through a thin
Server adapter; missing/unsupported/stale targets never scan local histories or another account.
Its optional Python 3/POSIX command writes no remote file, uses no-follow directory-relative
descriptors and rechecks named identities. Discovery is capped at 4,096 project entries and each
window at 5 MiB plus lookbehind, with 32 active reads/two per node and a 30-second request lifetime.
Queued SSH work is cancellable and bound to owner/request/connection identity; dispatched work
retains its transport slot until settled. Transport lifecycle callbacks do not inherit expired
request ALS. The panel distinguishes runtime, unsafe-tree, permission and unsupported-reader
refusals. Real encrypted-key loopback fixtures cover both transports and managed-account isolation.
Continuous remote meters/tails, other harnesses, transfers/media and remote control proof remain
separate gates. The frozen SSH/routing snapshot `f120dbdb` passes 24,484 tests (109 skipped),
typecheck, Desktop production build and Server build. Its real encrypted-key loopback fixtures
exercise both transports, managed-account isolation and owner/guest routing. A local warm-cache
256 KiB command benchmark measured median 17.89–44.42 ms across 1–4,096 project entries, excluding
SSH latency; details and the existing known-path baseline are in `server-ssh-projects.md`.

Context-link classification now includes saved/disconnected remote placements in both shells.
Server deliberately supplies no remote context reader/capture adapter yet; these reads refuse
without searching local histories. The shared handler revalidates the selected edge's session,
account, hook path and routing after asynchronous IO, while preserving reads across title-only
edits. Context-link authorization remains independent of owner-only remote chat history access.

The independent [remote meter routing #1328](https://github.com/eneskirca/nodeterm/pull/1328)
exports the no-local-read guards directly on upstream/main without transport/dependency changes:
24,167 tests (109 skipped), typecheck and both builds. It refuses local rehydration/replay and
raw-hook tail setup for saved/live remote records, and releases earlier local tails on refresh.

The independent [host terminal coordinator #1329](https://github.com/eneskirca/nodeterm/pull/1329)
exports the single/group execution boundary, owner lifetimes, addressed input notices and relay
policy directly on upstream/main: 24,183 tests (109 skipped), typecheck and both builds. It adds
no command or dependency and retains domain authorization/consent as the adapter's responsibility.
Upstream workflows for #1327–#1329 require maintainer authorization; local validation is not upstream
acceptance.

The confirmed Server CLI branch snapshot `e5cf8529` passes 24,538 tests (109 skipped),
typecheck, Desktop production build and Server build. It includes private execution-overlay
revalidation, separate backend lifecycle context, fixed-command submit dispatch tracking and
reservation of the original-resume node before publication. A deterministic SSH fixture now
distinguishes mux argv from legal ControlPath strings containing `-O`.

The shared owner/agent branch snapshot `52b034fc` passes 24,546 tests (109 skipped), typecheck,
Desktop production build and Server build. Focused real-factory tests cover the direct owner
transaction without a caller/creator grant, document departure during dispatch and menu-position
snapshotting. A real Server owner WebSocket reaches the guarded entry; missing support, lost
replies and relay tabs never fall through to raw input or the viewer's local owner API.
The preceding confirmed-CLI delivery `37735924` passed Linux and Windows quality, Dependency
review and both CodeQL analysis/gate checks. Each subsequent delivery needs its own remote checks.

Baseline inspected on 2026-10-29:

| Item | Reference |
| --- | --- |
| Upstream | `https://github.com/eneskirca/nodeterm`, `main` at `8d897fcf2051f124ca23cf8941818998a294491c` |
| Fork | `https://github.com/barontechio/BTnodeterm` |
| Working branch | `up/server-control-scope` at `5943c1d335a74eb9024a6c709d8c097f7d4beb79` |
| Local commits ahead of upstream | `ae25a175` adds Server `list`; `4f6fcf0f` documents it; `5943c1d3` adds opt-in project control scope |
| Control surface | Desktop declares 39 verbs; Server admits 18. The 21-name difference includes the `open-claude` convenience entry. `settings` is also only partially implemented on Server. |

Publish the existing `list` change with its documentation, and the project-scope change separately. Later work must either build on their merged upstream commits or state those dependencies explicitly. Never submit the fork's entire integration branch as one upstream PR. Branch each independent change from current `upstream/main`; use a short dependent stack only while its prerequisite is under review, then retarget and remove already merged commits.

Repository-facing documentation and PR descriptions stay in English. Use generic Nodeterm names, configurable paths and existing operator settings; keep Barontech deployment details out of shared code. Preserve the license, entitlements and usage limits.

## Scope decisions

Implement ordinary canvas automation, orchestration, account management and useful browser equivalents. Keep heavy remote infrastructure optional so a terminal-only installation does not load a browser engine, run port scans or start SSH connections.

### Control commands

| Gap | Decision | Delivery |
| --- | --- | --- |
| `ungroup`, `move`, `arrange`, `align`, `resize`, `place` | Implement using the existing geometry rules over the owning project's stored state. | PR 03 |
| `board`, `assign` | Implement read and assignment operations using the existing board model and ordering. | PR 04 |
| `open-claude` | Normalize into the existing Claude form of `open-agent`, preserving arguments and policy checks. | PR 05 |
| `show-image` | Create an editor/image node through the normal mutation path. | PR 05 |
| `show-video` | Implement video and audio through authenticated streaming. | PR 10 |
| `show-web` | Implement external URL and HTML previews with explicit browser rendering limits and an isolated content origin. | PR 11 |
| `open-browser`, `browser` | Provide an optional server-owned remote browser, distinct from the viewer's browser session. | PRs 18 and 19 |
| `spawn-team`, `verify` | Share planning and orchestration; run dependencies and launches in core. | PR 07 |
| `open-worktree`, `close-worktree` | Share worktree lifecycle, preserve Git safety and require confirmation for removal. | PR 08 |
| `branch` | Extract the existing supported conversation-branch operation with session and account checks. Initially retain Claude-only support. | PR 09 |
| `write` | Add only with host-side target checks, the existing submission machinery and an owner-confirmation path. | PR 13 |
| `settings --set` | Add the existing allowlisted settings with explicit confirmation for every change. | PR 13 |
| `report-issue` | Wire the existing core service, project grant, redaction, deduplication and rate limits. | PR 06 |

### Application capabilities

| Gap | Decision | Delivery |
| --- | --- | --- |
| Generated terminal and group names | Share the existing naming implementation and configured provider behavior. | PR 06 |
| Search across transcripts | Share search with host/account/project scoping, bounded work and cancellation. | PR 06 |
| Board comments reaching agents | Wire the existing typed delivery path and show its actual outcome in the comment. | PR 06 |
| Managed Codex accounts | Share lifecycle and switch orchestration with an authenticated connection identity adapter. Keep secrets on the host. | PR 14 |
| SSH projects, remote files and transfers | Extract the existing project manager behind injected transport, prompt and secret-store dependencies. | PRs 15 and 16 |
| Development ports | Reuse discovery and add an optional authenticated preview gateway. Opening viewer-side `localhost` is not a remote preview. | PR 17 |
| Pro activation and Live Links | Wire existing licensing first; enable links only with a valid supported entitlement. | PR 20 |
| Joining another hosted team | Optional browser-compatible relay client using the existing encrypted protocol and trust flow. | PR 21 |
| Mobile pairing | Continue existing SSH/grant and hosted-team paths. Design any new Server pairing flow with the mobile maintainers. | PR 22 |
| Sharing an SSH project with a team | Reassess after SSH extraction; reuse `shareTeam` and hosted-team primitives if the same trust and handoff contract can be met. | PR 22 |
| Notifications and notification clicks | Browser-native permission, notification and focus behavior where supported. Background delivery with no page open requires a separately designed web-push path. | PR 22 |
| Finder, default local applications, OS file clipboard, global shortcuts, native menus, OS URL registration | Keep native Desktop implementations; provide download, upload, browser links and in-page shortcuts where useful. | Documented platform behavior |
| Simulator views | Keep Desktop-only. A remote simulator service is a separate product, not a Server parity dependency. | Out of this series |
| Desktop installer, tray, HUD and self-update | Keep Desktop-only. Server retains its installer/service update lifecycle; browser UI may expose read-only version/update status. | Documented platform behavior |
| Raw host environment snapshots | Preserve the current refusal to expose the host environment. Resolve approved launch inputs host-side instead. | Architectural invariant |

The capability inventory must use the assembled browser API: several entries in `stubs.ts` are overridden by real bridge implementations. Claude accounts, transcripts for individual sessions, speech, Git, editor/diff, triggers, run configuration, context links, usage and session memory already have working Server paths and are regression targets.

## Architecture rules

1. **Shared services live in `src/core`.** It must not import Electron, `src/main`, React or renderer stores. Pure types, parsers, planners and reducers live in `src/shared` and stay platform-independent.
2. **Shells adapt capabilities.** `src/main` owns Electron windows, native dialogs, browser guests and keychain integration. `src/server` owns HTTP/WS, connection identity and Server boot. Add narrow injected dependencies when a service needs platform behavior; avoid turning `CorePlatform` into a feature registry.
3. **UI and agent entry points use the same domain rules.** Extract one operation at a time and route Desktop through the extracted implementation in that PR. Retain render-only calculations, selection and measurements in the renderer. Do not copy the `Canvas.tsx` switch into Server.
4. **Each project's existing writer remains authoritative.** Governed content passes through `canvas-sync`, its mutation reducer and `canvas-authority`; publish mutations before the overlaid save. Ungoverned content uses the workspace write queue and existing merge rules. All paths preserve nodes, board items, bridges and ropes.
5. **Shared content cannot grant execution.** Preserve `node-exec` stripping and owner-only machine-local execution fields. A Git pull, relay mutation, hand-edited file or browser reload never grants consent or starts an agent by itself.
6. **Actor identity comes from the authenticated boundary.** Owner browser, verified agent node and relay peer are distinct callers. A browser connection ID alone is not ownership. A client-supplied `verified`, role or project ID is never authority.
7. **Authorization stays host-side.** Preserve verified node identity, `creator` as the default scope, operator-only opt-in to `project`, project grants and capability consent. New read verbs need an explicit scope decision too. Invalid ownership or an ambiguous node ID fails closed before any effect.
8. **Capabilities describe availability, not permission.** An implemented command can still be disabled, require consent or be unavailable on a backend. Capability metadata never replaces the execution-time checks.
9. **Protocols evolve additively.** Use `shared/ipc.ts`, existing RPC errors and typed outcomes. Preserve old channel names, CLI flags and serialization. Older clients fall back to known behavior; unsupported peers are refused without restarting their sessions.
10. **Durable facts and side effects have explicit boundaries.** Persist nodes and launch intent before spawning; retain failed nodes with an actionable outcome. Reuse the control request ledger, launch claims, delivery queue, station outcomes and handover holds. An uncertain side effect is reported as unknown, never automatically repeated.
11. **No operation steals the user's view.** Commands act on the source's owning project without activating a tab or moving its camera. Core operations do not depend on mounted React components, except optional interaction with an explicitly viewed native guest.
12. **Resources follow demand.** Use existing coalescing, backpressure and host/session budgets; bound queries and queues; stop workers, scans and sessions when their owning service stops. Record lifecycle failures through the existing logs without credentials or transcript dumps.

## Shared command and mutation design

Keep the existing RPC and hook-server entrances. Introduce small shared command modules as features move out of the renderer, with separate parsing, authorization, state transformation and external effects. A command-specific planner can return the patches it intends to apply; this does not require a general workflow language or a second message bus.

Start by extracting the proven `HeadlessNodeFactory` read, content-diff, publish-before-save and fresh-patch behavior into a narrow core mutation dependency. Preserve its shutdown guards and creator proof. Add a focused workspace mutation primitive only where needed to place a fresh read and its patches inside the existing write serialization. Do not create an independent lock around `saveChain` or enqueue a call that waits on itself.

For governed projects, consume the latest authority state and publish through the existing reflector and reducer; an overlaid save cannot be used to sneak in unpublished changes. For ungoverned projects, preserve the existing own-write merge path and reject unresolved file conflicts. Prove interaction with browser saves rather than assuming the factory's private queue serializes other writers. A stale browser save must not erase an agent's completed mutation.

After an external operation, such as `git worktree add` or PTY launch, re-read state and apply only that operation's still-valid patches. Preserve unrelated concurrent edits and never resurrect a deleted node. Send the persisted project on `workspace:server-change`; reserve `workspace:external-change` for actual outside edits.

Reuse the existing mutation vocabulary and request ledger. Any necessary additions must be negotiated and tested against older clients before being advertised. Do not extend request-ID replay to `write`, messaging, reads or settings merely because a new service uses it. UI approval tickets have their own one-use lifecycle.

For short local operations, report success after the required persistence step succeeds. If an operation was reflected or externally applied but its final persistence fails, return an explicit uncertain/recovery outcome and retain the existing retry/flush facts. Do not promise transactional or exactly-once behavior across disk, Git, PTY input and external APIs.

## PR sequence and acceptance gates

PR numbers below identify planned changes, not GitHub issue or pull-request numbers. Split a row further when implementation exceeds one coherent review. Do not combine an extraction, a behavioral expansion and a protocol redesign in one PR.

### PR 00 Capture behavior and reconcile upstream prerequisites

- Record each control verb and assembled API member as implemented, disabled, interactive, backend-dependent or intentionally unavailable. Include Desktop, Server and the mobile follow-up decision.
- Characterize existing source routing, creator/project scope, request replay, cold/warm session attachment, governed writes and stale browser saves before refactoring.
- Add the missing explicit `server:build` CI check using the repo's Node/Electron native-addon installation rules. Keep existing `quality`, CodeQL and dependency-review requirements.
- Replace the misleading current-state summary in `docs/SERVER.md` while preserving historical phase notes.

**Accept when:** the inventory accounts for all 39 existing verb names and all effective bridge namespaces; current known limitations have named tests or bounded follow-up issues; the existing `list` and project-scope contributions have independent upstream histories.

### PR 01 Expose typed capabilities

- Define a small shared capability manifest and authenticated introspection for the browser and agent CLI. Derive per-shell support from registered implementations and injected backends.
- Keep supported syntax, edition availability and caller authorization separate. Generate agent-facing availability text from this metadata while keeping enforcement in core.
- Ensure unknown capabilities and old hosts do not cause the UI or agent to claim support. Leave existing API members in place for compatibility.

**Accept when:** the same feature reports consistently to the UI and agent, stale capability information cannot authorize it, and an older host/client retains its existing supported workflow.

### PR 02 Share the canonical mutation path

- Extract the smallest reusable core mutation dependency described above, leaving feature-specific ownership and session rules explicit.
- Route existing Server metadata commands through it first; keep observable outcomes unchanged.
- Exercise governed and ungoverned projects, dirty browser saves, outside edits, I/O failures, shutdown and simultaneous requests.

**Accept when:** two agents and two browser clients preserve each other's independent changes; deletion wins over delayed patches; no change is dropped by the authority overlay; a rejected write leaves the previous file readable. Any existing unresolved stale-save failure blocks the affected new mutation commands until fixed.

### PR 03 Enable geometry automation

- Reuse `geometry-verbs`, node geometry, node ordering and the existing group/layout transforms. Move pure renderer helpers into `shared` as needed, retaining compatibility re-exports.
- Implement `ungroup`, `move`, `arrange`, `align`, `resize` and `place` over stored state; use measured size only as an optional UI input. Preserve frame constraints, root/parent coordinates, collapse behavior, size bounds and grid behavior.
- Share transformation and reply semantics with Desktop. Validate all affected nodes and frames under the selected scope before committing a batch.

**Accept when:** results match Desktop for equivalent stored inputs; unknown IDs, cyclic groups and invalid dimensions have the documented outcome; geometry changes preserve non-geometry fields, exec overlays and edges; the operation works with zero browser clients and never activates another project.

### PR 04 Enable board automation

- Move the pure `boardVerbReply` projection to shared code and share assignment planning.
- Implement `board` and `assign` using the existing source registry, sanitizers, `placeAssignment` ranking and board-log funnel. Preserve lazy default-board behavior and provider-owned lanes.
- Read and modify only the caller's authorized project and cards; assignment must not type into a terminal or launch work.

**Accept when:** canvas and kanban remain two views of the same nodes; simultaneous moves converge; rank and array ordering remain readable by old clients; board configuration, labels, metadata and GitHub lanes survive assignment writes.

### PR 05 Add image nodes and the Claude convenience command

- Normalize `open-claude` through the shared `open-agent` path without losing prompt, account, mode, model, dependency or request-ID semantics.
- Share the image-node construction needed by `show-image`; preserve project ownership and local/remote filesystem identity.

**Accept when:** both entry points obey the same launch and scope checks; the image persists and opens after reload; a missing or unsupported source gives a useful error; shared or remote content never silently reads a same-named file on the wrong host.

### PR 06 Share naming search comments and issue reporting

These are four independent leaf PRs that can proceed after their own mutation/policy prerequisites:

- Extract terminal/group naming from Desktop wiring and use the configured naming service on the host. Keep unavailable provider outcomes honest.
- Share bounded transcript search with provider/account/project scoping, pagination or result limits and cancellation. Search must never fall back to another account or host.
- Wire `deliverBoardComment` through the existing agent messaging service, preserving pane ownership, capability grants, idle checks, delivery outcomes and deduplication.
- Register `report-issue` with the existing GitHub service. Preserve project-specific reporting consent, redaction, preview, deduplication and rate limits; it remains distinct from a general GitHub write API.

**Accept when:** no credentials or foreign transcripts cross the bridge; a failed or uncertain delivery is visible; retrying a comment does not type it twice; an agent cannot enable its own reporting grant; Desktop and Server use the same service rules.

### PR 07 Move team and review orchestration into core

- Extract pure team-spec and review-panel planning from `teamSpec.ts`, `verifyPanel.ts` and the renderer dispatch. Keep existing role limits, models, accounts and prompt spilling.
- Build nodes, groups, bridges and dependency edges as one validated plan. Persist before launching members through the existing launch writer/claims.
- Move dependency release into the shared core orchestration path. Use current-session evidence, handover holds, background-task state and outcomes; handle events that race with arming.
- Make Desktop's corresponding UI path use the same planner and ownership of launch release. Keep one claimant per launch while migrating off renderer-owned scheduling.

**Accept when:** a team starts with no UI; `verify` starts reviewers only when its actual target is eligible and its optional synthesis only when its reviewers are eligible; two tabs cannot launch a member twice; restart, partial launch failure and an ambiguous request replay do not silently recreate a team or lose its pending state.

### PR 08 Share worktree lifecycle

The conservative Git removal primitive is available internally as `worktreeRemoveClean`: current
local directory identity, exact linked branch, no `--force`, no primary checkout removal, no missing
checkout pruning and no forced branch deletion. Real Git fixtures preserve dirty/untracked files,
locked checkouts and unmerged branches. This does not enable CLI removal: the directory/node
reservation and durable canvas recovery adapter must be connected first.

The recovery storage foundation records `prepared` → `removed` → `recovered` intents with bounded
node identity hashes and retained path tombstones. It requires the actual data-directory owner,
flushes file and directory metadata before acknowledgement, rejects malformed/changed journals and
requires reload after uncertain persistence. The filesystem must support directory flushes; no
deletion command is enabled by this storage foundation. Directory/canvas admission and the removal
transaction remain the next adapter gate.

Both owning shells now load recovery state before launches. Pending/recovered path markers block
new physical starts before stale-cwd fallback, including missing descendants and dangling symlink
aliases. Live co-attachments and unrelated directories retain their behavior; an empty journal adds
no path-resolution IO. A real Server owner WebSocket fixture refuses a cold start inside a prepared
removal. Confirmed removal and agent/changed-checkout recovery remain pending. Recorded plain-node missing recovery is described below.

The canvas execution reservation primitive now pairs an actual host batch claim with conditional
workspace admission, acquired inside the store FIFO. Folder, app-data and inline content writers,
phone registration/removal and storage changes reject incompatible execution metadata before
publication or disk writes. Optimistic client correction retains accepted visual updates through
an ordered host observer and keeps private exec carry. Reservations outlive owner departure until
the dispatched effect settles. This primitive is not yet installed as a removal transaction.

Both owning shells now install path-reference admission alongside the physical-start guard. New
nodes, bindings, local files, run folders, project roots and held-launch changes cannot introduce a
retired path through a client op, old full save, Core edit or phone/authority writer. Historical
layout/tab edits and repair to a safe directory remain possible after restart; inert missing-file
notices retain their display paths. Corrections preserve incoming visual intent. A pending-journal
fixture exercises folder, app-data and inline projects, dangling aliases and corrupt-state behavior;
the existing real Server boot still exercises authenticated commands with pending recovery state.
Whole-project checks use bulk private host snapshots to avoid a node scan per node. Empty recovery
state adds no canonical-path IO. Confirmed removal/recovery actions remain the next domain gate.

Known prepared/removed member ids now retain a dispatch quarantine across recovery boot and uncertain
publication acknowledgements. Normal claims, including a `worktree` action label, cannot waive it;
only the actual batch permit explicitly registered by a host recovery adapter can dispatch to its
members while the effect is awaited. Owner input receives an addressed recovery-specific notice;
unrelated panes remain usable, and unknown corrupt facts invent no quarantine on existing panes.
The storage adapter can release a prepared kept-checkout record, but its caller must first prove
the original directory/Git identity and obtain fresh owner approval. The confirmed deletion and
agent/changed-checkout recovery remain pending; none of these guards enables a deletion command.

The first complete owner recovery path now inspects pending facts and keeps a surviving original
checkout through `WorktreeRecoveryService`, owner-lifetime RPCs and an app-global recovery UI in both
shells. It proves the original canonical inode and linked branch inside the durable journal FIFO
under the node/backend barrier, preserves dirty files, and performs no Git mutation, session
teardown/input, archive or canvas change. Old/non-owning hosts negotiate absence and relay APIs omit
the owner plane. UI lifecycle tests cover explicit review, double-click exclusion, stale replies and
lost-response non-replay; a real authenticated Server WebSocket fixture keeps a real dirty checkout.
That first owner path is kept-checkout recovery only. The later missing-checkout slice below adds
recorded plain-node repair. Subsequent verified rebinding and C manual resume are described above;
confirmed deletion remains a separate gate.

Recorded missing-checkout recovery now has an owner-broker-confirmed path for plain local
terminals, groups and inert editor/diff notices. It re-proves absence, persists a bounded old/new
binding plan, awaits the acknowledged recycler, repairs in the same reserved workspace FIFO and
retains host-private manual-start quarantine after metadata recovery and restart. No Git deletion
is retried and no replacement starts or receives input. Agent account/runtime identities,
and new deletion remain separate gates. Later verified rebinding and C manual resume retain the
manual-start restriction; the current journal is v5, with strict legacy reads and no unsafe downgrade fallback.

Observed-missing recovery also handles a saved plain-local group whose checkout disappeared before
any journal intent. Owner discovery is read-only; a single broker approval repeats saved-node,
canonical ancestry and real repository checks before writing explicit observed-absence provenance.
No prior inode or Git dispatch is invented. The same acknowledged repair path retains manual-start
restrictions; interrupted recording/repair is recovered through its durable record, never by retrying
Git or silently replaying the owner action.

- Extract create/bind/unbind/remove orchestration, using `GitService`, existing worktree target/reconciliation rules and shared-path materialization.
- Preserve the meaning of base refs and station IDs. Create the directory and binding with an explicit recoverable outcome if either side fails; do not delete a successful Git result merely to hide a partial failure.
- Unbind keeps the directory. Removal requires explicit confirmation, checks worktree ownership and uncommitted work, and refuses to affect the primary checkout or another worktree.

**Accept when:** two stations cannot claim the same directory or branch incorrectly; dirty/unreadable worktrees are preserved; bindings reconcile after restart; a failed canvas commit exposes the created directory for recovery. Land unbind/create before removal if the confirmation broker is not ready.

### PR 09 Share conversation branching

The CLI and UI implementations are connected through `ConfirmedNodeBranch`. It shares saved
target/account policy with `write`, verifies the original transcript and foreground pane, requires
individual owner approval, and holds a node claim through fixed typed submission and fresh
marker/runtime correlation. A dispatch notice permits only the expected target session transition.
The original-resume continuation claims its new id before canvas publication and binds account,
folder, model, owner lifetime and physical generation through launch. It preserves a durable manual
recovery command on failure and reports a confirmed branch separately from an uncertain effect.
This adapter is local POSIX tmux Claude only and bounds pending branch intents to one per target/32
per host. Agent calls exclude the caller and require individual approval. Direct owner actions use
their actual document lifetime, with no invented caller or creator grant, and create the original
beside the source or at the validated menu position. Renderer branching saves first and invokes only the host operation; missing or
lost replies never fall back to raw input. Relay tabs omit owner actions rather than inheriting
the viewer's local control namespace. Native CLI uses the same confirmed agent entry.

- Extract the existing Claude branching workflow, including parking/resuming the correct session, transcript availability, account identity and per-node execution locks.
- Preserve the current node/new node conversation mapping and refuse unsupported providers explicitly.

**Accept when:** both conversations remain recoverable; a failure never silently reassigns a session to another account; unsupported backends refuse without side effects; concurrent branch/write/restart requests cannot mix terminal input.

### PR 10 Serve video and audio safely

- Add authenticated HTTP streaming with bounded range handling, MIME validation, cancellation and backpressure. Use opaque, scoped, expiring media references; never accept a caller-supplied unrestricted path in the HTTP route.
- Reuse download authentication and path-policy primitives, but give media a separate lifecycle: seeking performs multiple requests and cannot redeem a one-shot download ticket repeatedly.
- Implement the browser `media` adapter and `show-video`; retain Desktop's native protocol adapter and existing player. Keep issued resources alive while in use and clean them on release or shutdown.

**Accept when:** seek and reload work without base64 streaming through the terminal socket; traversal, symlink escape, revoked access and expired references fail; large playback does not stall PTY traffic. A revoked project or peer stops future media requests.

### PR 11 Add isolated web previews

- Implement `show-web --url` using a browser-appropriate surface and a clear external-open fallback when a site refuses embedding. Respect the target's embedding policy.
- Serve `--html` and approved local files from an origin isolated from Nodeterm authentication and application storage, with sandboxing and bounded resource access. Keep the capability unavailable until the operator has configured an acceptable origin; do not serve arbitrary active HTML on the application origin.
- Keep preview nodes separate from the fully controlled browser of PRs 18/19.

**Accept when:** preview scripts cannot read Nodeterm cookies/storage or call owner APIs; relative resources obey the configured source policy; blocked embedding is explained; local HTML cannot expose arbitrary neighboring host files.

### PR 12 Add a shared owner confirmation broker

- Bind each pending action to its verified requester, target project/node/session, exact normalized arguments, current policy and expiry. Use a one-use decision and an authenticated owner UI adapter; relay viewers, agents and arbitrary tabs cannot approve.
- Keep pending requests host-side. With no eligible owner UI, return an actionable confirmation-required outcome without performing the effect. Expired, disconnected, cancelled or stale-target decisions cannot execute later.
- Do not hold workspace locks or global command queues while waiting. Recheck target identity and authorization immediately before execution.
- Reuse existing Desktop confirmation decisions and waiver rules rather than inventing a blanket Server approval. Settings changes remain individually confirmed; operator scope is not a waiver.

**Accept when:** two owner tabs can approve only once; reconnect cannot replay approval; logout or revocation invalidates eligibility; target replacement/account switch defeats an old ticket; Desktop's current consent behavior and request-timeout behavior remain intact.

### PR 13 Enable write settings changes and guarded removal

- Wire `write` through existing per-node locks, pane ownership, settled paste/submit and typed delivery outcomes. Keep an uncertain delivery distinct from a pre-send refusal; never auto-resend.
- Wire `settings --set` through the existing allowlist, bounds and consent setter. An agent cannot alter operator scope, credentials, permission bypasses or its own approval rules.
- Finish worktree removal from PR 08 through its existing domain checks and the broker. Preserve the deliberate Server `close` policy unless a separate upstream change explicitly revises it.

**Accept when:** working/replaced panes are handled under the established rules; unsubmitted and uncertain text is surfaced; only approved settings change; a denied, expired or stale confirmation changes nothing.

### PR 14 Share managed Codex account orchestration

- Retain the existing core account primitives and extract the Electron-owned switch coordinator into a service with a small owner-lifetime adapter.
- Model ownership as an authenticated connection plus generation/lifetime, with an Electron adapter for `WebContents`. Preserve prepare/commit/finish/rollback, reservation expiry and cleanup on disconnect.
- Keep credentials and daemon/account directories on their owning host. Browser login uses the supported host login flow; no credentials return through RPC. Server's existing shared Codex identity is preserved rather than reimplemented.

**Accept when:** another tab cannot commit a switch; account removal during a reservation is refused; disconnect/timeout releases safely; a restart has an explicit recovery result; settings are persisted before agent-less login terminals start; missing managed identity never falls back to the system account.

### PR 15 Extract SSH project services

- Move project orchestration from `src/main/remote-ssh/ssh-project.ts` and the SSH store into core incrementally. Reuse the existing core transport, ControlMaster, remote Git, filesystem and session modules.
- Inject prompt routing, caller lifetime and `SecretStore`/platform facilities. Validate the actual host capabilities; Server is not assumed to have the viewer's SSH config, agent, keys, paths or keychain.
- Preserve known-host checks and supported host-key confirmation. A cancelled prompt, failed transport or unavailable secret store must never cause an insecure fallback.

**Accept when:** Desktop uses the extracted services unchanged; connection sharing, pending kills, recovery and passphrase ownership pass the existing real-shell/SSH fixtures; credentials and host keys do not appear in argv, logs or shared project files.

### PR 16 Enable Server SSH projects and transfers

- Register the extracted project/store/filesystem APIs with owner-only management in Server and real bridge implementations. Select credentials from the Server's explicitly configured host context.
- Route terminals, Git, filesystem, transcript/context, usage, memory and media by project identity. An unavailable remote service never answers with local host data.
- Stream uploads/downloads with bounded buffering and cancellation; keep bulk transfers separate from terminal RPC traffic. Validate target roots and handle disconnection/partial transfers visibly.

**Accept when:** real SSH fixtures cover reconnect, host-key/passphrase prompts, remote path handling and interrupted transfers; managed Codex remote lifecycle keeps its account-home safety rules; status and resource measurements name the machine actually queried.

### PR 17 Add optional development previews

- Reuse `dev-ports-service` discovery and verified process/session association. Add an explicit gateway capability with an operator-configured isolated origin and approved target records.
- Proxy only recorded host/port targets; support HTTP and WebSocket upgrades needed for development reload. Revalidate destination and access on new connections, strip Nodeterm authentication from upstream traffic and isolate preview cookies/storage.
- Cover SSH forwards through the extracted transport. Stop forwarding on revocation or service shutdown. Keep scan cadence demand-driven.

**Accept when:** a browser on a different machine can reach an approved local/SSH development service; arbitrary URLs, internal services and cross-project ports cannot be selected through the proxy; redirects cannot escape target policy; development scripts cannot read Nodeterm authentication.

### PRs 18 and 19 Add an optional remote browser

Treat this as an independent subsystem with its own design review and resource budget. The deployment must explicitly install and enable a supported browser worker; basic Server Edition retains its existing dependency footprint.

- PR 18 introduces a browser-session interface implemented by existing Electron guests and an isolated Server browser worker. Keep profile/session identity, frame streaming, input, teardown and resource limits behind that interface. Lazy-load optional native/browser dependencies.
- PR 19 adapts the existing browser-control lease, ownership, stop controls and target resolution to the worker and adds a viewer surface. Preserve settled geometry checks and viewport cleanup; do not emulate the viewer's own tab or inherit its cookies.
- Bind control to the requesting node/project and explicit browser-control consent. Keep browser profile secrets host-side, deny access to host-management/debug endpoints and isolate worker filesystem/network access under the agreed deployment policy.

**Accept when:** `open-browser` creates a server-owned session, authorized `browser` actions act on that session, the human can see and stop them, two actors cannot hold the same lease, worker death is recoverable, quotas are enforced, and neither an exposed debugger nor a stale lease grants control.

### PR 20 Enable Server licensing and Live Links

- Initialize the existing license service in Server with a suitable host-local secret store and external-login/open-link adapter; provide real browser API members for supported activation/status operations.
- Preserve server-issued entitlement validation, expiry, seats, offline policy and all existing product limits. Do not synthesize a premium status.
- Then remove Live Links' unconditional unsupported mode only when a valid supported entitlement is available; retain existing link scope, revocation, access checks and secret handling.

**Accept when:** free/invalid/revoked licenses cannot create links; licensed creation, reconnect and revocation work; viewers see only permitted sessions; activation does not assume that a headless host can open a Desktop window. Any external licensing-service or seat-policy change is a separately specified dependency before activation ships.

### PRs 21 and 22 Extend collaboration where the protocol supports it

- PR 21 adds a browser-compatible transport/crypto/storage adapter for joining hosted teams. Keep existing wire bytes, mutual approval, role checks, host-key identity and pin lifecycle. Model local and joined cores separately so a peer cannot administer the local Server.
- PR 22 covers the coordinated follow-ups: Server/mobile pairing, share-with-team handoff, notification clicks and optional web push. Specify exact protocol/backend/mobile work before promising parity. Reuse existing SSH grants and hosted-team access instead of introducing a competing trust registry.
- For mobile changes, describe required work in the relevant PR and involve `@eneskirca` through the contribution process. The private iOS/Android applications and hosted backend cannot be changed by a PR to this repository alone.

**Accept when:** wire compatibility vectors pass, a viewer/commenter cannot reach owner-only methods or events, revocation stops existing access, pins bind the exact host key, and every feature has an explicit fallback on an old or unsupported client.

## Dependency order

| Track | Order |
| --- | --- |
| Shared foundation | Existing upstream prerequisites → PR 00 → PR 01 and PR 02 |
| Basic automation | PR 02 → PR 03, PR 04 and PR 05; PR 06 leaves use only their actual prerequisites |
| Autonomous orchestration | PR 02 → PR 07; worktrees PR 08 and branching PR 09 follow the shared state/session prerequisites |
| Human-confirmed actions | PR 12 → PR 13 and the removal part of PR 08 |
| Browser output | PR 05/02 → PR 10 → PR 11 where authenticated media references are reused |
| Accounts and SSH | PR 12 where interactive consent is needed → PR 14; PR 15 → PR 16, with managed remote Codex lifecycle after PR 14 |
| Development previews | PR 11 isolation design + PR 16 for SSH targets → PR 17 |
| Optional controlled browser | PR 01 + PR 12 + agreed worker isolation → PR 18 → PR 19 |
| Licensing and sharing | PR 20 can proceed independently of remote browser/SSH; Live Links follow its license gate |
| Collaboration extensions | PR 01/12 and existing relay primitives → PR 21; PR 22 follows the required host/mobile/backend contracts |

The first useful release ends after PRs 03–06: agents can arrange the canvas, use kanban, show images and use the shared utility services. The second adds autonomous teams/reviews and worktree/session operations. Remote infrastructure remains separately installable and cannot delay these releases.

## Validation and compatibility

Each behavioral PR includes tests for its observable contract and a reproduction of the failure it prevents. Avoid tests that merely search source text or restate an implementation. For authorization, replay and ownership gates, remove or invert the guard once and verify the discriminating test fails.

| Area | Required evidence |
| --- | --- |
| Core rules | Shared parser/reducer/service behavior and equivalent Desktop/Server outcomes for the same inputs. |
| Real control path | Generated POSIX CLI → authenticated hook server → command service → persisted result, including named refusals. |
| Lifecycle | Zero browser clients, two tabs, tab closure, logout, process restart, warm session reattach and explicit cold-resume behavior. |
| Concurrency | Agent mutation against browser save, two callers, governed reflector order, outside edit and deletion during a delayed effect. |
| Recovery | Injected disk/rename/Git/launch/transport failures, request reply loss, late result and unknown delivery without blind retry. |
| Authority and trust | Creator/project modes, cross-project attempts, ambiguous IDs, owner vs relay roles, exec stripping, revoked grants and changed session identities. |
| Compatibility | Older CLI/client/host, current `.nodeterm/project.json`, machine-local exec overlays, existing protocol fixtures and documented feature refusal. |
| Operating systems | Linux Server and affected Desktop paths on Linux/macOS/Windows; tmux/Zellij/session-host differences have explicit outcomes. Hardware-only gaps are stated. |
| Resource use | No new background loops for disabled capabilities; bounded memory/queues; no orphan workers, PTYs, tunnels or temp directories; large media/transfers do not block terminal traffic. |

Use the existing scratch HOME, relocation-variable cleanup, tmux sandbox and temporary-directory lifecycle. Never run a test against live Nodeterm sockets, real account directories or production SSH sessions. Use the SSH Docker/real-shell fixtures for remote behavior. Native dependencies used by Server remain external in `server:build` and are checked in both compiled and absent-addon views.

Required implementation checks are `npm run typecheck`, relevant focused tests during development, the full `npm test` and production build at PR validation, plus `npm run server:build`. Existing `quality`, CodeQL and dependency-review gates remain required. Add focused real-platform checks for changed native paths; a Linux typecheck is not evidence of macOS or Windows runtime behavior.

Measure command latency, write amplification and idle resource use against the pre-change fixture before expanding expensive features. Use representative local and shared projects rather than inventing performance budgets without a baseline. A regression requires fixing or an explicit documented tradeoff before its capability is enabled.

## Rollout and completion

Enable a capability only after its implementation, policy, browser API, CLI description and tests agree. Keep the existing Server canvas-control opt-in and default creator scope. Heavy services use individual explicit operator configuration; simple completed commands can follow the existing canvas-control flag without accumulating redundant feature flags. Disabling new automation stops new actions and preserves existing sessions, saved canvases and recoverable work; a feature rollback must not kill them as cleanup.

Shared-file changes are additive and preserve fields unknown to an older build where the existing format supports them. Test old-reader round trips before adding persisted fields. Put sensitive operational state in the existing machine-local stores, never the Git-shared canvas. A rollback to an older binary must retain sessions and files and produce a documented refusal for any newer unsupported feature.

For each upstream PR, include the user-visible trigger and resulting behavior, dependencies, the architectural seam changed, validation, recovery behavior and the decision for Desktop, Server and mobile. Update `docs/SERVER.md`, `CONTRIBUTING.md` and the relevant `CLAUDE.md` invariants when their contracts change. Keep each PR buildable and useful on its own after its declared prerequisites merge; maintain the fork's integration branch separately.

Completion of a capability requires a working user/agent path, headless behavior where applicable, preserved authorization, reproducible recovery, a real bridge implementation, documented old-client behavior and an upstream-ready patch. Upstream acceptance remains the maintainer's decision; track separately whether a change is implemented in the fork, proposed upstream or merged upstream.

## Code references

- [Contribution architecture and validation rules](../CONTRIBUTING.md)
- [Core platform seam](../src/core/platform.ts)
- [Desktop verb model and generated CLI](../src/core/canvas-control-core.ts)
- [Server command allowlist](../src/server/control-unsupported.ts)
- [Server scope policy](../src/server/control-scope.ts)
- [Headless mutation and launch implementation](../src/server/headless-node-factory.ts)
- [Workspace serialization and atomic writes](../src/core/workspace-store.ts)
- [Canvas authority](../src/core/canvas-authority.ts)
- [Canvas reflector](../src/core/canvas-sync.ts)
- [Shared mutation vocabulary](../src/shared/canvas-mutations.ts)
- [Machine-local execution fields](../src/shared/node-exec.ts)
- [Browser API assembly](../src/renderer/bridge/ws-bridge.ts)
- [Browser fallback API](../src/renderer/bridge/stubs.ts)
- [Desktop control dispatch](../src/renderer/canvas/Canvas.tsx)
- [Settings command rules](../src/shared/settings-verb.ts)
- [Relay access policy](../src/core/relay/access-policy.ts)
- [Hosted team contract](hosted-team-relay.md)
- [Live Links contract](live-links.md)
- [Server deployment and behavior](SERVER.md)
