# Pair Notebook networking problem pool

This file is the single living source of truth for networking defects, architectural
limitations, diagnostics gaps, and validation gaps. Update it after every independently
completed fix. Do not mark physical validation as passed unless the exact two-computer
scenario was run after that fix.

## Incident and acceptance target

Observed on two physical Windows computers in Russia:

- computer A could start a session while Karing TUN/VPN was active and the host was
  behind VPN/NAT;
- computer B could not join, with or without its own VPN;
- ordinary internet access remained available on both computers.

The observation is a real product failure. It proves the end-to-end acceptance scenario
failed, but it does not by itself identify which stage failed. The required acceptance
path is:

`Start -> discovery -> signed identity handshake -> authenticated route -> snapshot bootstrap -> runtime sync -> bidirectional edits -> reconnect`

Direct WebRTC may fail in this scenario. The session as a whole must not fail merely
because direct WebRTC is unavailable.

Overall physical validation: **FAILED**

## Evidence policy

| Level | Meaning |
| --- | --- |
| A | Proved by the current implementation or locked dependency source. |
| B | Proved by a deterministic unit or integration test. |
| C | Proved by a live test whose processes ran on one computer. |
| D | Proved by two physical computers on the target networks. |
| E | Claimed only by documentation or release notes. |

A simulation is never promoted to level D. Existing README, CHANGELOG, and historical
audit statements are leads, not proof.

## Research snapshot

Research branch: `codex/networking-root-cause-repair`

Installed dependency versions examined:

| Component | Installed version | Relevant behavior |
| --- | ---: | --- |
| `trystero` / `@trystero-p2p/core` / `@trystero-p2p/nostr` | 0.25.3 | Explicit `relayConfig.urls` uses the entire list; default ICE is Google/Cloudflare STUN plus optional `turnConfig`; Nostr sockets reconnect with backoff and resubscribe. |
| `werift` | 0.24.4 | Its ICE parser retains only the first STUN server and the first TURN server entry it recognizes. TURN gathering also requires server, username, and password. |
| `mqtt` | 5.15.2 | Each client connects and subscribes to one broker; reconnect/resubscribe is per client. Independent public brokers are not one replicated topic space. |
| `ws` | 8.21.3 | Used through the proxy-aware WebSocket construction path. |
| proxy agents | `http-proxy-agent` 7.0.2, `https-proxy-agent` 7.0.6, `socks-proxy-agent` 8.0.5 | HTTP(S) and SOCKS proxy paths are available without disabling TLS verification. |

The project does not use `@trystero-p2p/mqtt`; `src/runtime/mqttRoom.ts` is a local
Trystero topic strategy built on MQTT.js.

## Current network path

1. `startSession()` refreshes network configuration, creates an isolated host working
   copy, stores a descriptor/token/private identity key, and opens that folder. Restored
   activation constructs `SessionRuntime`, whose `MeshTransport.start()` opens the
   transports.
2. `formatInvite()` includes the session/project identifiers, bearer token, host identity,
   session epoch, and pinned host public key. It contains no host IP address or listening
   port.
3. `joinSession()` refreshes network configuration, strictly parses the invite, creates a
   new peer identity, and calls `downloadProjectSnapshot()` before persisting/opening the
   joined project.
4. The primary signalling room is Trystero Nostr over nine fixed WSS relays. A local
   MQTT-over-WSS strategy runs additively over five fixed brokers. Both derive topics from
   the same app/session/token inputs.
5. Trystero negotiates direct WebRTC through werift. The default route has STUN but no
   production TURN unless the user configures valid TURN URLs and credentials.
6. In parallel, `RedundantFrameRelay` starts complete encrypted Nostr and MQTT data
   relays. Its readiness barrier succeeds when either local family completes an encrypted
   publish-to-self echo on at least one endpoint.
7. Emergency-relay announcements trigger a signed protocol-v4 handshake. Direct,
   MQTT-signalled WebRTC, upgrade-room WebRTC, and `relay:<peerId>` routes converge on the
   same identity admission map.
8. A joining peer requests one resumable file snapshot. After it is materialized, the
   normal runtime starts and performs application-level reconciliation.
9. Runtime direct-route loss gets a bounded logical recovery lease and immediately tries
   the emergency relay. Bootstrap route loss does not get that lease.
10. A network fingerprint change searches for a fallback or an improved route and is
    intended not to tear down an existing healthy route. Karing TUN is transparent packet
    routing; a disabled Windows system proxy does not prove TUN is inactive.

## Issue index

| ID | Priority | Status | Category | Confidence |
| --- | --- | --- | --- | --- |
| NET-P0-001 | P0 | BLOCKED | Architecture / connectivity | HIGH |
| NET-P0-002 | P0 | NEEDS-PHYSICAL-VALIDATION | Product bug / connectivity | CONFIRMED |
| NET-P0-003 | P0 | NEEDS-PHYSICAL-VALIDATION | Product bug / bootstrap | CONFIRMED |
| NET-P1-001 | P1 | OPEN | Architecture / route coverage | CONFIRMED |
| NET-P1-002 | P1 | OPEN | Product bug / observability | CONFIRMED |
| NET-P1-003 | P1 | INVESTIGATING | Product bug / reconnect | MEDIUM |
| NET-P1-004 | P1 | OPEN | Product bug / compatibility UX | CONFIRMED |
| NET-P2-001 | P2 | OPEN | Diagnostics gap | CONFIRMED |
| NET-P2-002 | P2 | OPEN | Test gap | CONFIRMED |
| NET-P3-001 | P3 | OPEN | Documentation | CONFIRMED |

## NET-P0-001 — No guaranteed common rendezvous or data endpoint

Status: BLOCKED

Priority: P0

Observed symptom:

The host can pass local transport startup while a guest on another network never
discovers or reaches it. This is consistent with, but not yet isolated as, the physical
incident.

Evidence:

- [A] `RedundantFrameRelay.waitUntilReady()` uses `Promise.any()` over the local Nostr
  and MQTT families.
- [A] `NostrFrameRelay.waitUntilReady()` and `MqttFrameRelay.waitUntilReady()` prove a
  local encrypted publish-to-self echo, not a host-to-guest exchange.
- [A] Nostr publishes and subscribes independently on each relay. The local MQTT strategy
  creates separate MQTT.js clients for separate public brokers. No client or service in
  this repository bridges those independent endpoint namespaces.
- [A] Trystero 0.25.3 uses all explicit Nostr relay URLs, while the local MQTT strategy
  attempts a deterministic broker subset. Reachability can still be asymmetric: each
  side may have at least one locally healthy endpoint without sharing one.
- [B] Existing tests prove local readiness and local failure handling; they do not model
  two sides with disjoint reachable endpoint subsets.
- [D] The target two-computer join failed, but no endpoint-by-endpoint capture exists to
  attribute that failure specifically to endpoint intersection.

Relevant files and symbols:

- `src/runtime/redundantFrameRelay.ts`: `waitUntilReady()`, `send()`
- `src/runtime/nostrRelay.ts`: `waitUntilReady()`, `publishRaw()`, `openSockets`
- `src/runtime/mqttFrameRelay.ts`: `waitUntilReady()`, `readyClients`, `publishRaw()`
- `src/runtime/mqttRoom.ts`: `MQTT_BROKER_URLS`, `joinMqttRoom`
- `src/runtime/mesh.ts`: `startRelayFallback()`, `TRYSTERO_RELAY_URLS`

Root cause:

Readiness is an existential local predicate: `host has some path` and `guest has some
path`. The required connectivity predicate is an intersection: `host and guest share a
working rendezvous/data path`. With unrelated public infrastructure and no controlled
bridge, the first predicate cannot prove the second.

Confidence: HIGH

Why this can affect Host-on-VPN:

Karing/VPN routing, ISP filtering, relay policy, DNS, and per-IP admission can produce
different reachable subsets on the two computers. NAT is irrelevant to WSS itself, but
asymmetric outbound routing is not.

Reproduction:

Model a host that can publish/subscribe only on Nostr endpoint A and a guest that can do
so only on MQTT broker B, with direct WebRTC and TURN disabled. Both local readiness
barriers can pass while no announcement or frame crosses between peers.

Required fix:

Provision and productize at least one controlled common rendezvous/full-data service on
a target-network-friendly WSS path, or another service that bridges the supported
families. A production TURN service may improve WebRTC coverage but does not replace
signalling discovery. Adding more unrelated public endpoints or a longer timeout is not
a guarantee. This issue is blocked on an infrastructure/operational decision and service
availability; it cannot be truthfully closed by client-only wording changes.

Regression test:

Add a two-sided asymmetric endpoint harness proving that disjoint public subsets cannot
complete, then prove that a configured common product endpoint completes discovery,
signed relay handshake, and bidirectional frames with direct WebRTC/TURN unavailable.

Acceptance criteria:

- both participants are configured with at least one production-controlled common path;
- local readiness identifies the usable family/endpoints without exposing secrets;
- the asymmetric harness completes only when an actual common path exists;
- failure is explicit when no common infrastructure exists;
- the target two-physical-computer scenario passes.

Fixed by commit:

Physical validation: FAILED

The overall scenario failed; attribution to this specific issue is not isolated.

## NET-P0-002 — Emergency relay routes use the wrong ownership and liveness model

Status: NEEDS-PHYSICAL-VALIDATION

Priority: P0

Observed symptom:

A live `relay:<peerId>` route can be classified as a dead ordinary Trystero peer and
retired while a duplicate signalling connection is being admitted.

Evidence:

- [A] `roomForTransport()` handles only `mqtt:` and `upgrade:` prefixes. A `relay:` ID
  falls through to the primary Nostr room with the prefixed ID unchanged.
- [A] `assertPeerCanJoin()` tests the incumbent through
  `activeOwner.room?.getPeers()[activeOwner.rawId]`; a relay connection never exists in
  that room map, so `roomPeerAlive` is false.
- [A] The same path then calls `retireIdentityRoute()`, which also closes only
  `this.room?.getPeers()[transportPeerId]` and deletes the active identity mapping.
- [A] `onPeerLeave()` and `pingTick()` likewise route `relay:` IDs through the ordinary
  room abstraction.
- [B] Route-upgrade tests cover the dedicated `upgrade:` room, not duplicate admission
  while an emergency relay is incumbent.
- [B] Regression tests now prove that a fresh authenticated relay incumbent survives
  late duplicate signalling and that stale or locally unavailable relay routes can be
  replaced without consulting or closing a primary-room peer.
- [C] The public emergency-relay live smoke passed all seven Nostr/MQTT/redundant
  combinations after the fix. Both processes still ran on one computer, so this is not
  physical target validation.

Relevant files and symbols:

- `src/runtime/mesh.ts`: `roomForTransport()`, `assertPeerCanJoin()`,
  `retireIdentityRoute()`, `onPeerLeave()`, `pingTick()`
- `test/network.test.ts`, `test/routeOptimization.test.ts`

Root cause:

The transport-owner resolver has no explicit emergency-relay owner. Code that is valid
for Trystero room peers is reused for a logical authenticated route carried by
`RedundantFrameRelay`.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

The target scenario is expected to fall back to the emergency relay. Late Nostr/MQTT
signalling or a reconnect can then destroy that working fallback before a replacement
route has been authenticated and promoted.

Reproduction:

Admit an authenticated relay route, keep it fresh, leave the primary room's `getPeers()`
map empty, then complete a second signed signalling handshake for the same identity. The
current code retires the relay mapping instead of deterministically preserving it.

Required fix:

Implemented: `roomForTransport()` now represents `relay:` as a logical `FrameRelay`
route with no Trystero room owner. Duplicate admission checks the actual owner, local
verified relay availability, and authenticated peer freshness. Route retirement closes
only a real owning-room peer and leaves explicit upgrades make-before-break.

Regression test:

Added `keeps a fresh emergency relay route during late duplicate signalling` and
`replaces a stale or locally unavailable relay route without closing a room peer` in
`test/core.test.ts`. Full suite: PASS, 303 tests. Lint and compile: PASS. Public
emergency-relay live smoke: PASS for seven Nostr/MQTT/redundant combinations.

Acceptance criteria:

- PASS: a fresh relay incumbent survives duplicate signalling;
- PASS: a stale or locally unavailable relay route can be replaced by a signed route
  from the same identity;
- PASS: room peer operations use only the room that owns that transport;
- PASS: route migration remains make-before-break;
- PASS: targeted, full, lint, compile, and relevant level-C live checks pass;
- PENDING: the target level-D two-physical-computer scenario.

Fixed by commit: `001b117`

Physical validation: NOT RUN

## NET-P0-003 — Snapshot bootstrap cannot recover across route replacement

Status: NEEDS-PHYSICAL-VALIDATION

Priority: P0

Observed symptom:

The guest may discover and authenticate the host but still fail Join when the direct
route drops or changes to the emergency relay during the initial project snapshot.

Evidence:

- [A, pre-fix] Runtime-purpose connections called `beginLogicalRecovery()` after active
  route loss; bootstrap-purpose connections immediately emitted `bootstrapDisconnected`.
- [A, pre-fix] The host `SessionRuntime` immediately rejected snapshot checkpoints on
  `bootstrapDisconnected`.
- [A, pre-fix] `downloadProjectSnapshot()` sent `snapshotRequest` only once because
  `requested` remained true and did not restart after an authenticated replacement.
- [A, fixed] Bootstrap and runtime routes now share the bounded identity recovery lease,
  while terminal disconnect events remain purpose-specific and recovering bootstrap peers
  remain excluded from the runtime participant projection.
- [A, fixed] Every request, data frame, checkpoint ACK, and file retry carries a
  `snapshotId`. The receiver ignores stale generations, preserves only hash-verified
  complete files, and closes/removes partial transfers before requesting a new generation.
- [A, fixed] `SessionRuntime` cancels only the active generation after an authenticated
  bootstrap route replacement and binds pending checkpoints/retry records to that
  generation.
- [B] The route-replacement integration test disconnects the physical route immediately
  after the first file-end delivery, authenticates a replacement, observes two distinct
  snapshot generations, verifies the completed-file resume hash, and verifies final bytes.
- [B] A separate relay-only integration test disables Trystero/WebRTC discovery and
  downloads the complete project through `NostrFrameRelay` and a local WebSocket relay hub.

Relevant files and symbols:

- `src/runtime/mesh.ts`: `onPeerLeave()`, `beginLogicalRecovery()`, `waitForRoute()`
- `src/runtime/bootstrap.ts`: `downloadProjectSnapshot()`, `requestSnapshot()`,
  `resetSnapshotGeneration()`, `activeSnapshotId`, snapshot checkpoints
- `src/runtime/session.ts`: `sendSnapshot()`, `awaitSnapshotCheckpoint()`,
  `cancelSnapshotGeneration()`, `activeSnapshotGenerations`
- `test/runtime.integration.test.ts`: route-replacement and relay-only bootstrap tests
- `test/network.test.ts`: purpose-specific bootstrap recovery lease test

Root cause:

Bootstrap is treated as a one-route, one-request transaction even though its protocol
already carries completed-file hashes for resume. Route recovery semantics are applied
only after the runtime session exists.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

ICE can appear briefly, fail after VPN/NAT candidate checks, or be superseded by the
relay. The most route-sensitive and data-heavy stage is the snapshot, so network
discovery can succeed while the user still experiences Join failure.

Reproduction:

Begin a multi-file bootstrap over a direct route, acknowledge at least one checkpoint,
drop that route, admit an authenticated relay replacement inside the recovery bound, and
observe that the current transfer is rejected or stalls rather than resuming.

Implemented fix:

Bootstrap now has an identity-scoped bounded recovery lease. After an authenticated route
replacement the receiver discards partial state, preserves complete hash-verified files,
and sends a new generation request. Host checkpoint and retransmission state is bound to
that generation, so delayed old frames cannot complete or corrupt the replacement.

Regression test:

Implemented: one relay-only full snapshot test with WebRTC discovery disabled, one
mid-transfer authenticated route-replacement test with completed-file resume, and one
bounded bootstrap lease test that verifies purpose-specific terminal disconnect behavior.

Acceptance criteria:

- bootstrap survives one authenticated route replacement within a bounded timeout;
- completed files are not retransmitted and partial files are safely restarted;
- host key pinning, purpose restrictions, transcript signatures, and path validation stay
  enabled;
- failure remains explicit after the recovery bound;
- targeted, full, lint, and compile checks pass.

Software validation:

- `npm test -- --grep snapshot`: PASS, 20 tests on 2026-08-31.
- Focused bootstrap recovery lease test: PASS on 2026-08-31.
- `npm test`: PASS, 306 tests on 2026-08-31; compile/bundle PASS in its first phase.
- `npm run lint`: PASS on 2026-08-31.
- Target two-physical-computer Host-on-VPN scenario: NOT RUN.

Fixed by commits: `356df91`, `0aac1f5`

Physical validation: NOT RUN

## NET-P1-001 — No built-in TURN route for restrictive NAT combinations

Status: OPEN

Priority: P1

Observed symptom:

Direct WebRTC can fail behind VPN NAT, CGNAT, symmetric NAT, or UDP policy. Without user
TURN configuration, the WebRTC layer has no relay candidate.

Evidence:

- [A] `DEFAULT_TURN_URLS` and exported `TRYSTERO_TURN_SERVERS` are empty.
- [A] `buildTurnConfig()` passes TURN only when valid custom URLs and credentials are
  configured.
- [A] Trystero 0.25.3 adds `turnConfig` to its default STUN list; STUN does not relay
  media/data.
- [A] werift 0.24.4 retains one TURN server and requires non-empty credentials before
  gathering a relay candidate.
- [E] Historical CHANGELOG entries that mention a free built-in TURN fallback describe an
  older design and conflict with the current code and current README.

Relevant files and symbols:

- `src/runtime/turn.ts`: `DEFAULT_TURN_URLS`, `parseTurnEndpoints()`
- `src/runtime/mesh.ts`: `TRYSTERO_TURN_SERVERS`, `buildTurnConfig()`
- `package.json`: `pairNotebook.turnUrls`, `pairNotebook.turnUsername`

Root cause:

TURN is an optional operator-supplied capability, not a production service owned by the
product. The emergency full-data relay is intended to cover this gap, so TURN absence is
not independently a P0 while a reliable common data relay exists.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

Host and guest may be unable to form any direct ICE candidate pair. That increases
dependence on the currently non-guaranteed common emergency path.

Reproduction:

Disable direct candidate reachability under two restrictive NAT profiles, leave custom
TURN unset, and inspect that no `relay` ICE candidate can be gathered.

Required fix:

Make an explicit product decision: operate a credentialed production TURN service with
safe credential rotation, or document TURN as optional only after NET-P0-001 supplies a
reliable full-data route. Do not restore dead anonymous demo credentials.

Regression test:

With a controlled test TURN service, verify a relay candidate and data-channel round trip
while direct candidates are blocked. Keep a separate test proving direct is preferred
when available.

Acceptance criteria:

- the declared production behavior matches the shipped configuration;
- any built-in service has authenticated, rotatable, non-logged credentials;
- direct WebRTC remains preferred;
- physical restrictive-NAT coverage is recorded honestly.

Fixed by commit:

Physical validation: NOT RUN

## NET-P1-002 — Signalling health is reported from object existence, not endpoint state

Status: OPEN

Priority: P1

Observed symptom:

Diagnostics can say Nostr and MQTT signalling are active even when no endpoint in a
family is connected, subscribed, publishing, or discovering peers. MQTT setup and join
errors are deliberately swallowed.

Evidence:

- [A] `activeSignallingFamilies()` appends a family when `room`/`mqttRoom` exists.
- [A] Trystero room construction is synchronous with relay connectivity occurring later.
- [A] `startSecondarySignalling()` uses an empty `onJoinError` and clears only synchronous
  factory failures; `start()` also contains secondary startup failures.
- [A] `networkDiagnostics()` exposes family names and one aggregate emergency-relay
  count, not signalling endpoint lifecycle or discovery stage.

Relevant files and symbols:

- `src/runtime/mesh.ts`: `startSecondarySignalling()`,
  `activeSignallingFamilies()`, `networkDiagnostics()`
- `src/runtime/mqttRoom.ts`: `joinMqttRoom()`
- `src/runtime/diagnostics.ts`

Root cause:

The diagnostic model conflates an allocated room/client object with a working signalling
subscription and does not retain bounded sanitized failure state.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

An operator cannot distinguish blocked WSS, broker rejection, no common endpoint,
undiscovered peer, handshake failure, and bootstrap failure. The fallback may silently
lose one whole discovery family.

Reproduction:

Construct both rooms while making every Nostr/MQTT WebSocket fail before subscription;
inspect `activeSignallingFamilies()` and current diagnostics.

Required fix:

Track per-family and per-endpoint sanitized states: connecting, subscribed, publish
verified, last error class/time, peer discovered, handshake stage, selected route, and
bootstrap stage. Do not log topics, tokens, keys, credentials, or raw SDP.

Regression test:

Use fake endpoints to assert transitions and redaction for success, DNS/socket failure,
subscription rejection, publication failure, and peer discovery.

Acceptance criteria:

- `active` means an evidenced signalling capability, not object existence;
- endpoint failures remain visible without secrets;
- diagnostics distinguish discovery, handshake, route, and bootstrap failures.

Fixed by commit:

Physical validation: NOT RUN

## NET-P1-003 — Manual reconnect may not rebuild a stuck transport

Status: INVESTIGATING

Priority: P1

Observed symptom:

The Reconnect command can appear to do nothing when a room or relay client remains stuck
after a VPN/proxy route change.

Evidence:

- [A] `SessionRuntime.reconnect()` only calls `transport.connect()` for remembered peers.
- [A] `MeshTransport.connect()` remembers the peer and sends `helloAck` only when a route
  already exists; it does not rebuild rooms or close sockets.
- [A] Applying network configuration refreshes the global proxy-aware WebSocket
  constructor, and Trystero/Nostr/MQTT have automatic reconnect behavior for sockets that
  actually close.
- The unproved condition is whether real Karing route changes leave half-open clients in
  a state that never closes and therefore never uses the refreshed constructor.

Relevant files and symbols:

- `src/extension.ts`: `pairNotebook.reconnect`
- `src/runtime/session.ts`: `reconnect()`
- `src/runtime/mesh.ts`: `configureMeshNetwork()`, `connect()`, `onNetworkChanged()`
- `src/runtime/netWatch.ts`

Root cause:

Not established. The command is a logical peer reannouncement, while its label can be
read as a physical transport restart. Automatic socket recovery may be sufficient after
clean close events but not after all route changes.

Confidence: MEDIUM

Why this can affect Host-on-VPN:

Switching TUN/VPN routes can change DNS, source address, or proxy routing without an
immediate close event on every existing WSS client.

Reproduction:

On a controlled socket server, leave a connection half-open while changing the resolved
proxy/route, invoke Reconnect, and record whether a new socket and subscription are
created.

Required fix:

First prove the lifecycle failure. If confirmed, add a bounded explicit transport refresh
that preserves a healthy incumbent and rebuilds alternatives; do not tear down working
sessions merely because a network fingerprint changed.

Regression test:

Model clean disconnect, half-open socket, and already-healthy route. A refresh must create
a replacement for the stuck path and leave the healthy path untouched.

Acceptance criteria:

- the command has defined physical and logical semantics;
- route refresh is make-before-break;
- changed proxy/TUN routing is used by newly created sockets;
- no duplicate peer admission or state loss occurs.

Fixed by commit:

Physical validation: NOT RUN

## NET-P1-004 — Protocol incompatibility is actionable only after a generic delay

Status: OPEN

Priority: P1

Observed symptom:

Two computers with incompatible VSIX generations can look like an ordinary networking
timeout instead of immediately telling the user to install the same build.

Evidence:

- [A] Current `HANDSHAKE_VERSION` is 4 and `parseHandshake()` intentionally rejects every
  other version with a generic incompatible-protocol error.
- [A] The current CHANGELOG states protocol-v4 peers reject 0.5.5 and older clients;
  0.5.4/0.5.5 are therefore not compatible with the current 0.5.7 code.
- [A] The bootstrap listener retains protocol/connection errors but normally surfaces the
  last one through a generic `connection-failed` snapshot message and timeout path.
- [A] No application version is exchanged, so the UI cannot identify the two exact
  installed versions.

Relevant files and symbols:

- `src/runtime/mesh.ts`: `HANDSHAKE_VERSION`, `parseHandshake()`, `onJoinError()`
- `src/runtime/bootstrap.ts`: `lastConnectionError`, `normalizeBootstrapError()`
- `package.json`, `CHANGELOG.md`

Root cause:

Compatibility is deliberately strict, but admission does not carry a safe explicit
product/protocol compatibility report to the Join UI.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

It can produce the same user-visible failure as a blocked route and is easy to encounter
when the two physical computers have different VSIX files. It does not explain failures
when both installed artifacts are proved identical.

Reproduction:

Attempt bootstrap between protocol v4 and an older handshake fixture, then inspect the
time and message surfaced by `joinSession()`.

Required fix:

Fail fast with a sanitized compatibility-specific error and instructions to install the
same extension build. Do not weaken the protocol-version gate.

Regression test:

Assert that an authenticated room delivering an incompatible handshake produces the
compatibility error promptly and never admits the peer.

Acceptance criteria:

- incompatible versions fail before the generic discovery/bootstrap timeout;
- the error is actionable but does not disclose secrets;
- compatible protocol-v4 peers remain unchanged.

Fixed by commit:

Physical validation: NOT RUN

## NET-P2-001 — Two-machine diagnostics lack endpoint and stage evidence

Status: OPEN

Priority: P2

Observed symptom:

The failed physical run did not produce enough comparable evidence to locate the break at
WSS reachability, common endpoint, discovery, handshake, ICE, relay, or bootstrap.

Evidence:

- [A] The diagnostics view lists configured Nostr relays, custom TURN probes, proxy
  selection, a small DNS sample, signalling family names, and an aggregate relay count.
- [A] It does not report exact reachable Nostr and MQTT endpoints, local ICE candidate
  type/transport summaries, peer discovery, handshake stage, bootstrap stage, or selected
  route history.
- [A] `scripts/network-probe.mjs` probes Nostr/STUN/custom TURN but not MQTT brokers or a
  safe paired host/guest correlation report.

Relevant files and symbols:

- `src/runtime/mesh.ts`: `networkDiagnostics()`
- `src/runtime/diagnostics.ts`
- `src/extension.ts`: diagnostics rendering
- `scripts/network-probe.mjs`, `scripts/join-live.mjs`

Root cause:

Observability was designed as a passive local summary, not a redacted two-machine
failure-stage report.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

It does not break connectivity itself, but it prevents isolating the physical root cause
and encourages incorrect attribution to VPN/NAT.

Reproduction:

Run current diagnostics on host and guest after a failed join and attempt to determine
their common endpoint and last successful protocol stage.

Required fix:

Add an exportable, bounded, redacted report for both roles containing session state,
endpoint states, ICE candidate summary without addresses, TURN state, relay state,
discovered peer, handshake/bootstrap stage, selected route, and timestamps.

Regression test:

Snapshot-test report schemas and redaction against tokens, topics, private keys, TURN or
proxy credentials, SDP, and local/public addresses.

Acceptance criteria:

- host and guest reports can be compared by stage and endpoint class;
- no bearer invite, derived topic, key, credential, raw SDP, or IP address is emitted;
- diagnostics remain read-only and user-level.

Fixed by commit:

Physical validation: NOT RUN

## NET-P2-002 — Network tests do not represent two physical asymmetric networks

Status: OPEN

Priority: P2

Observed symptom:

The test suite can pass while the exact host-on-Karing-TUN and remote-ISP Join scenario
fails.

Evidence:

- [B] Unit/integration coverage includes relay self-readiness, direct logical recovery,
  secondary MQTT discovery, signed relay envelopes, route upgrades, and stable snapshot
  bootstrap.
- [C] Trystero, MQTT, emergency-relay, and network-matrix live scripts spawn processes on
  one computer. A Karing-labelled matrix profile is still a local model, not a second
  physical network.
- [D] The only stated target two-computer run failed.

Relevant files and symbols:

- `test/network.test.ts`, `test/networkMatrix.test.ts`, `test/relay.test.ts`
- `test/runtime.integration.test.ts`, `test/routeOptimization.test.ts`
- `scripts/trystero-live-smoke.mjs`, `scripts/mqtt-live-smoke.mjs`
- `scripts/emergency-relay-live-smoke.mjs`, `scripts/network-probe.mjs`

Root cause:

Local simulations share DNS, machine routing, and often endpoint reachability. They cannot
prove cross-ISP, cross-VPN, or physical Windows behavior.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

It allowed level-B/C evidence to be described more strongly than the target level-D
behavior justified.

Reproduction:

Compare the current same-machine child-process topology with the target two-computer
topology.

Required fix:

Add deterministic asymmetric endpoint and route-replacement tests, plus a documented
two-machine runner/checklist. Keep physical validation separate from CI.

Regression test:

Cover disjoint/common endpoint subsets, one-sided Nostr/MQTT failure, relay-only
bootstrap, mid-bootstrap route replacement, duplicate relay signalling, stale routes,
late signalling, and reconnect.

Acceptance criteria:

- CI exercises asymmetric reachability deterministically;
- the physical procedure records exact build hashes and redacted diagnostics;
- no local script is labelled as physical proof.

Fixed by commit:

Physical validation: NOT RUN

## NET-P3-001 — Documentation overstates guaranteed and Karing validation

Status: OPEN

Priority: P3

Observed symptom:

Users and maintainers can infer that the built-in relay is guaranteed or that Karing TUN
was physically validated even though the target two-computer run failed.

Evidence:

- [A] Runtime errors still say `Guaranteed emergency relay ...` although the predicate is
  a local self-check.
- [E] README and historical audits use terms such as independently tested, complete
  fallback, or Karing-compatible with a common-WSS condition.
- [C] Historical live tests were same-machine processes or a system-proxy profile.
- [D] The current target physical scenario failed.

Relevant files and symbols:

- `README.md`, `CHANGELOG.md`
- `docs/network-compatibility-audit.md`
- `docs/network-reliability-handoff.md`
- `src/runtime/mesh.ts`: relay readiness error text

Root cause:

Evidence levels were not preserved in product wording as the architecture evolved.

Confidence: CONFIRMED

Why this can affect Host-on-VPN:

It does not cause packet loss, but it masks the remaining architecture and validation
work and can send troubleshooting toward the user's VPN instead of the failed stage.

Reproduction:

Compare current claims with the readiness predicate, current empty built-in TURN config,
and the physical result.

Required fix:

After connectivity fixes, align current docs and runtime text with actual guarantees and
evidence levels. Preserve historical release records as historical, with explicit current
status links.

Regression test:

Not generally applicable beyond targeted string/config assertions. Documentation review
must accompany the software acceptance evidence.

Acceptance criteria:

- no local self-check is called an end-to-end guarantee;
- same-machine and physical evidence are labelled separately;
- current TURN and fallback behavior matches shipped code;
- the target physical result remains NEEDS-PHYSICAL-VALIDATION until rerun.

Fixed by commit:

Physical validation: NOT RUN

## External sources checked

- Trystero upstream README/API and current source behavior for explicit relay lists,
  default STUN plus custom TURN, relay reconnection, room/topic derivation, and Nostr
  publication/subscription.
- MQTT.js upstream README for per-client broker connection, automatic reconnect,
  `createWebsocket`, and resubscription semantics.
- Nostr NIP-01 for client-to-relay WebSocket subscriptions and publications. The protocol
  does not make unrelated relay operators a guaranteed replicated transport.
- The exact installed dependency code remains the primary evidence where upstream main
  may differ from the locked release.

## Research checkpoint validation

- `npm test`: PASS, 301 tests on 2026-08-31. This includes compilation and deterministic
  local tests; it is evidence level B, not a live-network or physical result.
- `npm run lint`: PASS on 2026-08-31.
- Compile/bundle: PASS as the first phase of `npm test` on 2026-08-31.
- Public live relay tests: NOT RUN at this checkpoint.
- Target two-physical-computer scenario after any future fix: NOT RUN. The reported
  pre-fix scenario remains FAILED.

## NEXT ACTION

Next issue: `NET-P1-001 — No built-in TURN route for restrictive NAT combinations`.

Established root cause: TURN is currently an optional operator-supplied capability. The
repository has no product-owned service, credentials, or rotation mechanism, and anonymous
demo TURN credentials must not be restored. A code-only change cannot create a production
TURN guarantee.

Files to inspect/change:

- `src/runtime/turn.ts`
- `src/runtime/mesh.ts`
- `package.json`
- current README/configuration text

Required implementation shape:

1. confirm that no deployable credentialed TURN service exists in the supplied scope;
2. preserve direct-first behavior and reject dead anonymous credentials;
3. record the external infrastructure/product-decision blocker precisely;
4. if blocked, continue to the next fixable P1 without claiming TURN coverage.

Commands after the focused fix:

```text
rg -n "DEFAULT_TURN_URLS|TRYSTERO_TURN_SERVERS|turnUrls|turnUsername" src package.json README.md
npm test -- --grep "TURN"
```

Do not add a public TURN endpoint or credentials without an operated service, rotation
plan, and explicit user-provided authority.

Last safe pushed fix state: `0aac1f5` on
`origin/codex/networking-root-cause-repair`.
