# Pair Notebook 0.3.1 architecture

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `extension.ts` | VS Code commands, name/invite prompts, folder selection, session restore, and UI lifecycle |
| `DashboardProvider` | Non-empty startup fallback, command bridge, state rendering, and host-pause controls |
| `MeshTransport` | Trystero/Nostr discovery, authenticated handshakes, WebRTC actions, queues, RTT, and metrics |
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
  -> encrypted WebRTC data channel
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

The discovery medium never carries project payloads. It carries encrypted session descriptions needed to establish peer-to-peer WebRTC connections.

## Working and backing copies

Every participant identity has a separate extension-managed working copy, including two participants opened in separate VS Code windows on one computer. Only the elected host has a backing root. Joining descriptors deliberately store an empty `backingFolder`, so a local or synchronized path from another machine can never be reused accidentally.

When host identity changes, every runtime disables its backing writer and enters `waiting-for-host-folder`. The promoted runtime clears inherited paths, asks for a local folder, materializes all authoritative documents/binaries/directories, and then broadcasts `hostStorageReady`.

The host writes the durable backing root before updating an open working-copy editor. Open editors remain dirty during ordinary debounced persistence; explicit execution, final save, and host transfer use VS Code's save API as filesystem barriers. Local recovery snapshots are staged under a verified non-symlink session directory and rotated independently of the backing root.

## Compatibility boundary

The VSIX targets VS Code 1.95. Trystero runs in the extension host with bundled compatibility layers:

- `werift` provides `RTCPeerConnection`.
- `ws` provides `WebSocket` when the VS Code Node runtime has no global implementation.

Both are bundled by esbuild into `out/extension.js`; `node_modules` is excluded from the VSIX.
