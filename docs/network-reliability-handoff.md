# Pair Notebook 0.5.4 network reliability release record

Date: 2026-08-27

Target release: 0.5.4

Target scenario: two Windows computers in Russia, including Flowseal/zapret on one endpoint and Karing TUN or Windows system-proxy mode on the other. The same transport must also work for every unordered pairing of direct, Flowseal/zapret, Karing TUN, Karing system proxy, explicit HTTP proxy, and environment proxy paths.

> This document preserves the 0.5.4 implementation and validation record. See the [documentation index](README.md) for current project guidance.

## Exact guarantee contract

Absolute operation without any outbound connectivity cannot be guaranteed by a networked application. The enforceable contract for this release is:

1. Both computers run the same Pair Notebook 0.5.4 VSIX; protocol v3 rejects 0.5.3 and older peers before session admission.
2. Each computer has a working outbound secure-WebSocket path through its active routing software.
3. Start and Join attempt two independent complete emergency data families, Nostr and MQTT.
4. The local transport does not report readiness until at least one complete emergency family returns an invite-key-encrypted publish-to-receive self-check.
5. Join does not report a connection until the two computers have completed the signed end-to-end participant handshake.
6. If WebRTC, UDP, TURN, and one public relay family are unavailable, the other full-data family can still carry the entire encrypted Pair Notebook wire protocol.
7. If neither full-data family is reachable, Start/Join fails explicitly instead of presenting a false working session.

## Implemented

- Added an independent proxy-aware MQTT-over-WSS full-data relay. It uses an invite-derived AES-256-GCM key, bounded 32 KiB chunks, QoS 1 deduplication, input limits, packet expiry, and bounded reconnect queues.
- Kept the existing encrypted Nostr full-data relay and extracted shared frame-relay and cryptographic contracts.
- Added a redundant relay that transmits over both independent families and removes duplicate cross-family frames before the identity protocol.
- Added a fail-closed readiness barrier. Either complete family is sufficient; both failing aborts startup with an actionable error.
- Bound handshake proofs to the SHA-256 digest of the exact nonce transcript. Delayed proofs from an older public-relay attempt are ignored without consuming retry state or emitting the reproducible false `failed the identity proof` error.
- Fixed false Nostr readiness after `CLOSED` or negative `OK`, and false MQTT readiness after a rejected or QoS-0-downgraded SUBACK grant.
- Added encrypted publish-to-receive self-checks, bounded probe expiry/retry, periodic path revalidation, and retirement after later publication failure.
- Enabled MQTT retry after transient CONNACK rejection.
- Fixed relay-construction failures so they cannot be silently ignored.
- Added a permanent forced-relay public smoke test. It disables WebRTC and both normal signalling rooms, runs one process directly and one through the detected Windows/Karing system proxy, and exchanges eight 64 KiB frames in all seven compatible ordered Nostr-only, MQTT-only, and redundant combinations.
- Added a logical route-recovery lease so a physical path flap cannot prematurely transfer host authority.
- Added acknowledged/idempotent execution, file-barrier retry, ordered event/result replay, and exactly-once stdin delivery.
- Fixed missing content for newly discovered CRDT documents after reconnection.
- Added persistent new-host folder retry with explicit empty-folder and exact existing/shared-folder modes.
- Updated the release documentation; 0.5.4 replaces the tracked 0.5.3 VSIX and requires the new VSIX on both computers.

## Completed validation

- `npm run artifacts`: PASS, including lint, compile, 272 deterministic tests, VSIX packaging, and artifact-content validation.
- Exact VSIX installation: PASS as `pair-notebook.pair-notebook@0.5.4`; the installed bundle and Python bridge match the release build.
- Published VSIX SHA-256: `c0140d25644ce7b87159a4f3d8601bfba324a18edf0aa13aa7daf6eff8192603`.
- `python .\test\jupyter_bridge_unit.py`: PASS, 7 tests.
- `npm audit --omit=dev`: PASS, 0 vulnerabilities.
- `npm run test:live`: PASS, public Nostr signalling plus WebRTC between independent Node processes.
- `npm run test:live:mqtt`: PASS, public MQTT signalling plus WebRTC.
- `npm run test:live:relay`: PASS in all seven compatible ordered family combinations; every scenario completed an eight-by-64-KiB direct-to-system-proxy burst and emitted no identity-proof failure.
- All nine release Nostr endpoints passed DNS, TCP, TLS and WebSocket upgrade; all three configured STUN endpoints returned valid binding responses.

## Release publication protocol

For every published build, review the staged diff, track only the current VSIX, and verify that the version and VSIX on `main` match the locally tested artifact. Record the final SHA-256 in the pull request and release handoff instead of embedding it in the artifact itself.

The physical two-machine Flowseal/zapret-to-Karing acceptance test remains NOT RUN because the current environment does not contain both target computers. It must not be reported as passed until the exact published VSIX is installed and exercised on those machines.

## Acceptance commands

```powershell
npm run artifacts
python .\test\jupyter_bridge_unit.py
npm audit --omit=dev
npm run test:live
npm run test:live:mqtt
npm run test:live:relay
code --install-extension .\pair-notebook-0.5.4.vsix --force
code --list-extensions --show-versions
Get-FileHash -Algorithm SHA256 .\pair-notebook-0.5.4.vsix
git ls-files "*.vsix"
git diff --check
```

Expected tracked artifact: `pair-notebook-0.5.4.vsix` only.
