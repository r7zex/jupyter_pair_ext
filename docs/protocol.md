# Pair Notebook protocol

## Room and admission

The room key consists of a fixed application ID, the random session ID, and a 256-bit invite token supplied as the Trystero password. The invite contains no IP address, hostname, or listening port.

Before Trystero admits a peer, Pair Notebook 0.5.6 exchanges a protocol-v4 handshake containing:

- session ID;
- connection purpose (`runtime` or `bootstrap`);
- application peer ID;
- validated display name;
- host-assigned deterministic join order;
- canonical Ed25519 public key;
- a fresh 256-bit nonce.

Both sides sign one canonical transcript containing the session, connection purposes, identities, keys, and nonces. Admission verifies the remote signature and rejects an incompatible session, malformed identity, changed pinned key/order, duplicate application peer ID, self-identity claim, or normalized display-name collision. The invite pins the initial host key before discovery; the transport binds every later frame's `sourceId` to the admitted connection identity.

Protocol v4 is first released in Pair Notebook 0.5.6. It authenticates every emergency-relay envelope with the sender's Ed25519 identity, its intended recipient, a freshness timestamp, and a replay-resistant message id. It is intentionally incompatible with protocol-v3 and older clients. Incompatible peers are rejected during admission; every participant must run 0.5.6 or another explicitly protocol-v4-compatible release.

## Frames and delivery

Pair Notebook uses one compact binary wire-frame format across every route. A direct WebRTC route carries it through a Trystero action; emergency Nostr/MQTT routes encrypt and chunk the same frame bytes before relay publication. Metadata includes a random message ID, source and optional target IDs, send time, and host clock. Duplicate message IDs are retained for 60 seconds.

The emergency relay encrypts frame content, not traffic metadata. Nostr relay and MQTT broker operators can observe a stable invite-derived topic, routing peer IDs, publication timing, packet sizes, and chunk counts. The invite token is a bearer secret and the relay key is derived directly from it, so this fallback does not provide forward secrecy against later invite disclosure. After suspected disclosure, participants must end the old session and create a new session/invite rather than reconnecting it.

Each target has ordered realtime and bulk queues. Realtime edits can overtake queued bulk snapshot/file chunks, while an in-flight item remains ordered. Queue accounting includes in-flight bytes and enforces 128 MiB per peer plus 512 MiB per session, with separate frame-count and inbound-rate limits. Trystero action promises provide the send-completion barrier.

A physical `onPeerLeave` starts a 60-second logical recovery lease. The participant remains logically online while signed replacement routes are attempted immediately through direct discovery and the encrypted relay families. A network-interface change also refreshes proxy configuration and signalling without tearing down a healthy route. Repeated ping failures retire half-open channels whose leave callback was lost. Host authority never changes because of route loss; admission of a replacement route cancels the logical disconnect and starts state reconciliation.

## Initial join

A bootstrap connection is admitted but is not listed as a live session participant. It requests a complete project snapshot from the current host. Text and notebook files come from the authoritative CRDT point in time; binaries are hash-verified while streaming from the current host working copy. The receiver validates a portable path manifest, writes `.part` files, verifies every chunk and SHA-256 hash, publishes files atomically, reconciles deletions, and removes transfer scratch data.

Only after the snapshot succeeds does the extension save the peer descriptor and open the extension-managed working folder. No backing-folder prompt exists on the joining path.

## State reconciliation

Runtime peers exchange Yjs state vectors and only missing document updates. Filesystem state contains tombstones, directory entries, binary hashes/versions, and deterministic author/version tie breakers. Binary transfers are isolated by `(sourceId, transferId)` and are published atomically after hash verification.

## Notebook execution

The current host is the only compute executor. Every authenticated session participant may submit notebook execution and kernel-control requests to it without a separate consent or CPU/GPU sharing flag. Only the host advertises compute hardware and Python environments, and only the host may select its local CPU/GPU device or interpreter. Restored and received compute targets naming a participant are rejected or normalized back to the current host.

Before remote execution, the requester and executor complete an idempotent document/binary/directory manifest barrier. Barrier check and commit frames retry across route replacement. The execution request is keyed by a random request ID: the executor acknowledges acceptance, rejects reuse with different content, and returns the cached terminal result for an identical duplicate instead of launching another kernel request.

Jupyter events carry a zero-based sequence in the frame metadata and the JSON event in the binary payload. The executor retains a bounded 2,048-event/32 MiB replay window, replays it after route restoration and before every terminal result, and retains completed delivery state within a 64 MiB aggregate cap. The requester buffers gaps, renders each sequence once, and does not resolve the cell until `eventCount` proves that every preceding event arrived. Terminal results also use the payload and repeat until `executeResultAck`.

The Python bridge, Mesh payload filter, and execution replay queue accept a bounded 32 MiB message; VS Code rendering remains capped at 16 MiB and emits a truncation notice beyond that limit. Stdin replies identify the input event sequence and are digest-bound, retried, and acknowledged. Duplicate replies receive another acknowledgement without writing a second line into the kernel. Interrupt and Restart wait for an authenticated route before dispatch.

## Host clock and pause barrier

The host clock is `(sessionEpoch, hostEpoch, hostId)`. Stale, skipped, equal-epoch, and self-proclaimed clocks are rejected. A voluntary transfer initiated by the current host uses prepare, commit, acknowledgement, announcement, and finalize messages. Heartbeats, hello metadata, route loss, partitions, VPN changes, and ordinary Leave never transfer authority. If every host route misses the recovery lease, a guest closes its active runtime but retains its working copy, credentials, marker, and Recent Projects entry for reconnection to the same pinned host.

Any host-clock change disables persistence on all peers and enters a visible pause. The new host has no inherited backing path. Persistent pause-card commands remain available after every cancelled prompt: configure storage, transfer the role to another online participant, or end the session. A repeated transfer advances the host clock and keeps every peer paused under the next host. Storage setup explicitly chooses either an empty directory to receive the authoritative project or an existing synchronized directory whose complete tracked manifest must match before it is bound without writes. A mismatched directory remains untouched unless the user explicitly confirms replacement. Only successful materialization or exact verification permits `hostStorageReady`; peers also recover a missed ready notification from authoritative host heartbeats.

## Session end

Ending a session is distinct from leaving. The host requests a peer drain/ack fence, drains local outbound traffic, flushes the final state, writes an authenticated termination marker, broadcasts `sessionEnded`, and closes. With ready host storage, the final state and marker go to the backing folder. During `waiting-for-host-folder`, each connected runtime flushes its extension-owned working copy and persists a local authenticated marker, so ending does not require selecting an arbitrary shared folder. A failed final save does not erase the local restore marker or token.
