# Server 0.5.0-bt.1 preparation

This is a fork Server candidate based on accepted source `3d1b932a53786e56f7ca1cdb4904d2a2ea53ddfe`, including upstream v0.5.0 and upstream main `a03473354ed486003dd8e35be112d7f3a4b0cc6c`. It is prepared separately from the existing integration draft PR #2. No tag, public release, production deployment or restart is part of preparation.

## Changes compared with upstream v0.5.0

- Shared Core canvas geometry, board queries/assignment and verified comment delivery.
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

The accepted source passes Linux 25,931 tests / 82 skips, Windows 1,107 / 31 skips, types, Desktop/Server builds and all five source PR checks. Linux run 42014009276 attempt 1 failed in legacy plain worktree removal; the single rerun at the same SHA passed. The cause was not proved. Focused reviews and runtime probes close the source P1/P2 findings. These are source results, not certification of provider delivery or notification display on an OS/device. HTTPS/provider enrollment and real-device acceptance remain operator work.

## Build and package

Use a new checkout with its own dependency tree. The build host must satisfy package.json engines and have npm, GNU tar/gzip, a C/C++ toolchain, make and Python for node-pty. Never run Electron rebuild against another checkout or a live service's dependencies.

```sh
npm ci --ignore-scripts
node scripts/patch-node-pty.mjs
node scripts/patch-smart-whisper.mjs
npm rebuild node-pty smart-whisper esbuild
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
