# Changelog

## 0.5.17 - 2026-09-06 (editor baseline, teardown and latency repairs)

- Reconciles stale open text buffers before interpreting local offsets. Preserves typing during initial binding and already-unsaved editor contents without out-of-range recovery or line loss.
- Maps displayed text positions to canonical Yjs positions before checking participant line locks, preventing remote line shifts from rejecting input on an unlocked line.
- Cancels queued editor work and stops pending continuations after disposal or document closure. Shutdown and failed final persistence cannot recreate destroyed project state or replace notebooks with empty snapshots.
- Reuses a bounded spare text replica through incremental Yjs updates after warmup, avoiding a full notebook source clone per remote keystroke. Rejected local merges are excluded from reuse.
- Adds regression coverage for initial binding, line locks, teardown, independent lagging cells, renames and replica reuse.

Installed VS Code UI and physical two-computer acceptance remain separate checks.

## 0.5.16 - 2026-09-06 (multi-event editor echo race repair)

- Reworks editor echo recognition around the exact displayed baseline and immutable text deltas, so one remote VS Code edit split across multiple change events is consumed exactly once instead of being republished as fresh local text. Fixes #12.
- Preserves genuine local typing before, between, or after split remote events; rejected workspace edits replay against the correct displayed baseline, and interleavings with no intermediate remote-target state are reconciled from the actual editor text instead of stale offsets.
- Adds file and notebook-cell regressions for characters, newlines, line joins, version jumps, hidden intermediate targets, rejected edits, second-peer convergence, idempotent wire replay, and repeated split-echo interleavings.

Installed VS Code UI and physical two-computer acceptance remain separate checks.

## 0.5.15 - 2026-09-06 (departure cleanup and connection progress)

- Sends an authenticated departure notice before transport shutdown, so relay-only participants disappear immediately from other session views while unexpected route loss keeps its bounded recovery lease. Fixes #13.
- Shows a non-cancellable VS Code connection notification during runtime startup and keeps the status bar spinner visible for the initial `connecting` state. Fixes #14.
- Adds regression coverage for multi-route departure cleanup, shutdown ordering, and connection-progress status text.

Installed VS Code UI and physical two-computer acceptance remain separate checks.

## 0.5.14 - 2026-09-06 (editor echo and kernel selection fixes)

- Prevents duplicated characters and newlines when VS Code splits or reshapes a remote text edit. Echo recognition uses the applied document version and resulting text, while preserving concurrent user typing. Fixes #12.
- Selects the Pair Notebook controller when a shared notebook becomes active or a session attaches, keeping the kernel selector populated across file switches without restarting the running Python kernels.
- Clears obsolete internal-write echo history after an external file change, so restoring previous content is synchronized and binary-to-text/notebook transitions complete correctly.
- Adds regression coverage for split and reshaped editor echoes, concurrent typing, kernel selection across notebook switches, and restored file content.

Installed VS Code UI and physical two-computer acceptance remain separate checks.

## 0.5.13 - 2026-09-05 (critical collaboration and execution repairs)

- Synchronizes guest-edited dependencies before execution and materializes the host workspace before running canonical cell text. Acceptance timeouts start after the dependency barrier.
- Preserves concurrent typing, canonical cell metadata/outputs, and unseen remote cells during VS Code text and structural updates. Shared source-only replicas avoid copying notebook outputs into every cell editor.
- Preserves protocol execution ownership through native notebook events and explicitly selects the Pair controller for Pair Run.
- Includes the current host epoch in invitations so participants can join after voluntary host transfers.
- Enforces the aggregate notebook source/output budget before incremental mutations, including retained deleted-cell state.
- Retains live kernels, variables, queued execution identity, and output routing when a notebook is renamed.
- Removes stale CRDT or binary representations when a file changes type, keeping snapshots and host-folder verification consistent.
- Dispatches Interrupt and Restart independently of bulk snapshot transfers; Stop cancels remaining Run All cells and previously queued batches.
- Clears terminal recovery state so guests close after host recovery expires while keeping the same pinned host authority.
- Installs the tested Jupyter dependencies in release CI so real-kernel regressions run on the clean Linux runner. The unpublished v0.5.12 tag is retained unchanged after its missing-dependency gate failure.

Automated validation is recorded in `CRITICAL_BUG_FIXES.md`. Installed VS Code UI and physical two-computer VPN acceptance remain separate checks.

## 0.5.11 - 2026-09-05 (execution and selected-line collaboration)

- Routes Pair Notebook execution through the preferred Pair Jupyter controller and adds a ten-minute kernel timeout with an automatic interrupt, so a lost completion cannot leave a cell running indefinitely.
- Synchronizes selected lines through CRDT-relative anchors, blocks edits to another participant's selected line, and keeps the lock on that logical line when new lines are inserted above it.
- Removes cursor labels, cursor configuration, and cursor-management UI; collaborators now see only selected-line highlighting.

## 0.5.10 - 2026-09-05 (laptop recovery and startup stability)

- Prevents a guest from closing on a short delayed-heartbeat window while MeshTransport is still performing its bounded 30-second authenticated route recovery.
- Keeps VS Code activation responsive while a restored guest session waits for initial host state; the dashboard and commands register before background restoration completes.
- Contains unexpected asynchronous TURN-probe rejections instead of throwing from a process-wide handler and terminating the VS Code extension host.

## 0.5.9 - 2026-09-04 (session and notebook stability)

- Unifies physical-route recovery behind one 30-second logical participant deadline while preserving pinned host authority, semantic awareness, queued work, and one correlated lifecycle trail.
- Closes terminal sessions only after cleanup, retains reconnect metadata for the original authenticated host, and closes Pair-owned text and notebook tabs without affecting unrelated editors.
- Applies remote text, metadata, output, and execution updates by stable cell identity; `NotebookEdit.replaceCells` is limited to the smallest real structural splice.
- Removes editor `save()` and full-notebook replacement from background synchronization and keeps explicit persistence/materialization barriers separate from live collaboration.
- Sends ordinary guest Run Cell as a revision/digest-bound stable-cell request, waits only for host canonical CRDT text, and preserves exactly-once acceptance, execution, output, and replay behavior through route loss.
- Publishes semantic file/cell/line presence separately from resource, hardware, and kernel telemetry; legacy exact cursors remain receive-only and invalid locations render no first-line artifact.
- Adds a bounded sanitized lifecycle diagnostics ring with one opaque correlation ID per recovery cycle.
- Advances admission to protocol v5 so protocol-v4 clients cannot join sessions that use the new host-canonical lightweight execution framing.
- Completes the 68-item regression matrix and final static/quality audit. The exact two-physical-computer VPN-switch scenario remains pending physical validation.

## 0.5.8 - 2026-09-03 (pinned host authority and VPN continuity)

- Pins session authority to the current host. Heartbeat loss, signalling failure, VPN changes, partitions, ordinary Leave, and higher clocks announced by non-hosts cannot promote a participant; only the authenticated explicit host-transfer protocol can advance the host clock.
- Closes a guest runtime after the 60-second host-route recovery lease is exhausted while retaining its isolated working copy, session credentials, marker, and Recent Projects entry for retrying the same pinned host.
- Routes every authenticated participant's notebook execution, Interrupt, and Restart to the current host without remote-compute, CPU-sharing, or GPU-sharing permission switches. Only the host can select its local interpreter and CPU/GPU device.
- Normalizes restored and transferred compute state to the current host and rejects compute announcements or targets authored by participants.
- Detects network-interface and Windows system-proxy changes, automatically reloads proxy settings, refreshes both signalling families, reannounces remembered peers, and keeps authenticated routes during the make-before-break recovery attempt.
- Detects half-open direct channels through repeated failed probes and moves them into logical route recovery even when Trystero never emits a leave event.
- Reconnects a disconnected session in place from Recent Projects when its working folder is already open.
- Adds a Marketplace README guide for official Karing and Happ installations, preferred TUN setup, system/explicit proxy fallback, diagnostics, and safe loopback listener configuration.

## 0.5.7 - 2026-09-01 (network recovery and paused-session control)

- Lets the current host transfer the role to another online participant while the session is paused for host-folder selection. The next host remains paused and must still materialize or verify a folder before normal collaboration resumes.
- Lets the current host end the session without choosing a new shared folder. Final merged state and an authenticated termination marker are retained in the extension-owned working copies instead of forcing an arbitrary shared-folder choice.
- Exposes **Transfer Host** and **End Session** directly in the host-folder prompt and pause card, while keeping persistence, invitations, and notebook execution blocked until storage is ready.
- Preserves a fresh authenticated emergency-relay route when late or duplicate signalling arrives, while still allowing stale or unavailable relay routes to be replaced safely.
- Replays the authenticated relay proof once after local admission so losing the first final proof cannot leave only one participant connected.
- Serializes emergency Nostr event signing and publication so snapshot control frames and chunks cannot overtake one another on relay-only routes.
- Resumes the initial project snapshot after an authenticated route replacement. Completed hash-verified files are retained, partial files restart under a new generation, and delayed frames from the old generation cannot complete or corrupt the transfer.
- Reports Nostr and MQTT signalling health only after fresh protocol evidence (`EOSE`/`OK` and `SUBACK`/`PUBACK`) and exposes bounded, sanitized endpoint and failure state without revealing URLs, credentials, topics, identities, or SDP.
- Makes **Reconnect** replace half-open Nostr/MQTT sockets through a bounded single-flight refresh while preserving live Trystero rooms, WebRTC routes, admitted identities, queues, and session state. Late acknowledgements from replaced socket generations are ignored.
- Adds deterministic coverage for relay ownership, relay-only and route-replaced snapshot bootstrap, signalling health, stale acknowledgements, partial refresh, and session continuity. The exact two-computer Karing TUN scenario remains pending physical validation, and this release does not add product-owned TURN or rendezvous infrastructure.

## 0.5.6 - 2026-08-30 (security hardening and audited release)

- Makes remote-compute consent ephemeral and session-scoped. Every new or restored session starts with remote execution disabled, ignores the deprecated persisted permission, and requires a fresh local opt-in before advertising or accepting remote execution.
- Advances the transport handshake to protocol v4. Every emergency-relay envelope is signed and bound to its session, sender, recipient, message ID, timestamp, and payload; replay, stale, modified, wrong-target, and impersonated envelopes are rejected. Protocol-v4 peers intentionally reject 0.5.5 and older clients.
- Bounds untrusted relay announcements and identity negotiations, while preserving authenticated route recovery and applying send completion/backpressure accounting to MQTT and promoted direct routes.
- Requires every selected Python interpreter to be an advertised Jupyter-ready environment before it can enter shared compute state.
- Excludes additional credential stores and common secret files from collaboration snapshots, the VSIX, and the source archive while retaining safe template files.
- Stores an explicit proxy password in VS Code SecretStorage, bound to its exact endpoint and username. Legacy embedded passwords migrate once; malformed or oversized values are removed without being copied, and proxy dependency DEBUG output is suppressed.
- Hardens the release workflow with immutable action commits, credential-free checkout, exact remote-tag verification, separate read-only verification and write-only publication jobs, and refusal to overwrite mismatched release assets.
- Documents the friends-first bearer-invite and remote-code-execution boundary, observable relay metadata, lack of forward secrecy after invite disclosure, protocol-v4 compatibility, and the 0.5.6 session-consent boundary.

## 0.5.5 - 2026-08-28 (documentation and release metadata)

- Rewrote the project overview around the current transport: direct WebRTC when available, optional custom TURN, and redundant encrypted Nostr/MQTT full-data fallback.
- Clarified current architecture and protocol documentation, including logical route recovery, host-owned persistence, recoverable remote execution, and the distinction between direct and relay delivery.
- Converted the completed 0.5.4 execution/host-transfer plan into an explicit historical implementation record and separated current guides from version-specific release evidence.
- Corrected the published 0.5.4 asset checksum and archive-entry evidence recorded in the release documents.
- Added complete repository, issue-tracker, homepage, keyword, GitHub About, and topic metadata so the project is accurately described wherever it is discovered.
- Runtime behavior is unchanged from 0.5.4; protocol v3 remains compatible with 0.5.4 and intentionally rejects 0.5.3 and older execution framing.

## 0.5.4 - 2026-08-27 (execution recovery and safe host promotion)

- Keeps an authenticated logical participant online during a bounded physical-route recovery lease. A transient WebRTC path loss now starts immediate relay/direct rediscovery instead of prematurely transferring host authority.
- Makes remote execution idempotent and recoverable: file barriers retry, requests receive bounded acceptance acknowledgements, completed results replay until acknowledged, and a request ID can never launch the same cell twice.
- Replays ordered Jupyter events after route restoration, deduplicates repeated events, and waits for every preceding event before accepting the terminal result. Events and results now use the binary payload instead of the 1 MiB metadata header.
- Aligns the complete rich-output pipeline at a bounded 32 MiB transport/bridge queue while retaining the 16 MiB rendered-cell limit. Large images/HTML no longer kill the Python bridge or fail the Mesh payload filter.
- Makes stdin replies digest-bound and exactly-once with acknowledgements; lost replies are retried without writing duplicate input lines. Interrupt and Restart wait for route recovery instead of failing on a stale route snapshot.
- Fixes newly discovered CRDT documents being materialized as empty before the missing-content check, which made the full-state request branch unreachable and hid participant file contents after reconnection.
- Adds an explicit, retryable new-host folder workflow: empty-folder materialization, exact existing/Dropbox-folder verification without rewrite, explicit confirmation for mismatches, and a persistent pause-card action after cancellation.
- Advances the signed transport handshake to protocol v3 so mixed 0.5.3/0.5.4 peers fail clearly during admission instead of connecting with incompatible execution framing.

## 0.5.3 - 2026-08-26 (verified relay data paths and recovery)

- Fixes false emergency readiness after a protocol-defined Nostr `CLOSED`/negative `OK` response or a rejected/downgraded MQTT SUBACK. These states previously counted as connected even though they could not provide the required delivery semantics.
- Requires an invite-key-encrypted publish-to-receive self-check before either Nostr or MQTT can satisfy Start/Join readiness. Opening a WebSocket or writing a subscription request is no longer accepted as proof.
- Times out lost self-checks, reconnects or resubscribes, periodically revalidates established paths, and immediately retires a path after a later Nostr publication rejection or MQTT QoS failure.
- Enables MQTT reconnection after transient CONNACK rejection for both signalling and emergency data clients.
- Expands the public forced-relay acceptance test to seven compatible ordered Nostr/MQTT/redundant combinations and an eight-by-64-KiB bidirectional burst per scenario through direct/winws and Windows system-proxy/xray routes.
- 262 deterministic tests plus public Nostr/WebRTC, MQTT/WebRTC, endpoint, STUN, and forced emergency-relay checks pass.

## 0.5.2 - 2026-08-26 (redundant full-data fallback and readiness contract)

- Adds a second complete emergency data path over proxy-aware MQTT/WSS. Nostr and MQTT now both carry encrypted Pair Notebook wire frames when WebRTC/TURN is unavailable; either family can sustain the session independently.
- Encrypts MQTT fallback packets with the same session-bound AES-256-GCM design, chunks standard snapshot frames, uses QoS 1, bounds broker input/queues, and deduplicates broker and cross-family delivery.
- Makes Start and Join wait for at least one subscribed full-data emergency family. Both Nostr and MQTT are attempted; either can satisfy readiness independently, and the session fails with a concrete error only when neither is reachable.
- Binds every identity proof to the exact handshake transcript and ignores delayed proofs from an older retry. This removes the reproducible false `failed the identity proof` errors from healthy redundant relay sessions.
- Adds a public forced-relay acceptance command that disables WebRTC and normal signalling, routes one peer directly and the other through the detected Windows/Karing proxy, and verifies a 64 KiB round trip over Nostr-only, MQTT-only, and redundant modes.
- 256 deterministic tests plus public Nostr/WebRTC, MQTT/WebRTC, and forced emergency-relay smokes pass.

## 0.5.1 - 2026-08-26 (Windows VPN/proxy compatibility and relay lifecycle)

- Detects the current Windows WinINet proxy before activation, Start, Join and Reconnect, covering Karing's system-proxy mode without requiring a duplicated VS Code setting. `pairNotebook.proxyUrl` remains an explicit HTTP(S)/SOCKS fallback for PAC-only or non-Windows clients.
- Routes MQTT.js through the same proxy resolver. The secondary Trystero family previously created its own `ws` socket and silently bypassed Karing/VS Code proxy settings even while Nostr worked.
- Fixes `http://` proxy URLs without a port resolving to 1080 instead of 80, adds secure-target `HTTP_PROXY` fallback, and honours VS Code/Windows bypass lists with ports and wildcards.
- Removes an observed HTTP 503 Nostr endpoint from discovery and emergency-relay lists; the replacement passed DNS, TCP, TLS and WebSocket upgrade probes on the release network.
- Prevents duplicate emergency-relay dials, closes sockets that are still connecting during shutdown, keeps stale close events from deleting replacements, and bounds malformed chunk metadata, reassembly memory and the pre-connect outbox.
- Adds a 21-pair integration matrix for direct, Flowseal/zapret, Karing TUN, Karing system proxy, explicit HTTP proxy and environment proxy paths with WebRTC/UDP unavailable, plus independent-process public Nostr and MQTT WebRTC smokes.
- Removes obsolete 0.3.1 reports, the completed repair prompt, a broken debug script and the superseded 0.5.0 VSIX from the current repository tree.

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
