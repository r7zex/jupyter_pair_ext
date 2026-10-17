# Pair Notebook 0.6.10 verification

## Changes

1. Primary landing actions use the same yellow accent across VS Code themes. Secondary session controls retain the existing self-host layout.
2. Crossed primary/MQTT admissions retain both authenticated pending handshakes until admission, then converge on the primary family during initial settling. A rejected duplicate handshake is not reported as successful to Trystero. Existing relay routes and explicit route upgrades retain their incumbent rules.
3. Trystero pings have a deadline; one unresolved library promise cannot suspend all subsequent probes. Encrypted relay peers must answer application heartbeats. Repeated failures enter the existing logical recovery lease and no longer appear green/online.
4. Join stages an empty extension-owned workspace. Networking and host file download remain blocked until Workspace Trust. The runtime can re-request missing initial state, with separate idle and maximum transfer limits. Guest workspaces and adjacent journals are retired on leave, failed join or editor exit. A detached cleanup worker retries busy Windows folders; later activation retries abandoned requests. It validates ownership, path segments and directory links before removal. Host source folders are excluded.
5. The Windows WS launcher lists active adapter addresses and recommends physical LAN interfaces before VPN/virtual ones. Manual domain/IP entry remains available. The README includes Karing custom routing instructions and distinguishes LAN reachability from public Internet access.
6. Setup retains its verified manager zipapp and installs `pair-notebook-server check/update`. Updates verify this repository's stable GitHub release asset URL, size and SHA-256 digest over HTTPS before invoking matching setup. An optional daily timer is disabled by default, defers while saved projects run and requires explicit updates for relay-only servers. Removal also removes the manager and timer.

## Verification scope

Regression tests exercise crossed signalling admission, single logical participants, frame delivery, never-resolving WebRTC probes, silent relay peers, initial-state retries, progressing transfers, trust-before-download and ownership-constrained guest cleanup. Python updater tests cover release identity, HTTPS redirects, checksum rejection, successful version checks, busy-project deferral and manager/timer installation. PowerShell tests check physical-address recommendation with Karing TUN present.

Release gates are the complete Linux suite, bridge/installer/removal/updater tests, package manifests, production dependency audit and native VS Code Extension Host workflows on Windows, Linux stable/minimum and macOS. Exact results are available in the linked release's GitHub Actions runs. Local Windows full-suite failures are retained as diagnostics and do not count as passing Linux acceptance.

Local checks use this workstation and disposable systemd containers. They do not establish the user's physical laptop/desktop Wi-Fi + Karing TUN behavior, ARM execution, fresh public ACME issuance or a new 24-hour soak. Workspace Trust approval remains a user action; tests do not disable or bypass it. The extension and launcher do not modify the user's VPN, routing or firewall.
