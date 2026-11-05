# Server 0.5.0-bt.1 preparation

This is a fork Server candidate composed from source `29cefa4e9b1c236e2eb93e97d5630b29d222ec69` (dynamic groups PRs #7 and #8) and the reviewed Server packaging preparation `9315f15bfacbab075de71886dc6ff50576ad9350`, including upstream v0.5.0 and upstream main `a03473354ed486003dd8e35be112d7f3a4b0cc6c`. It updates the existing release draft PR #6. No tag, public release, production deployment or restart is part of preparation. Earlier archives remain historical evidence and do not contain dynamic groups.

## Changes compared with upstream v0.5.0

- Shared Core canvas geometry, board queries/assignment and verified comment delivery.
- Dynamic nested groups, deterministic space reservations and atomic reservation consumption; retiring a frame preserves its terminals and surviving links. See [Dynamic agent groups](dynamic-agent-groups.md).
- Headless teams, reviews and dependencies; owner confirmations and allowed settings updates.
- Worktree creation/binding/unbinding, guarded recovery and clean removal; missing editor/diff text remains copyable for its mounted lifetime.
- Verified local POSIX tmux Claude conversation branching and confirmed terminal writes for supported identities.
- Managed Codex accounts and host-scoped SSH inventory, projects, files, Git, setup, histories, context meters and transfers (SSH is operator opt-in).
- Browser images, audio/video, isolated static HTML and optional development gateway; browser team joins, AI names and transcript search.
- Open-page notifications and optional closed-page Web Push, with generic encrypted alerts and fresh click validation.
- Concurrency, session identity, file access and focus corrections; existing license, role and Live Links checks remain in force.

The four upstream changes after v0.5.0 are separate from fork improvements: announcement images; omission of announcements whose image is missing; Notch recency/hover improvements; and `~` breadcrumb navigation.

E23, coordinated ordinary-agent restarts/account switching, private mobile apps and new upstream submissions are excluded. Existing compatibility-flow account-switch notices describe acknowledged and uncertain effects; they do not add coordinated restart or verified conversation resumption.

## Web Push activation and limits

Web Push is optional and off by default. An operator must configure a stable dedicated HTTPS origin, valid VAPID contact and exact approved public provider origins; the owner then explicitly enrolls a supported browser for one local project. Do not copy sample addresses into production. See [Web Push](web-push.md) for configuration, private store backup, consent and revocation rules.

Historical source `3d1b932a` passed Linux 25,931 tests / 82 skips, Windows 1,107 / 31 skips, types, Desktop/Server builds and all five source PR checks. Its Linux run 42014009276 attempt 1 failed in plain worktree removal; the single rerun at the same SHA passed without a proved cause. Dynamic-groups source `29cefa4e` has a separate Linux failure in that test (run 42045205168: 26,090 passes, one failure, 82 skips); its other four checks passed. Neither result certifies this release composition. The release handoff must record fresh exact-head CI and any diagnosed correction, preserving failed-run history. HTTPS/provider enrollment and real-device notification acceptance remain operator work.

## Canvas control and client compatibility

Canvas control is opt-in. Start the extracted package with the operator's private data directory:

```sh
NODETERM_SERVER_CANVAS_CONTROL=1 \
NODETERM_SERVER_CONTROL_SCOPE=project \
NODETERM_DATA_DIR=/absolute/private/operator-data \
./start-server.sh
```

`project` scope lets a verified agent control eligible nodes in its own project even when it did not create them. Omitting the scope keeps the original `creator` default. Scope does not waive identity, capability, worktree, execution or account checks. See [Server operation](SERVER.md) for authentication and scope details.

Every connected broadcast client must advertise a mounted atomic batch receiver before a group batch can be applied. An older client causes a named refusal before any mutation; reconnect it using the updated build. Reservations persist layout data and consumed/released tombstones, never execution or restored creator authority. Test both the explicit project-scope flags and the unchanged creator default against the extracted release archive.

## Build and package

Use a new checkout with its own dependency tree. The build host must satisfy package.json engines and have npm, GNU tar/gzip, a C/C++ toolchain, make and Python for node-pty and smart-whisper/whisper.cpp. Never run Electron rebuild against another checkout or a live service's dependencies.

```sh
npm ci --ignore-scripts
node scripts/patch-node-pty.mjs
node scripts/patch-smart-whisper.mjs
CFLAGS=-D_GNU_SOURCE npm rebuild node-pty smart-whisper esbuild
npm run typecheck
npm run build
npm run server:build
npm run server:package -- --output /absolute/private/artifacts
```

The packager supplies renderer, Server, session host, standalone Codex relay, required resources, production runtime dependencies, license, version/commit/lock metadata, dependency inventory and checksums. It never copies user data or credentials. Native dependencies are built separately for ordinary Node. Artifact names identify the actual OS, architecture and Node ABI; an ARM64 package is not x64 or universal. The runtime Node version/ABI is recorded in the manifest; use that Node version and compatible glibc on the destination, plus tmux, git, curl and CA certificates. Speech native binaries are compiled and load-tested; model download and actual transcription require separate operator validation.

Run the extracted package as an ordinary user with a private data directory. Preserve existing production data/home/project mounts and custom bootstrap integration in any later deployment. Do not run the source install-server.sh as a way to try the candidate: it can install/update/restart a service. The archive is Server-only and contains no signed/notarized Desktop Mac or Windows installer. Fork update delivery remains `nodeTermUpdates=disabled`; license enforcement is unchanged.

## Acceptance gates

Before publication, require exact release-commit CI (types, default Linux suite, Windows tests, both builds, dependency review and CodeQL), independent packaging review, archive checksum/manifest inspection and a real start from the extracted archive using private HOME/data/TMP/tmux namespace and loopback ports. Verify the authenticated UI, package version and authenticated workspace RPC, default-off push and shutdown; preserve smoke evidence outside the package. Source review does not replace these gates. No claim of zero security alerts is made.

The release handoff records concrete archive path, bytes, SHA256, commit, platform/runtime, smoke results, check URLs and outstanding gates. ROOT reviews that concrete handoff before deciding publication. Deployment additionally requires the actual service/container manager to be identified and operator Web Push configuration/device acceptance if enabled.
