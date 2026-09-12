# Connection startup and retry recovery

Baseline: v0.5.28 (`7c9707b67051f6c0f7eb29bbf2a77f03f15ec266`).
Date: 2026-09-13. Recorded before implementation.

## Reported incidents

Creation and joining fail on both v0.5.23 and v0.5.28. After the first error,
another attempt can be rejected as already restoring. The user also reproduced
creation failure on another computer without an explicitly configured proxy.
The unavailable localhost proxy found on the first computer is therefore one
confirmed environmental cause, not an explanation of every incident.

## Confirmed defects

1. `restoreWorkspaceSession` awaits the local-route warning before clearing the
   runtime reference and completing `workspaceSessionRestore`. An unresolved
   warning blocks Start/Join after the transport has already failed. Both
   affected tags reproduce this with their actual production control flow.
2. Failed-start cleanup is awaited without a bound. A pending cleanup operation
   also keeps the same startup ownership. Startup progress cannot be cancelled.
3. `MeshTransport.start` requires emergency Nostr/MQTT readiness within 15 seconds
   before starting secondary MQTT discovery. A failure of the emergency paths
   aborts creation and prevents an otherwise independent discovery attempt.
4. Proxy selection, public relay availability and peer reachability are distinct
   conditions, but the startup UI reduces them to an aggregate relay error.
5. Public testing brokers and the absence of built-in TURN capacity cannot
   establish the requested 99% connection-success objective. The two public
   discovery families still share proxy and network failure modes.

The exact external failure on the second computer remains unverified without
its diagnostics. The repair must handle unreachable public services with and
without a proxy, rather than treating proxy removal as the product fix.

## Implementation boundaries and acceptance

- Release failed-attempt ownership independently of notification lifetime;
  isolate late completion from newer attempts and provide explicit cancellation.
- Preserve the decision that a fixed startup duration is not an automatic
  established-session exit. Cleanup bounds must not restore that policy.
- Start independent discovery/data paths independently. Keep verified readiness
  and accurate degraded status; never claim that an uncontacted host is connected.
- Evaluate bundled Iroh as an additional path independent of Nostr/MQTT, using
  existing authenticated participant identities and application frames. Preserve
  CRDT, notebook/editor synchronization, and host authority.
- Keep configured proxy routing explicit. Do not silently bypass a user proxy.
- Verify repeat attempts, unavailable relay families, no-proxy startup, cleanup,
  old/new compatibility, authentication, and package-contained native assets.
- Run the repository release gate, Python bridge tests, dependency audit, real
  Extension Host tests and appropriate public-network smoke tests before release.
- Publish verified VSIX and complete ZIP. Do not claim physical two-country or
  99% reliability acceptance from local/process tests.

## Independent transport evidence

Iroh provides encrypted QUIC with relay fallback over outbound TCP 443. Its
official Node package supplies prebuilt Windows x64/ARM64 binaries and requires
Node 20.3 or later. npm metadata currently reports `@number0/iroh` 1.1.0.
The binary must ship in the VSIX; users must not install a daemon or compiler.

Sources: [JavaScript bindings](https://docs.iroh.computer/languages/javascript),
[relay design](https://docs.iroh.computer/concepts/relays),
[network requirements](https://docs.iroh.computer/about/faq).

Public default relays are development infrastructure, not a service-level
guarantee. A production 99% objective still requires representative network
measurements and sustainable relay capacity.
