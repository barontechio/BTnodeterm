# Server SSH projects

SSH is optional. Set `NODETERM_SERVER_SSH=1` or start with `--ssh-projects` to enable connections.
The authenticated owner manages saved servers in Settings → Remote (SSH) and creates a project
with New remote. The server user supplies SSH keys, config, known hosts and paths. The browser's
own SSH configuration and filesystem are not used. Saved inventory remains editable while the
transport is disabled; no SSH process, private agent or watchdog starts until a connection is requested.

The native and Server shells use the same core project manager, filesystem operations, private
agent, askpass handling and integration-consent rules. Secret answers belong to one attached owner
UI lifetime and are never stored in workspace/settings or broadcast to other clients. Relay peers
cannot manage SSH, access its filesystem RPC or answer passphrase requests.

This adapter supports connection/status, remote browsing and editing, workspace reconciliation,
managed remote account operations and per-owner Git selection. Each Git request captures the
selected project; a later tab/project switch cannot redirect it. Disconnect, target edits and
connection replacement refuse stale work. Shared delayed workspace writes validate the destination
again, and SSH exec checks the connection generation after waiting for its transport slot.

Authenticated owners can read Claude conversations from connected SSH projects through the chat
panel and its find bar. The saved node selects the endpoint, runtime session and managed account;
request-supplied paths cannot redirect a read. A managed account never falls back to the system
account. Unsupported agents, disconnection, changed targets and failed reads remain unreadable,
never a local scan or evidence that the conversation is absent. Relay and guest readers are refused.

This optional reader requires Python 3 with POSIX directory-descriptor and no-follow support on the
remote host. Nodeterm neither installs it nor writes a helper file. One command opens the selected
account tree and transcript with verified descriptors, rejects links/ambiguous sessions, rechecks
named identities and returns a bounded byte window (at most 5 MiB plus one lookbehind byte).
Discovery examines at most 4,096 project entries; unreadable/missing roots and exceeded budgets
are unknown, not a clean miss. Python/runtime and unsafe-tree refusals have actionable panel copy.
Requests expire after 30 seconds, with at most 32 active reads and two per node; owner departure
cancels queued work, and already dispatched work retains its slot until the transport settles.

On Linux arm64/Node 22.23.3, a local command benchmark reading a 256 KiB window from a 1 MiB
transcript measured median 17.89/18.87/44.42 ms for 1/128/4,096 project entries. The existing
Desktop POSIX reader with an already known pathname measured 3.00/2.93/3.15 ms. These are warm-cache
command/filesystem costs, ten samples after two warmups, excluding SSH latency; concurrent
validation was running. The strict discovery cost buys verified account/file selection and is
currently paid only on demand, with no new idle polling. It is not a host/network latency promise.

Browser upload/download and SSH media capabilities currently report unavailable. Context/usage/memory
bindings, remaining agent readers, setup/worktree automation and development-server forwarding remain
separate delivery gates in [the parity plan](server-capability-parity-plan.md). Read-only histories
do not authorize remote terminal control. Remote services must use the current remote target or
report unavailable; a matching local pathname is never evidence of remote data.
Context rehydration and raw-hook tail setup also refuse known remote records before any local
locator or replay. A node whose routing becomes remote releases its earlier local tails.

Validation uses temporary HOME, data directories, tmux namespace and a loopback SSH server. Both
OpenSSH and the native transport exercise encrypted-key prompts, wrong-tab rejection, quoted file
writes/reads, managed-account transcript isolation, guest refusal, disconnection and reconnect.
Production hosts and real account credentials are outside these tests.


## Owner Codex conversation pages

With SSH explicitly enabled, connected saved Codex nodes expose paginated conversations through
`chatReadTranscript` and the existing browser bridge. The Server uses the same Codex window parser
as Desktop. Claude-shaped history/search and existence calls do not read Codex data.

The host selects the remote system account's login `CODEX_HOME` or the canonical hashed private
home of the saved, non-pending managed account on that endpoint. No browser-supplied file path or
account hint can redirect discovery. An optional remote Python 3/POSIX helper opens directories
without following symlinks, scans at most 4,096 entries under `sessions/YYYY/MM/DD`, refuses duplicate
matches and verifies the first `session_meta.payload.id`. Missing roots and failed transport are
unreadable; only a completed empty scan is absence. A page transfers at most 5 MiB plus lookbehind,
with the existing 30-second, 32-per-reader and two-per-node request bounds. Codex and Claude readers
have separate pools. Unavailable Python, unusual/symlinked trees or larger catalogs degrade to an
unreadable page. Archived rollouts are not searched. Existing hosts without this adapter remain
explicitly unsupported. No new RPC, capability grant, implicit connection or remote installation
is introduced.

Owner disconnection, RPC completion, account or harness changes and connection replacement revoke
the read. This owner-only API does not authorize agent context links, quota access or background
meters; those require separate adapters. Real encrypted-key loopback tests exercise the OpenSSH
and native transports with managed-account Codex pages and wrong-owner refusal.


## Agent context links without an open tab

Connected Claude and Codex nodes can provide bounded transcript/summary context over the existing
context-link hook route. The Server derives directed edges from saved canvases; an agent must
present its valid per-node identity token as well as the hook bearer. Legacy/foreign unverified
callers retain existing local behavior but cannot use the new remote reader. Owner chat permission
is independent and never substitutes for that agent proof.

Each request binds the caller's unique project, saved/effective session, harness, selected account
and (when remote) endpoint/generation. It verifies the target against the linked session/account,
rechecks the saved directed edge before queued execution and after IO, and revokes on link-map
publication, cancellation, timeout or completion. An unrelated link-map update can conservatively
refuse an in-flight remote read; a fresh request uses the new map. Normal POST-body completion is
not cancellation. No detached continuation retains authority and no browser tab is required.

The same strict Claude/Codex locator reads at most 2 MiB plus lookbehind, under the reader's
32-request/two-per-target concurrency and 30-second deadline. Shared context-link formatters render
the tail. Missing Python, unsupported harnesses, stale state and transport errors do not fall back
to local files. Remote terminal capture, subagent files and opencode export remain unavailable.
