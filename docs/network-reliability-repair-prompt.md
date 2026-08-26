# Network Reliability Repair Prompt

Use this prompt to continue repairing `r7zex/jupyter_pair_ext` if the current
implementation session stops. Work on branch
`codex/fix-network-relay-reliability`, starting from `main` commit
`6702573d66cd64f1099ae277e5687fc5d3c263b0` (Pair Notebook 0.5.0).

## Objective

Make Pair Notebook reliably join a session when both computers are in Russia
and their network paths differ: one uses Flowseal/zapret and the other uses
Karing VPN/Xray. Preserve end-to-end authentication, host-owned storage,
folderless guests, and the existing public API.

Do not weaken identity verification, accept unsigned control messages, disable
TLS validation, or add secrets/public relay credentials to the repository.
Make small, independently testable commits and push each completed phase.

## Confirmed failures

These are reproduced defects, not speculative risks.

### 1. WSS is sent through an HTTP proxy with the wrong agent

- VS Code passes its `http.proxy` setting into the mesh from
  `src/extension.ts`.
- `src/runtime/proxyWebSocket.ts` selects `HttpProxyAgent` solely because the
  proxy URL starts with `http://`.
- For a secure WebSocket target such as `wss://nos.lol`, an HTTP forward proxy
  must be used with an HTTP CONNECT tunnel. The current selection sends the
  wrong request shape and receives HTTP 400.
- Reproduction with `http://127.0.0.1:10809` (Xray): the current
  `HttpProxyAgent` fails with `Unexpected server response: 400`; the correct
  `HttpsProxyAgent` opens the same `wss://nos.lol` connection.
- The HTTPS-proxy branch also incorrectly rewrites an `https://` proxy URL to
  `http://`, changing transport semantics.

Required repair:

- Select the proxy agent using both the target WebSocket protocol and proxy
  protocol.
- Use CONNECT-capable tunnelling for `wss://` through HTTP and HTTPS proxies.
- Preserve the exact configured proxy scheme, host, port, and credentials.
- Keep SOCKS behavior unchanged.
- Add regression tests for at least `wss://` through `http://`, scheme
  preservation for `https://`, `ws://` behavior, credentials, and no-proxy.

Acceptance: the regression test proves the secure target gets a tunnelling
agent, and a real/local CONNECT smoke test reaches a WSS endpoint through an
HTTP proxy without disabling target TLS validation.

### 2. One-sided emergency Nostr relay negotiation can deadlock forever

- `src/runtime/mesh.ts` normally chooses initiator/responder by lexical peer ID.
- When a handshake arrives without an existing negotiation, the receiver is
  hard-coded as `responder`.
- If only the lexically higher peer starts fallback, both peers become
  responders, derive different transcripts, reject the proof, and stay offline.
- The observed host ID is `39b992fb-3700-464d-90e3-e07203ec6691`; the observed
  guest ID is `836285ae-de7f-4e84-afd5-4f93cd4fb4f5`, which triggers this exact
  ordering.
- The protocol exception is swallowed in `src/runtime/nostrRelay.ts`, while the
  stale `relayNegotiations` entry prevents any later retry.

Required repair:

- Derive role identically on every creation path:
  `localPeerId < remotePeerId ? 'initiator' : 'responder'`.
- Add a bounded negotiation timeout that removes stale state and permits a new
  nonce/retry.
- Surface proof/protocol failures through existing connection/protocol error
  reporting without crashing the extension or leaking secrets.
- Do not allow replayed handshakes or proofs to authenticate a peer.
- Add deterministic tests where only the lower peer starts, only the higher
  peer starts, handshake/proof messages are lost, stale state is retried, and
  both peers eventually connect.

Acceptance: both lexical orderings connect, and a dropped negotiation does not
block future fallback attempts.

### 3. Parallel signalling routes race on host-assigned `joinOrder`

- Production logs show the same guest rejected with
  `presented a different host-assigned order`.
- Nostr and MQTT can authenticate concurrently. The first route is admitted and
  the host assigns canonical `joinOrder`; the second route still carries the
  guest's signed provisional order.
- `src/runtime/mesh.ts` checks order mismatch before duplicate-route handling,
  so the second valid transport is rejected even though it has the already
  pinned identity key.

Required repair:

- Continue rejecting any identity-key mismatch.
- On the host only, when the same verified identity opens a concurrent route,
  normalize its provisional order to the host directory's canonical order
  before transport deduplication/admission.
- On non-host peers, allow only the authenticated current host directory to
  change a peer's canonical order.
- Add a concurrency regression test with two signalling families and a stale
  provisional order, plus a negative test proving a different key is rejected.

Acceptance: the same authenticated guest is deduplicated/normalized without an
error, while a malicious key change still fails.

### 4. The bundled TURN fallback is known dead configuration

- `src/runtime/turn.ts` documents the bundled `openrelay.metered.ca` routes as
  non-operational.
- DNS currently resolves through CNAMEs with no usable A/AAAA result, and all
  three configured TURN probes fail.
- Shipping those endpoints as a working fallback creates false confidence and
  misleading diagnostics.

Required repair:

- Do not construct or advertise built-in TURN config when no operational
  service exists.
- Support user-supplied TURN URLs and credentials through the existing settings
  surface, without logging credentials.
- Report `not configured`/`unknown` separately from `configured but
  unreachable`; do not infer general UDP blocking solely from dead TURN DNS.
- Update settings descriptions and README to state what direct ICE, proxy-based
  signalling, emergency relay, and custom TURN each cover.
- Add unit tests for no TURN, configured TURN, DNS failure, and reachable
  control-path cases.

Acceptance: diagnostics never call the known-dead built-in service a fallback,
and they do not assert UDP is blocked without evidence.

### 5. The network probe script does not parse in Node.js

- `scripts/network-probe.mjs` contains TypeScript-only syntax:
  `(reason as Error)?.stack`.
- Node.js throws a syntax error before the diagnostic can run.

Required repair: replace the assertion with valid JavaScript, keep useful stack
reporting, and execute the script as part of validation.

## Required validation

Run and record the exact outcome of every applicable check. Mark unavailable
checks as `NOT RUN`; never report them as passed.

1. `npm ci`
2. `npm test`
3. `npm run test:live`
4. Focused proxy CONNECT regression/smoke test
5. Focused one-sided relay and retry tests
6. Parallel-route `joinOrder` regression and identity-key negative test
7. `node scripts/network-probe.mjs` (or its documented CLI invocation)
8. Build/package the VSIX and inspect that required runtime dependencies and
   webview assets are inside it
9. Install that exact VSIX into VS Code and perform a two-machine join using
   Flowseal/zapret on one side and Karing VPN/Xray on the other
10. Compare source/package/installed artifact identity (version and SHA-256)

For real-network validation, capture sanitized timestamps, relay hostnames,
route types, ICE state changes, and the exact user-visible error. Never record
invite secrets, proxy passwords, private keys, or full session identifiers.

## Progress on `codex/fix-network-relay-reliability`

- [x] Confirmed and documented all five reproducible defects and their evidence.
- [x] Repair WSS proxy agent selection and add regressions.
  - Secure WebSockets now use an HTTP CONNECT tunnelling agent through both
    HTTP and HTTPS proxies; the configured proxy scheme and credentials are
    preserved. Plain WebSockets retain forward-proxy behavior.
  - Focused proxy tests: 9 passing, including a local HTTP proxy that asserts
    the actual CONNECT request. Full suite: 210 passing and one unrelated
    route-optimization timing failure; its isolated rerun passed.
- [ ] Repair emergency relay role symmetry, cleanup, retry, and tests.
- [ ] Repair host-assigned `joinOrder` concurrency race and tests.
- [ ] Remove misleading built-in TURN fallback and correct diagnostics/docs.
- [ ] Repair and run the network probe script.
- [ ] Run the complete automated, live-network, package, and installed-artifact
  validation matrix.

After every phase, update this checklist and the pull request body with the
commit SHA, exact tests run, results, remaining failures, and anything that was
`NOT RUN`.
