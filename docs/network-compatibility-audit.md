# Network compatibility audit

Date: 2026-08-26

Release: 0.5.3

Primary platform: Windows, VS Code 1.95+

## Direct answer

The release has an application path for the requested Flowseal/zapret ↔ Karing combination:

- Flowseal/zapret is transparent packet interception, so Pair Notebook opens ordinary direct TCP/UDP sockets and the preset handles them below the application.
- Karing TUN is also transparent to the application and needs no Pair Notebook setting.
- Karing system-proxy mode now works because Pair Notebook reads the current user's Windows proxy before every connection attempt and routes Nostr/MQTT signalling plus the encrypted emergency channel through it.
- If WebRTC cannot cross the resulting NAT, VPN boundary or UDP policy, both peers can still authenticate and exchange encrypted frames through either the public Nostr or the independent public MQTT emergency channel. A custom TURN service remains optional.
- Start and Join do not declare the local transport ready until at least one complete emergency family has returned its own invite-key-encrypted publish-to-receive probe. Both Nostr and MQTT are attempted; failure is explicit only when neither independent full-data path is verified.

The connectivity contract is exact: with a common working outbound WSS infrastructure on both computers, Pair Notebook 0.5.3 proves a bidirectional encrypted local full-data fallback before Start/Join continues, and reports Join as connected only after the two peers complete the signed end-to-end handshake. This remains true when WebRTC, UDP and TURN are unavailable. No networked program can operate during a total loss of outbound connectivity or when the peers have no common reachable infrastructure. The exact two physical computers were not available to this audit; the release was exercised with active `winws` plus a live xray/Karing-style system proxy as described below.

## Additional 0.5.3 defects corrected

| Defect in 0.5.2 | Concrete failure | 0.5.3 correction |
| --- | --- | --- |
| Nostr readiness equalled `REQ` written to an open socket | A protocol-defined `CLOSED` or later negative `OK` still left `connectedRelayCount=1`; the path could not carry a frame | Encrypted publish-to-receive self-check, `CLOSED`/`OK` handling, rejection-driven retirement |
| MQTT readiness ignored the SUBACK grant | A broker returning failure QoS 128 was counted ready with no usable topic; accepting a QoS 0 downgrade would also remove delivery assurance | Require the requested QoS 1 grant, then encrypted self-delivery and QoS completion |
| Lost readiness probes had no expiry | A stable WebSocket that dropped one probe remained permanently unverified even after its network recovered | Bounded probe timeout, Nostr reconnect, MQTT resubscribe, and periodic revalidation |
| MQTT did not retry active CONNACK denial | A transient broker admission failure could disable that endpoint until the extension restarted | Enable `reconnectOnConnackError` for signalling and data clients |

## Additional 0.5.2 defects corrected

| Defect in 0.5.1 | Concrete failure | 0.5.2 correction |
| --- | --- | --- |
| Emergency project data used Nostr only | MQTT could discover a peer while failed ICE plus unavailable Nostr left no complete data path | Independent encrypted MQTT data relay; Nostr and MQTT each carry the full wire protocol |
| Relay proofs were not bound to one retry transcript | A delayed proof mixed with a newer handshake and reproducibly emitted `failed the identity proof` during a successful connection | SHA-256 transcript binding; delayed proofs are ignored without consuming the retry budget |
| Start/Join returned before fallback connectivity was proven | The UI could advertise a session before any full-data relay subscribed | Fail-closed readiness barrier: either complete family may pass; both failing produces an actionable error |

## Confirmed defects corrected

| Defect in 0.5.0 | Concrete failure | 0.5.1 correction |
| --- | --- | --- |
| Network settings loaded after activation continued | Join/bootstrap could create direct sockets before TURN/proxy secrets resolved | Activation and every Start/Join/Reconnect await one generation-guarded refresh |
| No Windows system-proxy input | Karing `Auto Set System Proxy` at `127.0.0.1:10809` was invisible to the extension's explicit WebSocket agent | Read-only WinINet discovery plus `pairNotebook.proxyUrl` manual fallback |
| `http://proxy` defaulted to port 1080 | A valid port-80 HTTP proxy was contacted on the SOCKS default port | Protocol-correct defaults: HTTP 80, HTTPS 443, SOCKS 1080 |
| Secure targets ignored `HTTP_PROXY` when `HTTPS_PROXY` was absent | A single local HTTP CONNECT listener was bypassed | WSS/HTTPS now falls back to `HTTP_PROXY` before `ALL_PROXY` |
| MQTT.js created its own imported `ws` socket | The Nostr family worked through Karing while secondary MQTT discovery timed out | A local Trystero-core MQTT adapter supplies MQTT.js' `createWebsocket` proxy hook |
| `NO_PROXY` ignored ports and Windows `;`/wildcard syntax | Entries such as `nos.lol:443` or `127.*` did not bypass correctly | Port-qualified, wildcard, `<local>`, comma and semicolon matching |
| Dialing Nostr sockets were not tracked | Concurrent `start()` calls opened duplicate connections; `stop()` could not close sockets until `open` | Track dialing and open sockets separately; stale close events cannot remove replacements |
| Public relay input and pre-open sends were unbounded | Crafted chunk counts and a disconnected outbox could retain unbounded memory | Wire-size, chunk-count, packet-count, byte and outbox limits |
| `relay.damus.io` remained in both relay sets | Live probe returned HTTP 503 on WebSocket upgrade | Removed; the emergency set uses four endpoints that passed the release probe |

## Pair matrix

The integration suite tests every unordered pair among these six local path types while the WebRTC/UDP path is deliberately unavailable:

1. direct;
2. Flowseal/zapret (transparent direct sockets);
3. Karing TUN (transparent direct sockets);
4. Karing Windows system proxy;
5. explicit `pairNotebook.proxyUrl` HTTP proxy;
6. `HTTP_PROXY` environment proxy.

All 21 combinations open their independently routed relay sockets and exchange one encrypted Pair Notebook frame. Separate tests cover HTTPS CONNECT, HTTPS-proxy scheme preservation, SOCKS4/SOCKS5/SOCKS5h agent selection, concurrent Nostr/MQTT discovery, dead-primary discovery, symmetric emergency-relay roles, lost-handshake retry and make-before-break recovery.

## Release evidence

- `npm test`: PASS, 262 tests.
- `npm run lint`: PASS.
- Active Windows proxy read: `ProxyEnable=1`, `ProxyServer=127.0.0.1:10809`.
- Real WSS through that detected local system proxy: PASS to `wss://nos.lol`, with target TLS validation enabled.
- Independent-process public Nostr/WebRTC smoke: PASS.
- Independent-process public MQTT/WebRTC smoke with primary signalling and emergency relay disabled: PASS through the detected system proxy.
- Forced no-WebRTC/no-signalling emergency relay, direct/winws host to Windows/Karing system-proxy peer: PASS for all seven compatible ordered Nostr-only, MQTT-only and redundant combinations, with eight 64 KiB frames sent and acknowledged per scenario.
- The forced redundant test rejects any `failed the identity proof` diagnostic; none occurred after transcript binding.
- Public endpoint probe: 9/10 pre-fix Nostr WSS candidates passed DNS, TCP, TLS and WebSocket upgrade; `relay.damus.io` returned HTTP 503 and was removed. The resulting 9/9 release list then passed the same probe.
- UDP STUN binding: PASS for both configured Google endpoints and Cloudflare from the release network.
- Custom TURN Allocate: NOT RUN because no user-owned TURN credentials were configured.
- Physical Flowseal computer ↔ physical Karing computer: NOT RUN because those two endpoints were not available in this environment.

## Operational guidance

Use Karing TUN when possible. For Karing system-proxy mode, enable **Auto Set System Proxy** before pressing Join; Pair Notebook refreshes it at that moment. If diagnostics still show `Direct`, set `pairNotebook.proxyUrl` to the local listener shown by Karing (commonly an HTTP/mixed port such as `http://127.0.0.1:10809`) and run **Pair Notebook: Reconnect**.

Flowseal/zapret presets require no Pair Notebook address or port. Pair Notebook attempts both emergency WSS families and requires at least one encrypted bidirectional self-check before Start/Join continues; if both are blocked or write-only it produces a bounded readiness error rather than a false working state. Total loss of outbound WSS remains a physical absence of network connectivity, not an application transport state.

## Primary sources

- [Flowseal/zapret repository and presets](https://github.com/Flowseal/zapret-discord-youtube)
- [zapret DPI-evasion documentation](https://github.com/bol-van/zapret/blob/master/docs/readme.en.md)
- [Karing FAQ: system proxy versus TUN](https://github.com/KaringX/karing-docu/blob/main/docs/faq.md)
- [Microsoft WinINet preconfigured proxy behavior](https://learn.microsoft.com/en-us/windows/win32/wininet/enabling-internet-functionality)
- [VS Code network and extension proxy behavior](https://code.visualstudio.com/docs/setup/network)
- [Trystero configuration and restrictive-network guidance](https://github.com/dmotz/trystero)
- [Trystero MQTT strategy source](https://github.com/dmotz/trystero/blob/main/packages/mqtt/src/index.ts)
- [MQTT.js WebSocket client documentation](https://github.com/mqttjs/MQTT.js/blob/main/README.md)
