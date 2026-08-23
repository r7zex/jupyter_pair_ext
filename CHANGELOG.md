# Changelog

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
