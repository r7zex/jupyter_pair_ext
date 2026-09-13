# Pair Notebook 0.5.29 connection recovery validation

Production change: `eb593d5` on `codex/connectivity-recovery-v0.5.29`.
Baseline: 0.5.28, `7c9707b67051f6c0f7eb29bbf2a77f03f15ec266`.

The diagnosis and implementation are recorded in
[CONNECTIVITY_RECOVERY_ROOT_CAUSE.md](CONNECTIVITY_RECOVERY_ROOT_CAUSE.md).
The second computer's failure without an explicit proxy is accounted for by
removing the shared public-relay startup veto and adding independent discovery;
its exact external failure is still not established from remote measurements.

## Completed checks

| Check | Result |
| --- | --- |
| `npm.cmd run artifacts` | Passed: lint, compile, 546 tests, source preflight, VSIX and ZIP validation |
| Python bridge unit tests | 7 passed |
| `npm.cmd audit --omit=dev` | 0 vulnerabilities |
| Native transport package validation | All 7 packaged binaries verified by SHA-256 against build manifests; package archives checked against lockfile SHA-512 integrity |
| Independent public Iroh mesh | Passed in two processes with Nostr, MQTT and WebRTC unavailable: 3 ordered frames, 524,297 bytes |
| 0.5.29 host / 0.5.28 guest | Public connection and data round trip passed |
| 0.5.28 host / 0.5.29 guest | Public connection and data round trip passed |
| Windows / VS Code stable Extension Host | 23 passed, 1 existing skipped test |
| Linux / VS Code stable Extension Host | 23 passed, 1 existing skipped test |
| macOS / VS Code stable Extension Host | 23 passed, 1 existing skipped test |
| Linux / VS Code 1.95.0 Extension Host | 23 passed, 1 existing skipped test |

The four real Extension Host runs, including native Iroh loading and endpoint
binding, are recorded in [GitHub Actions run 34742343149](https://github.com/r7zex/jupyter_pair_ext/actions/runs/34742343149).
The existing skipped test is issue #19 (genuine local typing during the 100 ms
post-projection quarantine). This connection release does not change that editor
behavior. A green run must not be represented as fixing that separate issue.

The installed local VS Code refused the E2E launch with "Code is currently being
updated." The clean GitHub-hosted Windows run supplies the Extension Host proof;
the user's installed profile was not modified or claimed as validated.

## Regression coverage added

- Failed startup releases the actual command gate while a warning remains open.
- Pending failed cleanup cannot keep that gate indefinitely; late completion
  does not clear a newer runtime.
- Explicit cancellation contains late startup failures and prevents delayed
  filesystem work from opening a transport after cancellation.
- Snapshot discovery can be cancelled and retried in the same destination,
  with scratch data removed after the disk queue drains.
- Secondary discovery starts while emergency readiness is pending or failed.
- Relay startup failures, unwritable handshake sends and exhausted known-peer
  retry budgets do not permanently disable independent paths.
- Native QUIC transfers ordered data, reconnects after endpoint replacement,
  rejects oversized frames, wrong tokens and mismatched pinned identities.
- HTTPS address records require a valid Ed25519 signature, expected record name,
  bounded size and timestamp before their addresses are used.

## Operational limits

Both computers need 0.5.29 to use Iroh. Older versions retain their shared legacy
paths. No additional application, daemon, compiler, account or runtime download
is needed on supported native platforms.

A selected application proxy remains authoritative. An unreachable endpoint is
reported explicitly; it is not silently bypassed. The unavailable localhost
proxy found during the original audit is an environment configuration issue,
so it must be made reachable or deliberately corrected by its owner. Iroh is
disabled under an application proxy because its native binding cannot apply it;
operating-system VPN/TUN routing remains available without that application
override.

No physical Russia-to-Germany acceptance or representative 99% success-rate
measurement has been performed. Public Iroh, Nostr and MQTT services remain
external availability dependencies. Production relay capacity and measurements
across the intended providers, VPN modes and failure conditions are still needed
before claiming the requested connection-success SLO.

The dirty original checkout was preserved. Changes were made in an isolated
worktree. CRDT, editor synchronization and the wire protocol were not changed.
