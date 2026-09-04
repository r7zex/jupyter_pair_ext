# Pair Notebook architecture

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `extension.ts` | VS Code commands, name/invite prompts, folder selection, session restore, and UI lifecycle |
| `DashboardProvider` | Non-empty startup fallback, command bridge, state rendering, and host-pause controls |
| `MeshTransport` | Nostr/MQTT discovery, authenticated handshakes, WebRTC actions, redundant emergency relays, queues, RTT, and metrics |
| `SessionRuntime` | CRDT/filesystem synchronization, pinned host authority, execution barriers, persistence ownership, and pause/resume |
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

The discovery media normally carry only encrypted session descriptions needed to establish peer-to-peer WebRTC connections. If ICE is impossible, a separate emergency protocol chunks authenticated AES-256-GCM ciphertext over independent public Nostr relays and MQTT brokers. Either family can carry complete project frames; duplicate cross-family delivery is removed before the signed identity handshake. Relay operators never receive the session token or plaintext project frames, but can observe the stable topic, routing peer IDs, timing, sizes, and chunk counts. Because the emergency key is derived from the bearer invite rather than an ephemeral exchange, this fallback has no forward secrecy after invite disclosure. Start/Join attempts both families and requires an invite-key-encrypted publish-to-receive self-check through at least one family. Lost probes are retried, verified paths are rechecked periodically, and explicit Nostr/MQTT publication failure retires the affected path without disabling a healthy independent family.

## Working and backing copies

Every participant identity has a separate extension-managed working copy, including two participants opened in separate VS Code windows on one computer. Only the current host has a backing root. Joining descriptors deliberately store an empty `backingFolder`, so a local or synchronized path from another machine can never be reused accidentally.

Host identity changes only through the authenticated transfer initiated by the current host. Every runtime then disables its backing writer and enters `waiting-for-host-folder`. The new host clears inherited paths and exposes persistent actions to configure storage, transfer the role again, or end the session. It can materialize all authoritative documents/binaries/directories into a verified empty folder, or hash-check and bind an exact existing synchronized copy without rewriting it. A mismatch needs an explicit destructive confirmation and cancellation leaves the pause/retry state intact. Only successful storage setup broadcasts `hostStorageReady`; transferring the role keeps the pause active under the next host, while ending retains the final state and signed termination marker in extension-owned working copies.

The host writes the durable backing root before updating an open working-copy editor. Open editors remain dirty during ordinary debounced persistence; explicit execution, final save, and host transfer use VS Code's save API as filesystem barriers. Local recovery snapshots are staged under a verified non-symlink session directory and rotated independently of the backing root.

## Runtime and compatibility boundary

The VSIX targets VS Code 1.95 or newer. The complete runtime is bundled into `out/extension.js`:

- Trystero and its Nostr/MQTT strategies coordinate discovery and direct WebRTC negotiation.
- `werift` provides `RTCPeerConnection` inside the VS Code extension host.
- `ws` provides `WebSocket` when the VS Code Node runtime has no global implementation.
- MQTT, secp256k1, and the HTTP/HTTPS/SOCKS proxy agents support the independent relay and proxy paths.
- `proxy.ts` resolves Pair Notebook/VS Code settings, environment variables, and the Windows system proxy for every WSS signalling and emergency-relay socket.

Esbuild packages every runtime dependency into the extension bundle; `node_modules` is deliberately excluded from the VSIX. Python/Jupyter packages are needed only on a computer chosen to execute notebook cells.

## Execution recovery

Remote execution is a request/accept/result state machine above the route layer. Every notebook compute target is normalized to the current host; every authenticated participant can submit cells, Interrupt, and Restart there without a separate opt-in or CPU/GPU sharing flag. Only the host selects its local Python environment and CPU/GPU device. File barriers and unaccepted requests retry against `waitForRoute`; the host deduplicates by request ID and caches acknowledged results. Ordered kernel events and results use binary frame payloads, are retained within bounded replay budgets, and are replayed after an authenticated replacement route appears. Stdin uses an event-sequence/digest acknowledgement so a retry cannot write duplicate input. Transport protocol v5, first released in Pair Notebook 0.5.9, retains v4's signed emergency-relay envelopes and makes host-canonical lightweight execution framing an admission boundary: Pair Notebook 0.5.9 rejects protocol-v4 and older peers.
