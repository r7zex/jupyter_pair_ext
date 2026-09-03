# Pair Notebook Host Authority and VPN Continuity Plan

Status: approved for implementation; implementation changes are not yet published.

Target: the next release candidate after `0.5.7`.

## Product contract

- The session host is the only compute executor and accepts cell execution from every authenticated session participant.
- Remote-compute consent, CPU/GPU sharing permission, and participant-selected executor controls do not exist.
- Host authority changes only through the authenticated voluntary host-transfer protocol initiated by the current host.
- A participant must never promote itself after heartbeat, route, signalling, VPN, proxy, or process failure.
- A transient network or VPN route change keeps the current session alive while authenticated routes recover automatically.
- If the host remains unreachable after the bounded recovery period, guests leave the active runtime without deleting their isolated working copy or recent-session reconnect entry.
- Host-owned persistence, signed peer identities, invite authentication, file barriers, and safe host-folder materialization remain enforced.

## Ordered implementation

### P0. Enforce single-host authority

1. Remove automatic host election from heartbeat and disconnect handling.
2. Accept a new host clock only as the result of the existing authenticated prepare/commit/finalize transfer initiated by the current host.
3. Reject self-promotion, equal-epoch partition winners, and unsolicited higher host epochs.
4. On unrecoverable host loss, close the guest runtime cleanly, keep its working copy, and retain a reconnectable recent-session record.
5. Add regression tests for asymmetric partitions, stale host announcements, abrupt host loss, voluntary transfer, and reconnecting to the same host.

### P0. Make host execution unconditional for authenticated participants

1. Normalize every notebook compute target to the current host and migrate restored descriptors away from participant executors.
2. Remove session-scoped remote-compute consent and CPU/GPU sharing gates from execution barriers, kernel commands, presence, settings, commands, and dashboard actions.
3. Keep Python environment and CPU/GPU device selection host-local; guests may run cells but may not redirect execution to their own computer.
4. Preserve request authentication, file synchronization barriers, idempotency, resource limits, interrupt/restart handling, and sanitized failures.
5. Add host/guest tests proving that any authenticated guest can execute immediately while malformed, stale, or non-host targets remain rejected.

### P0. Preserve sessions across VPN and proxy route changes

1. Detect a changed local network/proxy fingerprint while a session is active.
2. Refresh Windows system-proxy configuration and signalling sockets automatically without tearing down healthy authenticated data routes.
3. Treat failed or stale half-open routes as recovery candidates using inbound freshness and bounded ping failure evidence instead of connection-object existence alone.
4. Rebuild direct and encrypted emergency-relay routes make-before-break, retain queued synchronization/execution frames, and suppress participant removal during the recovery window.
5. Add deterministic tests for one-sided route loss, half-open sockets, VPN fingerprint changes, relay replacement, queued frame delivery, and recovery without a host-role change.

### P1. Make disconnection and reconnect behavior explicit

1. Distinguish `reconnecting` from terminal `host-unavailable` in runtime and dashboard state.
2. Remove stale online participants once route recovery is conclusively exhausted.
3. Ensure a guest that leaves after host loss can reopen the existing recent session and retry the pinned host identity without re-entering project or folder information.
4. Add UI/state tests for recovery, terminal exit, recent-session retention, and successful re-entry.

### P1. Add a Karing and Happ setup guide to the extension description

1. Add a Windows guide to `README.md`, which is rendered as the VS Code Marketplace description.
2. Link only official Karing and Happ download/documentation sources.
3. Document two supported configurations:
   - preferred: TUN mode, which covers VS Code and extension-host traffic automatically;
   - fallback: enable the application's HTTP/SOCKS or Windows system proxy and set `pairNotebook.proxyUrl` when automatic discovery is unavailable.
4. Include connection order, Reconnect/diagnostics steps, common conflicts, and a warning not to expose proxy listeners to a LAN unless intentionally required.
5. Avoid claiming that any third-party VPN or public relay can provide an absolute availability guarantee; define the observable readiness checks instead.

### P1. Validate and publish only the complete result

1. Run focused authority, execution, VPN-switch, route-recovery, recent-session, and dashboard tests.
2. Run the full TypeScript test suite, lint, compile, Python bridge tests, production dependency audit, artifact preflight, VSIX inspection, and source-archive inspection.
3. Build the next local release candidate and verify that packaged behavior and documentation match the source.
4. Update this plan with completed status and concrete validation evidence.
5. Delete `docs/known-networking-issues.md` and remove all live documentation references to it only after every implementation and validation item above is complete.
6. Publish the complete implementation in one final GitHub push. Do not publish intermediate implementation commits.

## Publication boundary

- First GitHub push: this plan only.
- Intermediate implementation: local commits only.
- Final GitHub push: all completed implementation commits, validation evidence, versioned release-candidate metadata, and deletion of the obsolete problem collection.
- No tag, GitHub Release, Marketplace publication, or modification of Trusted Access/TAC without a separate explicit request.

