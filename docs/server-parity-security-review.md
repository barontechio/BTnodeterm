# Server parity security review

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
