# Pair Notebook 0.3.3

Pair Notebook is a VS Code extension for collaborative editing of project files and Jupyter notebooks. It uses Yjs for conflict-free document state and Trystero for encrypted peer-to-peer transport.

## Install

Install `pair-notebook-0.3.3.vsix` from **Extensions: Install from VSIX...**, or run:

```powershell
code --install-extension .\pair-notebook-0.3.3.vsix --force
```

That is the complete collaboration setup. Trystero, the Nostr discovery client, WebSocket compatibility code, and the WebRTC implementation are bundled into the VSIX. Users do not install a mesh client, daemon, server, npm package, or port-forwarding rule.

VS Code 1.95 or newer and internet access are required. Python, `jupyter_client`, and `ipykernel` are only required on a computer selected to execute notebook cells; text and notebook collaboration itself does not require them.

## Start a session

1. Open the Pair Notebook activity-bar panel.
2. Select **Start session**.
3. Enter the participant name other people should see.
4. Select the folder the host will own and persist. A separate extension-managed working copy opens automatically.
5. Copy the invite and send it only to trusted participants.

The host is the only participant that writes the canonical backing folder. A Dropbox, OneDrive, or other synchronized folder can be selected, but the cloud-storage provider is not used for live transport.

## Join a session

1. Install the VSIX and open the Pair Notebook panel.
2. Select **Join**, paste the complete `pair-notebook://` invite, and enter your name.
3. Wait for the host snapshot to finish.

A joining participant is never asked for a project folder. Pair Notebook creates an isolated working copy under the local application-data directory, opens it, and keeps it synchronized with the session. The participant name is validated and must be unique within the live room.

## Host transfer and failover

Every new session is resilient:

- A graceful host departure first drains peer traffic and flushes the latest state to the old host folder.
- An abrupt departure is covered by continuous atomic host persistence, which uses a 750 ms idle debounce by default and does not repeatedly force-save open editors.
- The earliest eligible connected participant becomes the new host deterministically.
- Every participant sees a paused state. Persistence, invitations, host transfer, session ending, and notebook execution remain disabled during the pause.
- The new host must select a folder on their own computer. Pair Notebook materializes the complete current project into that folder before broadcasting resume.
- The previous host folder is not deleted or moved. If it is synchronized by Dropbox or another provider, its last completed host writes remain available there.

Editing state remains in the CRDT during the short folder-selection pause, so an accidental keystroke is not discarded. The new host materializes the current merged state before the session resumes.

## Saving behavior

Live text and notebook updates are sent immediately; disk persistence is separate and debounced. The canonical host copy and join snapshots are serialized directly from current CRDT state, so an unsaved open editor cannot make a new participant receive stale disk contents.

Pair Notebook does not call VS Code's document or notebook `save()` method after every keystroke. That avoids repeatedly triggering format-on-save, save hooks, notebook serialization, and other extensions. Open editors are explicitly saved only for operations that require a physical filesystem barrier, such as execution, final host save, and host transfer. Closed files are written atomically.

The host also maintains rotating local recovery snapshots every five minutes and retains the latest three. Snapshot directories are staged and published atomically. Binary files, invalid-UTF-8 files, malformed notebooks treated as binary, empty directories, renames, deletions, notebook outputs, and stable cell IDs are included in synchronization.

## Network and security

Trystero uses public Nostr relays only to exchange encrypted discovery/session data. Project data travels through encrypted WebRTC data channels. The invite token is used as the Trystero room password and is stored in VS Code SecretStorage.

Each participant also owns an Ed25519 identity key. The private key remains in VS Code SecretStorage; the invite pins the host public key, and authenticated peer keys remain pinned across disconnects and failover. This prevents another invite holder from impersonating a known offline participant. Version 0.3.3 requires a fresh authenticated invite and intentionally does not resume legacy token-only sessions.

The invite is a bearer secret: anyone who receives it can attempt to join. Remote notebook execution can run code on a selected participant's computer, so sessions must contain only trusted people.

Most consumer and office networks connect directly or through STUN alone. Symmetric NATs and restrictive firewalls fall back to a free public TURN relay (Open Relay by Metered) bundled into the connection configuration, so joins succeed where STUN-only setups previously timed out. Direct peer-to-peer connections are always preferred when the network allows them; the relay only carries already-encrypted traffic as a last resort.

## Development

```powershell
npm install
npm run lint
npm test
npm run test:live
npm run artifacts
```

`npm test` uses an in-memory Trystero room to make transport and failover tests deterministic. `npm run test:live` additionally launches two independent Node processes and verifies public Nostr discovery plus a real WebRTC data-channel exchange.

The final artifacts are:

- `pair-notebook-0.3.3.vsix` — installable extension.
- `pair-notebook-complete-0.3.3.zip` — complete source project, build output, tests, documentation, and VSIX under one `pair-notebook/` directory.

See [architecture](docs/architecture.md), [protocol](docs/protocol.md), and [acceptance report](docs/acceptance-report.md) for implementation details.
