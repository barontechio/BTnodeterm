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

Browser upload/download and SSH media capabilities currently report unavailable. Remote transcript,
context/usage/memory bindings, setup/worktree automation and development-server forwarding remain
separate delivery gates in [the parity plan](server-capability-parity-plan.md). They must use the
remote target or report unavailable; a matching local pathname is never evidence of remote data.

Validation uses temporary HOME, data directories, tmux namespace and a loopback SSH server. Both
OpenSSH and the native transport exercise encrypted-key prompts, wrong-tab rejection, quoted file
writes/reads and reconnect. Production hosts and real account credentials are outside these tests.
