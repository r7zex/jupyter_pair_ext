# Server release 0.6.7 verification

This report separates executed container/API tests from installed VS Code, real public ACME issuance and physical-computer acceptance. No configuration changes were made to the existing VPN/bot server, SSH, firewall or routes.

Baseline: GitHub main and latest release v0.6.6 at ca79de30c7df504de78e000e345c7ccf150c0edf. Existing worktrees and untracked output directories were preserved in place; implementation uses a separate worktree.

## Startup failure diagnosis

The original Windows VS Code **Developer: Show Running Extensions** view displayed Pair Notebook **0.6.5**, activation 2623 ms. This is an activated Extension Host observation, not an inference from the installed-extension registry. Existing logs record activation on `onFileSystem:pair-vps` at 2026-10-16 17:26:27 (Europe/Moscow), repeated HTTP 426 and the failed save of `test.ipynb`. The dirty notebook was left open without saving, discarding, closing or reloading it. The existing server's trusted HTTPS health response succeeded but lacked version/protocol metadata; its exact deployed build cannot be established from that response. The new build logs the activated version, extension path and protocol explicitly.

An additional read-only SSH probe identified the running systemd server PID and working directory, and the deployed clean BUILD manifest as **0.6.6 / ca79de30c7df504de78e000e345c7ccf150c0edf**. Its CLI file timestamp preceded service startup. No service was restarted or configuration changed.

The exact 0.6.6 server condition is `notebookSync` on a zero-cell document with no CRDT bootstrap, where an old client sends neither `bootstrapEmpty: true` nor an update/snapshot/intent/stateVector. The server deliberately returns 426 to preserve the client's unsaved first cell. Heartbeat succeeds independently, explaining the contradictory connected notification. The new client checks compatibility and prepares restored notebooks before announcing readiness.

## Executed isolated acceptance

Sanitized machine-readable results are in [evidence/server-0.6.7](evidence/server-0.6.7). Tests used systemd containers on Docker in WSL2 on one physical Windows computer, x86_64. They exercise real Linux services, bubblewrap, Jupyter, TLS and WebSockets. They do not establish bare-metal, ARM64 or multi-computer behavior. Installer archives were built from the release branch during development; exact immutable release artifacts are separately built and checked by the release workflow.

| Target | Full installation | Relay only | Repeat/check/repair/update/rollback |
| --- | --- | --- | --- |
| Ubuntu 24.04 LTS x86_64 | Passed, isolated Jupyter returns 42 | Passed, no worker runtime/unit | Passed |
| Debian 12 x86_64 | Passed, isolated Jupyter returns 42 | Passed, no worker runtime/unit | Passed |

Both full installations created a durable project with the owner's credential, joined a second member by invitation and retained member file access after repair, update and rollback. An intentionally valid-hashed but non-starting server update failed and automatically restored the working previous server, owner credentials and project data. Ubuntu repair also replaced a deliberately broken private Node executable.

Ubuntu full and Debian relay installations preserved an unrelated listener's PID on port 443 and used HTTPS 8443. Installation checks required trusted TLS, an actual WebSocket 101 handshake, AES-GCM encrypted exchange, reconnect with the same identity and a second exchange. Full mode additionally executed and released an isolated kernel before deleting the disposable check project, allowing checks to repeat with the one-kernel budget.

An existing-nginx fixture passed configuration validation/reload, trusted fixture TLS, real encrypted WebSocket exchange and reconnection. Invalid replacement restored the previous working virtual host; the unrelated default site bytes and sentinel service PID were preserved. This used an explicitly trusted test certificate, not public ACME. Existing-Caddy include integration has unit/static coverage but no separate live public-host acceptance.

The extracted relay-only archive ran without `node_modules` or Python/Jupyter and rejected session RPC. Installer unit tests cover unsafe archives, checksums, private writes, IPv4/IPv6 endpoints, TLS routes, CGNAT rejection and occupied ports. Node 22 regression tests verify signed X.509 IP identities, including IPv6, and reject spoofed printable SAN strings. Production dependency audit reported zero vulnerabilities. Python bridge unit tests passed (9 tests).

## Collaboration and timing

Live API acceptance created a project, joined a participant without an administrative key, rejected the legacy empty-notebook request without changing bytes, preserved the capable client's unsaved first cell, applied 60 concurrent same-line/same-cell edits without a line lock, executed the jointly edited cell to produce 42, and retained edits/output across leave and reconnect.

Two independent logical clients ran **in one Node process on the same physical host**, over HTTPS to the isolated Linux server, with concurrent local test load. Each series has 60 samples:

| Measurement | Median ms | p95 ms | Worst ms |
| --- | ---: | ---: | ---: |
| Synchronous local Y.Text insertion | 0.045 | 0.284 | 0.881 |
| Server acknowledgement | 67.601 | 77.370 | 93.182 |
| Second logical client observes edit | 68.677 | 79.109 | 109.108 |

The first measurement excludes physical keyboard input, VS Code scheduling and pixel rendering. These figures do not establish a universal under-100-ms bound or two-physical-computer latency. The existing synchronization algorithm was preserved.

## VS Code and release verification boundaries

Actual Extension Host CI runs exercise Windows stable, Linux stable, minimum supported VS Code 1.95 and macOS stable. New checks assert the activated manifest version and startup read-only provider. CI executes the full tests with `--forbid-pending`, packaging checks, the Python bridge and production dependency audit. Exact commit/run results are linked from PR #29 and the release workflow; failed checks are not treated as acceptance.

A locally packaged 0.6.7 VSIX was installed only into an isolated test profile. Its Extension Host activated 0.6.7 and logged the actual installation path/protocol. A fixture for the full native owner/participant flow did not complete because its local test CA/transport setup did not provide a reliable native trust environment. No full native onboarding or installed 0.6.5 dirty-first-cell upgrade success is claimed. API and unit regression coverage establish bootstrap/data-preservation behavior, but do not substitute for that UI acceptance. The original user profile and globalStorage were not reset or upgraded.

Public domain/IP modes use documented Certbot 5.4+ HTTP-01 support, including `--ip-address` and the `shortlived` profile for IP certificates, with hourly renewal checks. Installing current Certbot 5.8.0 in an isolated Ubuntu environment confirmed the actual IP, profile and webroot CLI options. **Real public domain/IP issuance, renewal and reachability from an external participant network were not exercised:** no isolated public host/domain was available. LAN trust used real certificates; TLS verification was never disabled. NAT/CGNAT and external reachability limits are disclosed in installer output and setup instructions.

ARM64, physical Linux computers, two physical VS Code clients, an existing production-server migration, and a source-specific 24-hour soak remain unverified. Manual 0.6.6 layouts are detected rather than silently adopted; use an explicit backed-up migration or the existing manual upgrade procedure.
