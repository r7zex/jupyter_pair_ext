# Network compatibility audit

Date: 2026-08-26

Release: 0.5.1

Primary platform: Windows, VS Code 1.95+

## Direct answer

The release has an application path for the requested Flowseal/zapret ↔ Karing combination:

- Flowseal/zapret is transparent packet interception, so Pair Notebook opens ordinary direct TCP/UDP sockets and the preset handles them below the application.
- Karing TUN is also transparent to the application and needs no Pair Notebook setting.
- Karing system-proxy mode now works because Pair Notebook reads the current user's Windows proxy before every connection attempt and routes Nostr/MQTT signalling plus the encrypted emergency channel through it.
- If WebRTC cannot cross the resulting NAT, VPN boundary or UDP policy, both peers can still authenticate and exchange encrypted frames through the public Nostr emergency channel. A custom TURN service remains optional.

This is not a claim that every Russian ISP, VPN node or third-party relay will be online forever. The exact two physical computers were not available to this audit. The code paths were validated deterministically, against the active local Karing proxy, and against current public endpoints as described below.

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

- `npm test`: PASS, 250 tests.
- `npm run lint`: PASS.
- Active Windows proxy read: `ProxyEnable=1`, `ProxyServer=127.0.0.1:10809`.
- Real WSS through that detected local system proxy: PASS to `wss://nos.lol`, with target TLS validation enabled.
- Independent-process public Nostr/WebRTC smoke: PASS.
- Independent-process public MQTT/WebRTC smoke with primary signalling and emergency relay disabled: PASS through the detected system proxy.
- Public endpoint probe: 9/10 pre-fix Nostr WSS candidates passed DNS, TCP, TLS and WebSocket upgrade; `relay.damus.io` returned HTTP 503 and was removed. The resulting 9/9 release list then passed the same probe.
- UDP STUN binding: PASS for both configured Google endpoints and Cloudflare from the release network.
- Custom TURN Allocate: NOT RUN because no user-owned TURN credentials were configured.
- Physical Flowseal computer ↔ physical Karing computer: NOT RUN because those two endpoints were not available in this environment.

## Operational guidance

Use Karing TUN when possible. For Karing system-proxy mode, enable **Auto Set System Proxy** before pressing Join; Pair Notebook refreshes it at that moment. If diagnostics still show `Direct`, set `pairNotebook.proxyUrl` to the local listener shown by Karing (commonly an HTTP/mixed port such as `http://127.0.0.1:10809`) and run **Pair Notebook: Reconnect**.

Flowseal/zapret presets require no Pair Notebook address or port. If a custom preset excludes or damages all configured public WSS hosts, the preset itself must be changed; an extension cannot make an unreachable third-party endpoint reachable. Multiple Nostr relays, MQTT discovery, optional TURN and the encrypted emergency path reduce that external dependency but cannot eliminate it.

## Primary sources

- [Flowseal/zapret repository and presets](https://github.com/Flowseal/zapret-discord-youtube)
- [zapret DPI-evasion documentation](https://github.com/bol-van/zapret/blob/master/docs/readme.en.md)
- [Karing FAQ: system proxy versus TUN](https://github.com/KaringX/karing-docu/blob/main/docs/faq.md)
- [Microsoft WinINet preconfigured proxy behavior](https://learn.microsoft.com/en-us/windows/win32/wininet/enabling-internet-functionality)
- [VS Code network and extension proxy behavior](https://code.visualstudio.com/docs/setup/network)
- [Trystero configuration and restrictive-network guidance](https://github.com/dmotz/trystero)
- [Trystero MQTT strategy source](https://github.com/dmotz/trystero/blob/main/packages/mqtt/src/index.ts)
- [MQTT.js WebSocket client documentation](https://github.com/mqttjs/MQTT.js/blob/main/README.md)
