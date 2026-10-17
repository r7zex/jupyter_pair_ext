# Pair Notebook 0.6.9 verification

## Behavior

- The server dashboard shares the self-host header, participant cards, compute card and section styling. It shows a VPS host, the named project owner and the current notebook's shared/private kernel.
- Connection details contain the server address, owner and password eye/copy control. Passwords are retrieved only after an explicit reveal action and never included in dashboard state, settings or logs.
- New project creation sends the chosen owner name and retains the owner membership returned by the server. Password joining remains a participant operation; local root access does not silently promote a participant identity.
- Local connection metadata moves into extension-owned storage. Uninstall removes cached workspaces/history and its credential encryption key; reinstall starts with no remembered server. User-selected source folders and VPS data remain.
- The full setup includes the relay. The standalone ZIP adds a Windows tray launcher with local TLS, a private verified Node runtime fallback and one-click stop/start.
- Setup/removal downloads delete themselves. Server removal verifies and exports only `.py`/`.ipynb` files, then removes Pair services, credentials, session history and private runtimes. Shared OS packages and unrelated services remain.
- Older adopted installations can also remove verified Pair loop volumes and their exact fstab entries, service overrides, certificate-copy timers and the dedicated journal namespace. Unrecognized mounted storage is rejected before services stop.

## Checks

Release gating uses the complete Linux suite, Python bridge/installer/export tests, archive verification, production dependency audit and the four-platform VS Code Extension Host workflow. Exact results are recorded in the corresponding GitHub Actions runs.

Local checks exercise real encrypted WebSocket exchange/reconnect, isolated Jupyter execution and installer maintenance on a disposable Ubuntu 24.04 systemd container. Windows checks exercise the packaged relay launcher using real TLS, encrypted exchange/reconnect and process shutdown. Local-storage tests verify migration, upgrade, uninstall, reinstall and credential invalidation. Dashboard interaction tests verify escaping, password reveal/hide and conditional Copy.

Native VS Code inspection uses a separate development profile with the user's Monokai Pirokai - Beach Sunset theme. A newly created project shows its chosen owner as the current user and the VPS as host. The sidebar uses the self-host sections, colors and full-width action rows, omits the separate Status section, and measures server response and actual HTTPS payload traffic. Password reveal/hide and conditional Copy were also checked in that editor profile.

Windows full-suite execution has environment-dependent Python/process/filesystem failures and is not counted as a successful Linux release gate. Containers and editor checks on this workstation are one physical host. These checks do not establish two-physical-computer collaboration, ARM execution, a fresh public-host ACME certificate issuance, or a new 24-hour soak.
