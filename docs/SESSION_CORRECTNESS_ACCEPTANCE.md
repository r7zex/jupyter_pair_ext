# Session correctness investigation

Baseline: upstream `5b8617d`, client source and deployed server 0.6.10. The original checkout's untracked `out/` is preserved. Work is isolated in `pair-session-fixes`. No publication or production restart is implied by this report.

## Before-change hypothesis matrix

User reports are observations supplied with the task, not yet reproduced on two physical computers. Each hypothesis requires its own behavioral check.

| Section / reported symptom | Reproduction | Hypothesis to test | Discriminating check |
| --- | --- | --- | --- |
| 2 / member execution barrier refusal | Pending two-client fixture | Requester has not received executor-only directories/files; readiness and transport are conflated | Delay initial state, include empty directory/binary, compare manifest paths/types/hashes; verify one execution |
| 3 / caret and name inside code | Renderer source confirms exact-cursor branch | Optional exact-cursor rendering overrides whole-line mode | Run actual renderer with exact cursor, relative anchors, notebook cells and peer departure |
| 4 / newer-content on Save | Pending real editor reproduction | A physical write bypasses an open notebook's VS Code working copy | Trace all writers; save concurrent edits/outputs and independently modify disk |
| 5 / pip CA failure | Pending isolated kernel reproduction | Sandbox lacks CA/network/writable package environment | Inspect actual isolated interpreter, CA, DNS, HTTPS, pip destination and restart |
| 6 / truncated Copy button | Dashboard source confirms text button | Flexible text action shrinks in password row | Render narrow sidebar, keyboard, clipboard and stale password reply |
| 7 / slow join and false reconnecting | Pending timed route fixture | Failed route improvement overrides a healthy authorized relay | Delay/drop only candidate direct route; measure working route and readiness independently |
| 8 / public server access | HTTPS health returned 200 with normal TLS | Public endpoint works; protocol still needs a separate check | Authenticated project RPC, encrypted relay and isolated Jupyter without endpoint changes |
| 9 / ipykernel setup failure | Source pins 7.4.0; installation reproduction pending | Selected Python/index cannot resolve pinned release | Query sanitized index metadata and perform installation with actual WSL interpreter |
| 10 / unclear compute setup | User report; dialogs to inspect | Installation root, project root and sharing are mixed in prompts | Exercise normal setup, ready runtime, cancellation and Retry |
| 11 / indistinguishable run recovery | Source confirms notebook plus UUID only | Saved entries omit meaningful run context | Recover distinct accepted runs; verify cell identity and no rerun |
| 12 / unclear upload | Dialog inspection pending | Visibility and destination lack explicit explanation | CSV/folder upload, collision, private/shared listing and relative read |
| 13 / kernel outside session | Source confirms unconditional controller registration | Controller lifetime is activation-wide | Installed VSIX picker before join/after leave plus unrelated notebook while joined |
| 14 / owner cleanup | Source confirms guest-only temporary-root predicate; VPS leave removes virtual root | Temporary ownership is incorrectly inferred from role | Managed host/member roots vs original source folder; late callbacks and multi-root leave |

## Baseline environment

- Windows host: WSL Ubuntu-22.04 is available. No running Code.exe was found at inspection; registration of 0.6.10 is confirmed, activation in a currently running user Extension Host is not.
- VPS: HTTPS `https://144.172.69.57:9443/health` reports 0.6.10. Pair server, worker, proxy, Xray and VPN-manager are active. Pair listens on loopback 8788 and public 9443; VPN-manager owns 8787 and Xray owns TCP 443/8443.
- No VPN, route, firewall, SSH, unrelated service or existing project changes have been made.
- A second physical computer is not available to this agent; logical clients cannot establish physical Karing TUN acceptance.

Further entries below must distinguish source/unit checks, installed UI checks, isolated real-kernel checks, live production changes and downloaded-release verification.
