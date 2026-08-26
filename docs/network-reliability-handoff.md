# Network reliability implementation handoff

Date: 2026-08-26

Target release: 0.5.2

Target scenario: two Windows computers in Russia, including Flowseal/zapret on one endpoint and Karing TUN or Windows system-proxy mode on the other. The same transport must also work for every unordered pairing of direct, Flowseal/zapret, Karing TUN, Karing system proxy, explicit HTTP proxy, and environment proxy paths.

## Exact guarantee contract

Absolute operation without any outbound connectivity cannot be guaranteed by a networked application. The enforceable contract for this release is:

1. Both computers run the same Pair Notebook 0.5.2 VSIX.
2. Each computer has a working outbound secure-WebSocket path through its active routing software.
3. Start and Join attempt two independent complete emergency data families, Nostr and MQTT.
4. The local transport does not report readiness until at least one complete emergency family has subscribed successfully.
5. Join does not report a connection until the two computers have completed the signed end-to-end participant handshake.
6. If WebRTC, UDP, TURN, and one public relay family are unavailable, the other full-data family can still carry the entire encrypted Pair Notebook wire protocol.
7. If neither full-data family is reachable, Start/Join fails explicitly instead of presenting a false working session.

## Implemented in this branch

- Added an independent proxy-aware MQTT-over-WSS full-data relay. It uses an invite-derived AES-256-GCM key, bounded 32 KiB chunks, QoS 1 deduplication, input limits, packet expiry, and bounded reconnect queues.
- Kept the existing encrypted Nostr full-data relay and extracted shared frame-relay and cryptographic contracts.
- Added a redundant relay that transmits over both independent families and removes duplicate cross-family frames before the identity protocol.
- Added a fail-closed readiness barrier. Either complete family is sufficient; both failing aborts startup with an actionable error.
- Bound handshake proofs to the SHA-256 digest of the exact nonce transcript. Delayed proofs from an older public-relay attempt are ignored without consuming retry state or emitting the reproducible false `failed the identity proof` error.
- Fixed Nostr readiness so a socket counts as ready only after the subscription request was sent.
- Fixed relay-construction failures so they cannot be silently ignored.
- Added a permanent forced-relay public smoke test. It disables WebRTC and both normal signalling rooms, runs one process directly and one through the detected Windows/Karing system proxy, and transfers 64 KiB in Nostr-only, MQTT-only, and redundant modes.
- Updated the release documentation and replaced the tracked 0.5.1 VSIX with 0.5.2.

## Completed validation

- `npm run artifacts`: PASS, including lint, compile, 256 deterministic tests, VSIX packaging, and artifact-content validation.
- `python .\test\jupyter_bridge_unit.py`: PASS, 7 tests.
- `npm audit --omit=dev`: PASS, 0 vulnerabilities.
- `npm run test:live`: PASS, public Nostr signalling plus WebRTC between independent Node processes.
- `npm run test:live:mqtt`: PASS, public MQTT signalling plus WebRTC.
- `npm run test:live:relay`: PASS in Nostr-only, MQTT-only, and redundant modes; every mode completed a 64 KiB direct-to-system-proxy round trip and emitted no identity-proof failure.
- The release VSIX was installed successfully and `code --list-extensions --show-versions` reported `pair-notebook.pair-notebook@0.5.2`.
- VSIX SHA-256: `CD546C95DAEDDC4581BD2B7022CAF4814632816C2F9C6A849ECD7C94FF5EA615`.

## Remaining release steps

1. Review the staged diff and confirm that only the 0.5.2 VSIX is tracked.
2. Commit with `fix(network): add redundant encrypted relay fallback`.
3. Push `codex/guaranteed-network-path`.
4. Open a PR with the release validation listed above.
5. Merge the PR into `main` and delete the remote feature branch.
6. Verify on GitHub that `main` contains version 0.5.2, the 0.5.2 VSIX, no 0.5.1 VSIX, and the same VSIX SHA-256.
7. If two physical target computers become available, install the exact VSIX on both and perform the final physical Flowseal/zapret-to-Karing acceptance test. This physical two-machine check is the only validation item not available in the current environment; it must remain recorded as NOT RUN until actually executed.

## Acceptance commands

```powershell
npm run artifacts
python .\test\jupyter_bridge_unit.py
npm audit --omit=dev
npm run test:live
npm run test:live:mqtt
npm run test:live:relay
code --install-extension .\pair-notebook-0.5.2.vsix --force
code --list-extensions --show-versions
Get-FileHash -Algorithm SHA256 .\pair-notebook-0.5.2.vsix
git ls-files "*.vsix"
git diff --check
```

Expected tracked artifact: `pair-notebook-0.5.2.vsix` only.
