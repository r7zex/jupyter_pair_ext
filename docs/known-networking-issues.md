# Pair Notebook — networking problems found in real two-machine testing

This document records networking defects and design gaps observed after a real test on **two physical computers in Russia**. The peer could not join the host **with VPN enabled or disabled**, even though the general Internet connection worked on both machines.

The goal of this file is to keep the problems explicit and actionable before the next networking repair pass.

---

## 1. Local relay readiness does not guarantee a common relay between two computers

### Problem

`RedundantFrameRelay.waitUntilReady()` currently succeeds when **either local Nostr or local MQTT readiness succeeds**.

That only proves:

- this computer can reach at least one relay/broker;
- this computer can publish and receive its own readiness probe through that endpoint.

It does **not** prove:

- the host and guest have at least one **common reachable relay/broker**;
- a message published by one physical computer can actually reach the other physical computer.

### Failure example

Host:

- `nostr.mom` reachable;
- `nos.lol` blocked.

Guest:

- `nos.lol` reachable;
- `nostr.mom` blocked.

Both can report local emergency readiness as successful, while there is no shared Nostr endpoint.

The same problem is possible with MQTT brokers.

### Impact

Two machines can both appear locally ready but never discover each other or complete the bootstrap handshake.

### Required fix

Implement at least one of these:

1. a guaranteed shared rendezvous/data endpoint;
2. explicit common-endpoint negotiation;
3. cross-family bridging through infrastructure that is actually shared;
4. fail Join unless a peer-to-peer end-to-end handshake is observed, rather than treating local relay readiness as sufficient transport evidence.

---

## 2. Emergency relay routes are not represented correctly in `roomForTransport()`

### Problem

Emergency relay transport IDs use:

```text
relay:<peerId>
```

But `roomForTransport()` only has explicit handling for:

- MQTT transports;
- route-upgrade transports;
- ordinary Trystero transports.

There is no explicit `relay:` branch.

### Why this matters

Code that checks whether an already-connected route is still alive can call:

```ts
const activeOwner = this.roomForTransport(activeTransport);
const roomPeerAlive = Boolean(activeOwner.room?.getPeers()[activeOwner.rawId]);
```

For an emergency route such as:

```text
relay:abc123
```

this is incorrectly mapped to the ordinary Trystero room.

That room does not own the relay transport, so the route may appear dead even while the emergency relay connection is actually alive.

### Impact

A live relay route can be treated as stale/zombie during duplicate signalling, reconnect, or route recovery.

Possible symptoms:

- unnecessary route retirement;
- connection flapping;
- reconnect loops;
- Join failing after partial success.

### Required fix

Represent emergency relay transports explicitly in transport ownership/liveness logic.

Do not use ordinary Trystero `room.getPeers()` as the liveness source for `relay:` transports.

---

## 3. Current live tests do not reproduce two physical computers on different networks

### Problem

`scripts/emergency-relay-live-smoke.mjs` launches host and peer as two child processes on the same machine.

This means they normally share:

- the same operating system;
- the same ISP path;
- the same DNS environment;
- the same relay reachability set;
- the same routing constraints.

### Impact

The test can pass while a real two-machine scenario fails.

In particular, it does not adequately model:

- different ISPs;
- different CGNAT behaviour;
- different DPI/filtering;
- different VPN/TUN paths;
- non-overlapping relay accessibility;
- asymmetric routing between host and guest.

### Required fix

Add a real two-machine acceptance test.

Minimum acceptance matrix:

1. direct ↔ direct;
2. direct ↔ VPN/TUN;
3. VPN/TUN ↔ VPN/TUN;
4. Flowseal/zapret ↔ Karing TUN;
5. different ISPs;
6. WebRTC deliberately blocked;
7. Nostr available only on one side;
8. MQTT available only on one side;
9. one common relay available;
10. no common relay available.

The test must clearly distinguish:

- local endpoint readiness;
- peer discovery;
- authenticated handshake;
- snapshot bootstrap;
- full session readiness.

---

## 4. Current readiness checks are self-checks, not end-to-end peer checks

### Problem

Both Nostr and MQTT readiness primarily verify that the local client can publish and receive its own probe.

This is useful as a local endpoint health check, but it is not proof that another computer can receive traffic from this computer.

### Impact

The application can conclude that fallback infrastructure is healthy while the actual pair still has no working communication path.

### Required fix

Keep self-readiness probes, but separate them from end-to-end session readiness.

Recommended states:

```text
Local relay ready
Peer discovered
Identity handshake complete
Bootstrap channel ready
Snapshot transfer started
Snapshot transfer complete
Runtime session ready
```

The UI and logs should never collapse these into one generic "connected" state.

---

## 5. Diagnostics do not expose enough endpoint-level information

### Problem

Current diagnostics do not make the important intersection problem obvious.

For each relay/broker family, the extension should expose which exact endpoints are:

- DNS reachable;
- TCP reachable;
- TLS reachable;
- WebSocket reachable;
- subscription-ready;
- publish-ready;
- self-readiness verified.

### Impact

When a real pair fails, it is hard to determine whether the host and guest have any shared infrastructure.

### Required fix

Add endpoint-level diagnostics, for example:

```text
Nostr
  wss://nos.lol            READY
  wss://relay.sigit.io     BLOCKED
  wss://nostr.mom          READY
  wss://nostr.data.haus    BLOCKED

MQTT
  broker.emqx.io           READY
  broker.hivemq.com        BLOCKED
```

Also expose the currently selected transport route and why it was selected.

Do not log secrets, invite tokens, proxy passwords, or identity private keys.

---

## 6. No guaranteed built-in TURN path means difficult NATs still depend on public fallback

### Problem

Direct WebRTC can fail under:

- symmetric NAT;
- restrictive firewalls;
- some CGNAT combinations;
- UDP blocking;
- VPN boundaries.

A custom TURN configuration is optional, not guaranteed.

### Impact

When direct ICE fails, Pair Notebook depends heavily on the public Nostr/MQTT fallback.

If the public relay intersection also fails, the session has no usable route.

### Required fix

Either:

1. provide a guaranteed production TURN service;
2. provide a guaranteed shared relay service;
3. make the dependency explicit in the product contract.

Do not describe the current design as "guaranteed connectivity" unless there is infrastructure that guarantees both peers can reach the same service.

---

## 7. The existing documentation overstates confidence relative to physical test coverage

### Problem

The repository contains strong wording around difficult-network compatibility, while the physical two-machine Flowseal/Karing scenario was explicitly not run in the audit.

A real two-machine test has now failed.

### Impact

Test evidence and stated guarantees are not aligned.

### Required fix

Until physical acceptance passes consistently:

- describe the public relay path as best-effort;
- distinguish deterministic unit/integration coverage from real network acceptance;
- mark two-physical-machine acceptance as required before claiming the networking path is production-ready.

---

# Priority

## P0

1. Fix common-relay / common-rendezvous guarantee.
2. Fix `relay:` transport ownership and liveness handling.
3. Add end-to-end peer readiness separate from local self-readiness.

## P1

4. Add per-endpoint diagnostics.
5. Add a real two-machine acceptance test matrix.
6. Tighten documentation claims.

## P2

7. Decide whether production connectivity requires built-in TURN or a guaranteed shared relay service.

---

# Current conclusion

The failed physical test should be treated as a **real product defect signal**, not dismissed as a local VPN or Windows issue.

The current implementation can pass local readiness and single-machine live smoke tests while still failing to establish a real session between two physical computers.

This document should remain open until a real two-machine test can prove:

```text
Host starts session
→ Guest discovers host
→ signed identity handshake completes
→ snapshot transfer completes
→ runtime session becomes ready
→ editing works bidirectionally
→ reconnect works
```

across at least two different network paths.
