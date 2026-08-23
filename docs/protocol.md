# Pair Notebook protocol

## Room and admission

The room key consists of a fixed application ID, the random session ID, and a 256-bit invite token supplied as the Trystero password. The invite contains no IP address, hostname, or listening port.

Before Trystero admits a peer, Pair Notebook exchanges a versioned handshake containing:

- session ID;
- connection purpose (`runtime` or `bootstrap`);
- application peer ID;
- validated display name;
- host-assigned deterministic join order;
- canonical Ed25519 public key;
- a fresh 256-bit nonce.

Both sides sign one canonical transcript containing the session, connection purposes, identities, keys, and nonces. Admission verifies the remote signature and rejects an incompatible session, malformed identity, changed pinned key/order, duplicate application peer ID, self-identity claim, or normalized display-name collision. The invite pins the initial host key before discovery; the transport binds every later frame's `sourceId` to the admitted connection identity.

## Frames and delivery

Pair Notebook preserves its compact binary wire frame above a single Trystero action. Metadata includes a random message ID, source and optional target IDs, send time, and host clock. Duplicate message IDs are retained for 60 seconds.

Each target has ordered realtime and bulk queues. Realtime edits can overtake queued bulk snapshot/file chunks, while an in-flight item remains ordered. Queue accounting includes in-flight bytes and enforces 128 MiB per peer plus 512 MiB per session, with separate frame-count and inbound-rate limits. Trystero action promises provide the send-completion barrier.

## Initial join

A bootstrap connection is admitted but is not listed as a live session participant. It requests a complete project snapshot from the current host. Text and notebook files come from the authoritative CRDT point in time; binaries are hash-verified while streaming from the current host working copy. The receiver validates a portable path manifest, writes `.part` files, verifies every chunk and SHA-256 hash, publishes files atomically, reconciles deletions, and removes transfer scratch data.

Only after the snapshot succeeds does the extension save the peer descriptor and open the extension-managed working folder. No backing-folder prompt exists on the joining path.

## State reconciliation

Runtime peers exchange Yjs state vectors and only missing document updates. Filesystem state contains tombstones, directory entries, binary hashes/versions, and deterministic author/version tie breakers. Binary transfers are isolated by `(sourceId, transferId)` and are published atomically after hash verification.

## Host clock and pause barrier

The host clock is `(sessionEpoch, hostEpoch, hostId)`. Stale clocks are rejected. A graceful transfer uses prepare, commit, acknowledgement, announcement, and finalize messages. Abrupt loss uses deterministic election among online peers.

Any host-clock change disables persistence on all peers and enters a visible pause. The new host has no inherited backing path. It selects a local folder and fully materializes the authoritative project before sending `hostStorageReady`. Peers also recover a missed ready notification from authoritative host heartbeats.

## Session end

Ending a session is distinct from leaving. The host requests a peer drain/ack fence, drains local outbound traffic, flushes the backing folder, writes an authenticated termination marker, broadcasts `sessionEnded`, and closes. A failed final save does not erase the local restore marker or token.
