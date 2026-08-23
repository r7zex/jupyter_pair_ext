# Pair Notebook 0.3.1 acceptance matrix

## Required outcomes

| Requirement | Evidence | Status |
| --- | --- | --- |
| Install one VSIX; no companion network software | Trystero, Nostr client, `ws`, and `werift` are bundled into `out/extension.js`; package inspection rejects `node_modules` and stale output | PASS |
| Host immediately after install | Start flow asks for a name and one host-owned folder, creates the session, and opens its managed working copy | PASS |
| Join immediately after install | Join flow asks only for invite and name, downloads a verified snapshot, and creates its own managed working copy | PASS |
| No folder prompt for joiners | Peer descriptor uses an empty backing root; bootstrap integration test completes without a folder argument | PASS |
| Human participant names | Start and join always display a validated name prompt; handshake rejects duplicate normalized names | PASS |
| Authenticated participant identities | Two-round Ed25519 proof, host-key invite pinning, and persistent peer-key pins reject live and offline impersonation | PASS |
| Automatic host replacement | Resilient election is deterministic and stale host clocks are rejected | PASS |
| Pause until the new host selects a folder | Every runtime enters `waiting-for-host-folder`; host-only actions and execution are blocked; dashboard renders the pause | PASS |
| Old host retains the latest persisted copy | Transfer flushes before role change; backing ownership is disabled without deleting the old folder | PASS |
| New host receives a complete copy | `setBackingFolder` materializes documents, binaries, directories, and deletions before resume | PASS |
| Join snapshot is current | Bootstrap serializes CRDT text/notebooks rather than stale open-editor disk bytes; a regression keeps the disk stale deliberately | PASS |
| Blank panel repaired | Extension receiver is registered before HTML; static fallback is visible; ready handshake forces a complete state repost | PASS |
| No per-keystroke forced save | CRDT backing serialization remains debounced while open-editor `save()` is reserved for explicit filesystem barriers | PASS |
| Public network path works | Two-process live smoke uses public Nostr discovery and exchanges an acknowledged WebRTC payload | PASS |
| Project boundaries remain contained | Absolute/traversal paths, linked parent directories, malformed transfer dimensions, and unsafe persisted revisions are rejected | PASS |
| Cross-platform paths remain unambiguous | Portable case/Unicode collisions, invisible controls, file/directory overlap, and ambiguous execution manifests are rejected | PASS |
| Non-text bytes remain lossless | Invalid UTF-8 and malformed `.ipynb` inputs remain binary and are transferred without replacement-character corruption | PASS |
| Package contains only current runtime | Clean compilation plus package inspection rejects stale output, old nested VSIX/ZIP files, caches, dependencies, and symbolic links | PASS |

## Verification layers

- TypeScript strict compile against the VS Code 1.95 API surface.
- ESLint over source, tests, and packaging scripts.
- Mocha unit, regression, boundary, and multi-runtime integration suites.
- Python bridge unit tests and syntax compilation.
- In-memory Trystero network partitions, reconnect, identity admission, password isolation, bootstrap, and failover.
- Public Trystero/Nostr/WebRTC smoke between independent Node processes.
- npm production and full dependency audit.
- Manual source-to-sink review of filesystem deletion/materialization, SecretStorage, webview messages/CSP, process launch, authenticated admission, queues, and artifact assembly.
- VSIX content inspection, ZIP content inspection, checksums, and local VS Code installation.

The managed Codex Security Deep Scan worker was unavailable in this desktop environment because it did not expose the required managed filesystem permission profile. It is not reported as a pass; the manual source-to-sink review and executable regression suite are the security evidence for this build.

Exact verification totals are recorded in `BUILD-REPORT.md`; final artifact hashes are emitted by the packaging command and accompany the delivered files.
