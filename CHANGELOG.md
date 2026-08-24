# Changelog

## 0.5.0 - 2026-08-24 (secondary signalling family, route policy, network-change recovery)

- **Secondary signalling family (MQTT)**: Pair Notebook now joins a concurrent MQTT-signalling room (`@trystero-p2p/mqtt`, public WSS brokers) in addition to Nostr. Failure of one signalling family no longer kills discovery: peers met through the surviving family connect with the full signed identity handshake. The same logical participant discovered through BOTH families appears exactly once — a provably-alive incumbent transport wins deterministically, the duplicate is closed, and zombie/lost-leave retirement semantics are unchanged. After the winning route dies, the peer is re-discovered through the surviving family. Failures of the secondary family are fully contained and never affect the primary.
- **Route-selection policy** (`src/runtime/routeScoring.ts`): explicit hysteresis for make-before-break promotion — relay→direct always migrates when verified; direct→direct requires a ≥20% RTT improvement plus zero recent failures; direct→relay never happens. The policy is the final gate inside `promoteCandidate`.
- **Passive network-change detection** (`src/runtime/netWatch.ts`): fingerprints adapter/address sets on a slow timer; a change triggers a BOUNDED search for better routes (fresh relay negotiation round for unmapped peers, one safe improvement attempt per relay-routed peer). A healthy active route is never torn down by the event.
- **Advanced diagnostics entry point**: new command `Pair Notebook: Run Advanced Network Diagnostics` plus an explicit sidebar button; the report header states the permission model — everything is passive/read-only and never requires elevation.
- New deterministic tests for all of the above (signalling failover/dedupe/recovery, migration-policy hysteresis incl. the "1 ms gain must not flap" case, change-detection fingerprinting); the in-memory Trystero test harness now implements real `close()` room-peer semantics. 210 tests passing.
- Live evidence recorded: public Nostr/WebRTC smoke passes from this environment; public MQTT brokers were unreachable at test time (`ECONNRESET`) — the secondary family degrades gracefully by design; `npm run test:live:mqtt` re-checks it.

## 0.4.0 - 2026-08-24 (connection quality, make-before-break route optimization)

- New **Connection** section in the left Pair Notebook panel: per-participant route type (direct P2P / encrypted relay fallback), measured latency, theme-aware colour-coded quality dot with text labels (never colour alone), and an evidence-based assessment ("Соединение уже оптимально" vs "Возможно доступно более прямое соединение").
- New **Try to improve** button (`Pair Notebook: Try To Improve Connection`): safe make-before-break optimization. When a participant is reachable only through the emergency relay, a candidate direct WebRTC connection is built in a separate short-lived negotiation room while the working relay keeps carrying all traffic. The candidate must complete the signed identity handshake, pass bidirectional probe frames and one-second pings through a stability window before it is promoted atomically; only then is the relay route retired. Failure, cancellation or timeout leaves the current connection untouched and says so in the UI.
- Logical participants are never duplicated or marked offline during migration: no disconnect events fire across the promotion boundary, pending outbound frames migrate from the old queue to the promoted route, and frame-id deduplication keeps delivery exactly-once.
- Real-time migration status: the optimizing side broadcasts rate-limited status notices over its existing connection, so the remote panel can show "Иван проверяет лучший маршрут… / переключает сетевой путь…" without falsely marking the peer offline.
- New passive diagnostics engine (`src/runtime/diagnostics.ts`): adapter classification via ordinary user-level APIs (VPN/TUN detection), UDP-availability inference from live TURN probes, configured-proxy detection, bounded DNS checks of signalling hosts — every conclusion carries an explicit confidence level (confirmed/high/medium/low). Filtering software (zapret/Flowseal) is never claimed as a confirmed cause without direct evidence; correlated symptoms are listed as possible causes. Diagnostics never modify system state and never require elevation.
- Fixed a proxy blind spot: the emergency Nostr data relay now builds its sockets through exactly the same proxy resolution as Trystero signalling (`http.proxy`, `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`, SOCKS4/SOCKS5/SOCKS5h), so the last-resort transport works on proxy-only networks too.
- 9 new deterministic regression tests covering the mandatory make-before-break acceptance scenarios (candidate failure/success/cancelled attempts, exactly-once delivery across the migration boundary, no duplicate or offline participants, remote status propagation) plus diagnostics confidence calibration and credential redaction.

## 0.3.5 - 2026-08-24 (snapshot retransmission over lossy relays)

- Fixed joins failing with "Snapshot is missing chunks for <file>" on the emergency Nostr relay route: a relay socket blip silently dropped individual `snapshotFileChunk` frames (the relay tunnel skips lost packets by design), and the snapshot protocol had no recovery, so the whole join failed even though the host was reachable.
- The joining receiver now answers an incomplete file with a `snapshotFileRetry` request listing exactly the missing chunk indices (up to 5 rounds per file). The host keeps bounded metadata for recent transfers and re-reads the requested chunks from memory or disk, resends them, and re-emits the file end frame; the receiver splices them into its temporary file by absolute offset, so a single lost frame no longer restarts or kills the transfer.
- Fixed joins failing with "Peer identity ... is already connected" after a peer's route died without a leave event (also a lossy-relay symptom): a second handshake that passes full identity-proof verification now retires the zombie route and admits the genuine re-connection instead of deadlocking. Impersonation protection is unchanged - forged claims still fail signature and identity-key checks before any route is touched.
- Registered the new frame type in the bootstrap/runtime purpose filters, snapshot protocol set, and clock-agnostic list; malformed or out-of-range retry requests are rejected.
- Added regression tests for both scenarios: a dropped snapshot chunk recovered via retransmission, and a genuine re-connection evicting a zombie identity route (plus a lost-leave simulation helper in the in-memory Trystero transport).

## 0.3.4 - 2026-08-23 (networking continuation)

- Proved with the installed werift ICE stack that only the FIRST `turn:`/`turns:` URL of the iceServers list is consumed; the previous four-URL TURN list silently degraded to a single transport. TURN endpoints are now modelled explicitly (`src/runtime/turn.ts`) with an ordered UDP -> TCP -> TLS fallback chain.
- Added a non-blocking live TURN Allocate probe per endpoint using werift's own TURN client; locally reachable transports are ordered first without ever deprioritising direct ICE. Probe failures are sanitised and surfaced in diagnostics; library-internal socket failures can no longer crash the extension host.
- Signalling WebSockets are now proxy-aware (`http.proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`; HTTP/HTTPS CONNECT, authenticated proxies, SOCKS5/SOCKS5H/SOCKS4). Node's `ws` follows none of them by itself, which broke discovery on proxy-only networks.
- A failing relay WebSocket (e.g. HTTP 503) no longer crashes Node via an unhandled 'error' event; Trystero's per-relay reconnection handles it instead.
- Custom TURN deployments: new settings `pairNotebook.turnUrls` / `pairNotebook.turnUsername` plus "Pair Notebook: Set TURN Password" backed by VS Code secret storage. The public Open Relay demo credentials remain only as the built-in last-resort default.
- Network diagnostics now show the Nostr relay list, TURN fallback order with live probe results, and the resolved signalling proxy - all credential-free.

## 0.3.3 — 2026-08-23

- Fixed joins that stalled for one or two minutes and then failed with "could not connect to peer ... after exchanging SDP; configure TURN servers": STUN-only ICE traversal cannot cross symmetric NATs and restrictive firewalls.
- The transport now appends a free public TURN relay (Open Relay by Metered) on ports 80/443 over UDP and TCP as a last-resort fallback. Direct peer-to-peer connections are still preferred whenever the network allows them, and the relay list is identical on every participant so both sides attempt the same relays.
- Joins on difficult networks now establish connectivity quickly through relay candidates instead of timing out after the long STUN-only ICE attempts.
- Added a regression test asserting the curated Nostr relay list and TURN fallback are passed to Trystero on every connection.

## 0.3.2 — 2026-08-23

- Fixed joins failing or stalling for a very long time: two of the five default Nostr discovery relays Trystero picked for the app id are offline, so discovery ran through too few relays. The transport now uses an explicit, health-checked list of ten fast public relays with redundancy eight, identical on every participant.
- Verified every relay in the list with a live WebSocket handshake and ordered it by measured latency.

## 0.3.1 — 2026-08-22

- Added Ed25519 participant identities, signed two-round handshakes, host-key pinning in invites, and offline peer-key pinning.
- Made the current host assign monotonic participant order so clock skew cannot change deterministic failover priority.
- Made bootstrap snapshots use authoritative CRDT text/notebook bytes instead of potentially stale open-editor files on disk.
- Preserved invalid UTF-8 and malformed notebooks byte-for-byte as binary files.
- Rejected portable Unicode/case path collisions, invisible path controls, ambiguous execution manifests, and case-only rename false positives.
- Serialized rapid remote text editor updates so an older asynchronous VS Code edit cannot overwrite a newer CRDT state.
- Rejected oversized merged cell/text state instead of silently truncating persisted data.
- Hardened local autosaves against symbolic-link session-root replacement.
- Reduced background hardware probing and cached unavailable NVIDIA tooling.
- Kept the panel usable when VS Code SecretStorage is temporarily unavailable.
- Expanded lifecycle, identity, snapshot, Unicode, autosave, editor-race, and corruption regressions to 164 passing tests.

## 0.3.0 — 2026-08-21

- Replaced the external machine-network transport with bundled Trystero using Nostr discovery and encrypted WebRTC data channels.
- Bundled WebRTC and WebSocket compatibility layers so the VSIX is self-contained across supported VS Code Node runtimes.
- Removed machine addresses and ports from peer identities, descriptors, invites, settings, tests, and documentation.
- Made all new and restored sessions resilient with deterministic host election.
- Added a mandatory all-peer pause after host change and full project materialization before the new host resumes the session.
- Removed backing-folder selection from the join path; only the current host owns persistent storage.
- Added participant-name prompts on both start and join, plus duplicate-name admission checks.
- Repaired webview startup ordering and added a visible no-script/error fallback.
- Stopped background persistence from force-saving open editors on every debounce.
- Added bootstrap, password isolation, identity, partition, reconnect, host persistence, pause/resume, UI startup, and public-network regressions.
- Cleaned packaging, compatibility, and dependency-audit issues.
- Isolated same-session working copies per local participant and rejected symbolic-link path escapes.
- Hardened transfer dimensions, revision metadata, send failures, and atomic binary/termination publication.
- Prevented old nested archives and generated caches from entering the final VSIX.
