# Server parity security review

Reviewed against fork integration PR #2, CodeQL check 123838127390 (2026-10-30).

The preview-source report (`js/file-system-race`, alert 1) pointed to a path stat/access before
open in `HeadlessNodeFactory.showFile`. Validation now opens once with nonblocking/no-follow flags,
checks that descriptor and its current named identity, and reads media signatures through the same
handle. The handle closes on every result. Real filesystem tests replace the name after open and
verify refusal, no saved node and a closed descriptor; final symbolic links are also refused.
The alert is left open for the next CodeQL analysis to verify the source fix.

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
