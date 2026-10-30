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
