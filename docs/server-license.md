# Server licensing and Live Links

Enable host-bound licensing with `NODETERM_SERVER_LICENSE=1` or `--license`. It is disabled by
default. A disabled installation performs no license polling and exposes its disabled capability
to the owner UI. Settings → License explains the host setting instead of offering an unavailable
checkout. A second Server process sharing a data directory starts neither licensing nor link hosting.

The license belongs to the server installation. Checkout opens in the authenticated owner's
browser, carrying the server's stable device identity; manual key activation also uses that identity.
The shared core verifier preserves signed, device-bound entitlements, expiry, clock-rollback checks
and offline grace. `license.json` is published atomically with owner-only permissions. License
mutations serialize, late replies cannot save after owner departure, and shutdown aborts requests
and stops polling. An existing device identity is retained; new identities are durably created
before any consumer can ask for them again.

Live Links uses the same service, backend API, Pro gate and owner controls as Desktop. No Pro
entitlement means `not-entitled`, with no link created. Relay peers cannot administer licenses or
mint links. The browser shows its own host's LIVE chip and management controls. Link revocation
and viewer shutdown keep the existing lifecycle and persistence rules.

The browser must allow the checkout window. It is opened during the click, separated from its
opener, and navigated only after the host returns an HTTPS checkout URL. A refused or failed request
closes the unused window and reports the error. Mobile store activation through Desktop pairing
still requires the supported Desktop/mobile flow; Server does not claim that route.

Tests use temporary installation directories and mocked license endpoints, never real payment
transactions. The real Server boot fixture proves capability negotiation and rejection of Live Link
creation without an entitlement. Core fixtures cover verification, expiry, cancellation, simultaneous
activation/deactivation and atomic write failures; browser fixtures cover checkout and Pro gating.
