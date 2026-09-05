# Pair Notebook protocol

## Room and admission

The room key consists of a fixed application ID, the random session ID, and a 256-bit invite token supplied as the Trystero password. The invite contains no IP address, hostname, or listening port.

Before Trystero admits a peer, Pair Notebook 0.5.9 exchanges a protocol-v5 handshake containing:

- session ID;
- connection purpose (`runtime` or `bootstrap`);
- application peer ID;
- validated display name;
- host-assigned deterministic join order;
- canonical Ed25519 public key;
- a fresh 256-bit nonce.

Both sides sign one canonical transcript containing the session, connection purposes, identities, keys, and nonces. Admission verifies the remote signature and rejects an incompatible session, malformed identity, changed pinned key/order, duplicate application peer ID, self-identity claim, or normalized display-name collision. The invite pins the initial host key before discovery; the transport binds every later frame's `sourceId` to the admitted connection identity.

Protocol v5 is first released in Pair Notebook 0.5.9. It retains v4's authenticated emergency-relay envelope and adds the host-canonical lightweight execution request as an admission boundary. It is intentionally incompatible with protocol-v4 and older clients so a mixed-version session cannot interpret execution frames under different contracts. Incompatible peers are rejected during admission; every participant must run a protocol-v5-compatible release.

## Frames and delivery

Pair Notebook uses one compact binary wire-frame format across every route. A direct WebRTC route carries it through a Trystero action; emergency Nostr/MQTT routes encrypt and chunk the same frame bytes before relay publication. Metadata includes a random message ID, source and optional target IDs, send time, and host clock. Duplicate message IDs are retained for 60 seconds.

The emergency relay encrypts frame content, not traffic metadata. Nostr relay and MQTT broker operators can observe a stable invite-derived topic, routing peer IDs, publication timing, packet sizes, and chunk counts. The invite token is a bearer secret and the relay key is derived directly from it, so this fallback does not provide forward secrecy against later invite disclosure. After suspected disclosure, participants must end the old session and create a new session/invite rather than reconnecting it.

Each target has ordered realtime and bulk queues. Realtime edits can overtake queued bulk snapshot/file chunks, while an in-flight item remains ordered. Queue accounting includes in-flight bytes and enforces 128 MiB per peer plus 512 MiB per session, with separate frame-count and inbound-rate limits. Trystero action promises provide the send-completion barrier.

A physical route is not the logical participant. A route loss, half-open detection, VPN/TUN switch, or signalling refresh starts one logical recovery cycle with the shared `LOGICAL_PEER_RECOVERY_MS = 30_000` deadline. Replacement direct and encrypted relay routes are attempted immediately. Admission of an authenticated replacement route ends that recovery cycle and starts state reconciliation. If every route remains unavailable for the full 30-second logical deadline, the transport emits one terminal logical disconnect. There is no separate 60-second participant lease.

During recovery the authenticated logical identity, pinned host clock, and awareness needed for restoration are retained; route health may be `recovering`/offline and must not be reinterpreted as a new participant or new host. A network-interface change refreshes proxy configuration and signalling without tearing down a healthy route. Repeated ping failures retire half-open channels whose leave callback was lost. Host authority never changes because of route loss.

## Initial join

A bootstrap connection is admitted but is not listed as a live session participant. It requests a complete project snapshot from the current host. Text and notebook files come from the authoritative CRDT point in time; binaries are hash-verified while streaming from the current host working copy. The receiver validates a portable path manifest, writes `.part` files, verifies every chunk and SHA-256 hash, publishes files atomically, reconciles deletions, and removes transfer scratch data.

Only after the snapshot succeeds does the extension save the peer descriptor and open the extension-managed working folder. No backing-folder prompt exists on the joining path.

## State reconciliation

Runtime peers exchange Yjs state vectors and only missing document updates. Filesystem state contains tombstones, directory entries, binary hashes/versions, and deterministic author/version tie breakers. Binary transfers are isolated by `(sourceId, transferId)` and are published atomically after hash verification.

Notebook changes carry semantic scopes. `cellText`, `cellMetadata`, `cellOutputs`, `cellExecution`, and `notebookMetadata` are applied narrowly by stable cell ID without replacing neighboring cells. A missing/unscoped historical state-vector merge is reconciled field-by-field unless the canonical and editor structures are provably inconsistent. `NotebookEdit.replaceCells` is reserved for the minimal structural splice (insert/delete/reorder or structural recovery); it is not a metadata/output/execution hot-path primitive.

Open VS Code documents are persisted through the editor API. Background persistence reconciles open documents without calling `save()`. `NotebookDocument.save()` and `TextDocument.save()` are invoked only when an explicit filesystem materialization/barrier requests `prepareWorkingCopy()`, such as host Save, host transfer, session-end fencing, local execution that needs the physical workspace, or an explicit legacy execution barrier.

## Notebook execution

The current host is the only compute executor. Every authenticated session participant may submit notebook execution and kernel-control requests to it without a separate consent or CPU/GPU sharing flag. Only the host advertises compute hardware and Python environments, and only the host may select its local CPU/GPU device or interpreter. Restored and received compute targets naming a participant are rejected or normalized back to the current host.

Ordinary guest **Run Cell** is a lightweight, host-authoritative protocol. The request identifies the notebook, stable cell ID, host compute epoch/target, canonical cell revision and digest, and a random request ID; it does not send guest code as an execution authority. The host waits only for the target cell's CRDT state to reach the requested revision, resolves the canonical cell text locally, verifies the digest and execution authority, and then executes that host-canonical text. Ordinary guest Run Cell does **not** call `synchronizeExecutionFiles()`, `prepareWorkingCopy()`, or a full storage `flush()`.

The project-wide document/binary/directory execution barrier remains only as an explicit legacy/protocol-compatible barrier. Its check/commit frames are idempotent and may retry across route replacement, but it is not on the ordinary guest Run Cell path.

Execution requests are keyed by random request ID and immutable identity fields. A duplicate request with the same identity is acknowledged/replayed rather than launched twice; reuse with different content/revision/digest is rejected. After acceptance, execution ownership survives route replacement.

Jupyter events carry a zero-based sequence in the frame metadata and the JSON event in the binary payload. The executor retains a bounded 2,048-event/32 MiB replay window, replays it after route restoration and before every terminal result, and retains completed delivery state within a 64 MiB aggregate cap. The requester buffers gaps, renders each sequence once, and does not resolve the cell until `eventCount` proves that every preceding event arrived. Terminal results also use the payload and repeat until `executeResultAck`.

The authoritative host CRDT receives the final output/execution state once, and that state is then replicated to every participant. Output bursts are coalesced at the VS Code renderer boundary without dropping the last canonical state. The Python bridge, Mesh payload filter, and execution replay queue accept a bounded 32 MiB message; VS Code rendering remains capped at 16 MiB and emits a truncation notice beyond that limit. Stdin replies identify the input event sequence and are digest-bound, retried, and acknowledged. Duplicate replies receive another acknowledgement without writing a second line into the kernel. Interrupt and Restart wait for an authenticated route before dispatch.

## Presence and resources

New peers publish semantic presence only: participant identity, active file, stable notebook cell ID, active **line**, and a CRDT-relative line-start anchor. The anchor follows the same logical line when text is inserted above it. Exact cursors, columns, selections, names, and colors are not rendered; a selected line is highlighted and edits to it are rejected for other participants. Legacy exact cursor data remains receive-only compatibility and is not rendered.

Resource/hardware/kernel telemetry is separate from semantic awareness. Resource sampling emits dedicated resource frames with its own rate limit; hardware and kernel status use their dedicated frames. Those updates can refresh the dashboard but do not change `activeLine`, do not republish semantic awareness, and do not move a selected-line highlight.

## Host clock and recovery

The host clock is `(sessionEpoch, hostEpoch, hostId)`. Stale, skipped, equal-epoch, and self-proclaimed clocks are rejected. A voluntary transfer initiated by the current host uses prepare, commit, acknowledgement, announcement, and finalize messages. Only the current host can advance authority through that explicit transfer, and only an authenticated announcement from the currently trusted host can apply the next clock. Heartbeats, hello metadata, route loss, partitions, VPN changes, ordinary Leave, and the 30-second recovery deadline never elect or promote another host.

If every route to the pinned host misses the shared 30-second recovery deadline, a guest closes its active runtime with `host-unreachable` while retaining its working copy and reconnectable Recent Session metadata. Manual Recent Session reconnect targets only the same pinned original host identity and never self-promotes or accepts a substitute host key.

Any explicit host-clock change disables persistence on all peers and enters a visible pause. The new host has no inherited backing path. Persistent pause-card commands remain available after every cancelled prompt: configure storage, transfer the role to another online participant, or end the session. A repeated transfer advances the host clock and keeps every peer paused under the next host. Storage setup explicitly chooses either an empty directory to receive the authoritative project or an existing synchronized directory whose complete tracked manifest must match before it is bound without writes. A mismatched directory remains untouched unless the user explicitly confirms replacement. Only successful materialization or exact verification permits `hostStorageReady`; peers also recover a missed ready notification from authoritative host heartbeats.

## Terminal close reasons and Recent Sessions

Terminal lifecycle reasons are deliberately non-overlapping:

- `local-route-failed`: this runtime's own `MeshTransport.start()` failed before local transport readiness was established;
- `host-unreachable`: an established guest lost the pinned host beyond the logical recovery deadline;
- `explicit-leave`: the local user/extension explicitly left/disposed the active session;
- `session-ended`: an authenticated Session Host ended the session for everyone.

A terminal close clears execution context, disables Run Cell/Restart, removes Pair-owned tabs/decorations, and records typed lifecycle evidence. Explicit Leave keeps the Recent Project entry but removes reconnect credentials; an unrecoverable pinned-host loss keeps the reconnectable Recent Session identity so a later manual reconnect can target the same host.

## Lifecycle diagnostics

Lifecycle diagnostics are passive and bounded. Every recovery cycle gets one opaque random correlation ID that is reused for ordered route-loss/recovery/replacement/deadline/close evidence and retired when that recovery cycle ends. The next cycle gets a new ID.

The in-memory `LifecycleDiagnosticRing` holds at most 256 events and evicts oldest-first. It hashes the session identifier, validates peer IDs, and accepts only an allow-list of short metadata fields; arbitrary token/proxy/SDP/notebook-code-shaped data is discarded. Runtime disposal intentionally leaves the bounded ring available long enough for extension-level Pair-tab cleanup and Recent Session evidence to append to the same terminal lifecycle chain.

## Session end

Ending a session is distinct from leaving. The host requests a peer drain/ack fence, drains local outbound traffic, flushes the final state, writes an authenticated termination marker, broadcasts `sessionEnded`, and closes. With ready host storage, the final state and marker go to the backing folder. During `waiting-for-host-folder`, each connected runtime flushes its extension-owned working copy and persists a local authenticated marker, so ending does not require selecting an arbitrary shared folder. A failed final save does not erase the local restore marker or token.
