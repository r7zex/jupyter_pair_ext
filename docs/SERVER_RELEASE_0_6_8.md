# Pair Notebook 0.6.8 verification

This release packages the VS Code extension, a self-contained server setup utility and a separate WebSocket server ZIP. Existing 0.6.7 release files remain immutable so previous installation commands continue to work.

## User paths

- New server: the shell utility bootstraps missing Python, installs its embedded verified server, isolated Jupyter, HTTPS and automatic services.
- Existing installer-managed server: a newly downloaded utility reuses persistent installation state and offers check, repair, update and rollback independently of the extension installation.
- Existing packaged manual server: documented 0.6.3+ layouts are adopted with backups, retained data, service limits, credentials and HTTPS.
- Extension reinstall with a lost owner key: optional local owner recovery backs up project authority, replaces only the owner credential, verifies access and exports a private importable JSON. No public recovery API is introduced.
- Relay only: the WS ZIP has its own HTTPS/service installer and bundled relay/check programs, without a Jupyter worker. Invitations carry the configured relay origin.

## Verification

Installer boundary/recovery tests and public archive checks run during the release gate. Container acceptance scripts cover clean setup, old-to-new managed upgrades, manual layout adoption, real isolated Jupyter returning 42, owner/member access preservation, Private denial, encrypted WebSocket exchange/reconnect and deliberate update failure with rollback. Exact run results are recorded in the release pull request and CI; a pending/failed run is not acceptance.

These container checks use systemd Linux containers on WSL2/Docker on one physical Windows computer. They do not establish ARM64/bare-metal installation, physical multi-computer editing, a completed 24-hour soak or full Marketplace publication. Public domain/IP certificate support follows the official Certbot HTTP-01 implementation; prior 0.6.7 public issuance/renewal probes do not qualify a fresh 0.6.8 public-host installation. No production-server migration is implied by isolated acceptance.

Server setup, TLS reachability requirements, recovery effects and supported platforms are documented in [SERVER_SETUP.md](SERVER_SETUP.md). Internal SHA-256 checks remain active; separate checksum files are no longer public release assets. GitHub's automatic source archives remain visible.
