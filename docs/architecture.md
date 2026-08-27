# Pair Notebook architecture

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `extension.ts` | VS Code commands, name/invite prompts, folder selection, session restore, and UI lifecycle |
| `DashboardProvider` | Non-empty startup fallback, command bridge, state rendering, and host-pause controls |
| `MeshTransport` | Nostr/MQTT discovery, authenticated handshakes, WebRTC actions, redundant emergency relays, queues, RTT, and metrics |
| `SessionRuntime` | CRDT/filesystem synchronization, host election, execution barriers, persistence ownership, and pause/resume |
| `downloadProjectSnapshot` | Folderless join bootstrap with streamed files, hashes, atomic publish, and final reconciliation |
| `CollaborativeProject` | Bounded Yjs text/notebook state and stable notebook-cell identity |
| `StorageAdapter` | Debounced atomic working/backing writes, retries, redirects, deletes, and full materialization |
| `EditorSynchronizer` | Per-file queued minimal VS Code editor updates without per-keystroke forced saves |

## Data flow

```text
VS Code edit
  -> Yjs transaction
  -> authenticated Pair Notebook frame
  -> Trystero action
  -> encrypted WebRTC data channel or redundant encrypted Nostr + MQTT emergency relay
  -> remote Yjs transaction
  -> minimal VS Code workspace edit

Host CRDT update
  -> debounced serialization
  -> atomic write to host backing folder

Join bootstrap
  -> current host CRDT document bytes + verified streamed binaries
  -> authenticated snapshot manifest/checkpoints
  -> isolated participant working copy
```

The discovery media normally carry only encrypted session descriptions needed to establish peer-to-peer WebRTC connections. If ICE is impossible, a separate emergency protocol chunks authenticated AES-256-GCM ciphertext over independent public Nostr relays and MQTT brokers. Either family can carry complete project frames; duplicate cross-family delivery is removed before the signed identity handshake. Relay operators never receive the session token or plaintext project frames. Start/Join attempts both families and requires an invite-key-encrypted publish-to-receive self-check through at least one family. Lost probes are retried, verified paths are rechecked periodically, and explicit Nostr/MQTT publication failure retires the affected path without disabling a healthy independent family.

## Working and backing copies

Every participant identity has a separate extension-managed working copy, including two participants opened in separate VS Code windows on one computer. Only the elected host has a backing root. Joining descriptors deliberately store an empty `backingFolder`, so a local or synchronized path from another machine can never be reused accidentally.

When host identity changes, every runtime disables its backing writer and enters `waiting-for-host-folder`. The promoted runtime clears inherited paths and exposes a persistent retry action. It can materialize all authoritative documents/binaries/directories into a verified empty folder, or hash-check and bind an exact existing synchronized copy without rewriting it. A mismatch needs an explicit destructive confirmation and cancellation leaves the pause/retry state intact. Only then does the host broadcast `hostStorageReady`.

The host writes the durable backing root before updating an open working-copy editor. Open editors remain dirty during ordinary debounced persistence; explicit execution, final save, and host transfer use VS Code's save API as filesystem barriers. Local recovery snapshots are staged under a verified non-symlink session directory and rotated independently of the backing root.

## Compatibility boundary

The VSIX targets VS Code 1.95. Trystero runs in the extension host with bundled compatibility layers:

- `werift` provides `RTCPeerConnection`.
- `ws` provides `WebSocket` when the VS Code Node runtime has no global implementation.
- `proxy.ts` resolves Pair Notebook/VS Code settings, environment variables, and the Windows system proxy for every WSS signalling and emergency-relay socket.

Both are bundled by esbuild into `out/extension.js`; `node_modules` is excluded from the VSIX.

## Execution recovery

Remote execution is a request/accept/result state machine above the route layer. File barriers and unaccepted requests retry against `waitForRoute`; the executor deduplicates by request ID and caches acknowledged results. Ordered kernel events and results use binary frame payloads, are retained within bounded replay budgets, and are replayed after an authenticated replacement route appears. Stdin uses an event-sequence/digest acknowledgement so a retry cannot write duplicate input. Transport protocol v3 makes these framing guarantees an admission boundary: mixed 0.5.3 and 0.5.4 participants do not enter one session.
