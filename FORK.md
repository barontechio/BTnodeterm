# BTnodeterm fork

A fork of [nodeterm](https://github.com/eneskirca/nodeterm), focused on the **Server Edition**,
with its own features kept apart from upstream code so each upstream release merges cleanly.
The current upstream base is the `UPSTREAM_BASE` constant in `src/bt/shared/fork.ts`.

## Branches and remotes

| ref | what it is |
|---|---|
| `upstream` remote | `https://github.com/eneskirca/nodeterm.git`, read-only |
| `bt/main` | the fork: upstream release tag + fork commits. Default branch for fork work |
| `bt/sync-<tag>` | short-lived branch that merges one upstream tag, reviewed and then fast-forwarded into `bt/main` |
| `main` | mirrors upstream `main`. Do not commit fork work here |

Sync **release tags** (`v0.4.6`, …), not upstream `main`: tags are tested and the base is stated.
Always **merge**, never rebase, `bt/main`: a rebase rewrites every fork commit on each sync.

```sh
scripts/bt/sync-upstream.sh v0.4.6          # merge, bump UPSTREAM_BASE, typecheck, run the fork tests
git switch bt/main && git merge --ff-only bt/sync-v0.4.6
```

The script turns on `git rerere`, so a seam conflict resolved once resolves itself the next time.

## Where fork code goes

```
src/bt/
  shared/    pure types + constants, usable from every layer (no node builtins, no runtime core imports)
  core/      Electron-free services behind CorePlatform — booted by BOTH Desktop and Server
  server/    Server Edition-only glue
  main/      Desktop (Electron) only glue
  renderer/  UI (typechecked by tsconfig.web.json)
scripts/bt/  fork tooling
```

A feature is a `BtExtension` (`src/bt/shared/extension.ts`) added to `BT_EXTENSIONS`
(`src/bt/core/registry.ts`). It gets the shell's `CorePlatform`, the edition and a private data dir
`<userData>/bt/<id>`, and registers RPC channels named `bt:<id>:<verb>`. **Default to `src/bt/core`
and run on both shells**; use `editions: ['server']` only for a feature that cannot work on the
desktop. A failing extension is logged and skipped, never fails the upstream boot.
`src/bt/core/info.ts` (`bt:info:get`) is the reference example.

Fork code may import upstream modules freely. Upstream code reaches fork code **only through the
seams below**, which `src/bt/boundary.test.ts` enforces.

## Seams (the only upstream files the fork edits)

| file | change |
|---|---|
| `src/server/main.ts` | `startBtServer()` after `startServer()`; `bt.stop()` before `close()` |
| `src/main/index.ts` | `startBtDesktop()` at the top of `app.whenReady()` |
| `vitest.config.ts` | `src/bt/**/*.test.{ts,tsx}` in `include` |
| `tsconfig.node.json`, `tsconfig.web.json` | `src/bt/...` in `include` |
| `CLAUDE.md` | one pointer to this file under the title |

Each line is marked `BT fork`. Keep them one line where you can. A new seam (a renderer mount, a
bridge member) is a decision: add it to this table and to `SEAMS` in `src/bt/boundary.test.ts`.

## Upstream first, or fork only?

Decide before writing code.

**Propose upstream** (a PR to `eneskirca/nodeterm`):
- bug fixes, above all in the Server Edition: a fix kept only here is a patch carried on every sync;
- Server Edition improvements anyone could use (configuration, deployment, performance, bridge
  stubs that do nothing today);
- small extension points that are useful on their own (e.g. a boot/stop hook in `startServer`):
  each one upstream accepts is a seam we no longer carry.

**Keep in the fork** (`src/bt/`): integrations and workflows specific to us, branding, and the
`src/bt` extension loader itself.

**Workflow for an upstream candidate**
1. Branch from `upstream/main`, not `bt/main`: `git fetch upstream && git switch -c up/<topic> upstream/main`.
2. Follow upstream's rules (`CONTRIBUTING.md`, root `CLAUDE.md`): logic in `src/core` behind
   `CorePlatform`, a decision for Desktop / Server Edition / mobile, tests, PR text per their rules.
3. Open the PR on `eneskirca/nodeterm`. Contributions are accepted under BUSL-1.1: send nothing
   you want to keep proprietary.
4. Meanwhile carry it here: `git switch bt/main && git cherry-pick -x <commits>`, then reword the
   message to start with `upstream-patch: <topic> (upstream PR #N)`.
5. When a synced upstream tag contains it, the merge absorbs it (resolve in upstream's favour). If
   upstream rejects it, move it into `src/bt/` as an extension or keep it as a documented patch.

`git log --oneline --grep '^upstream-patch:' bt/main` lists what the fork still carries.

If a fork feature needs a change inside upstream code (a bug fix, a missing hook), prefer
proposing it upstream; carry it here only as a small, separate commit titled `upstream-patch: …`
so it is easy to drop once upstream ships it.

## License

nodeterm is BUSL-1.1 (`LICENSE`). Its Additional Use Grant does not cover a build whose license
key, entitlement or usage-limit checks were moved, changed, disabled or circumvented. Fork work
must leave those checks intact.
