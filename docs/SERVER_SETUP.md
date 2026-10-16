# Install your own Pair Notebook server

The server can be a dedicated server, a physical Linux computer, a cloud machine or a LAN host. No VPS provider is required. The interactive installer supports **Ubuntu 24.04 LTS and Debian 12 with systemd**, on x86_64 or aarch64. Other distributions, Windows/macOS servers and ordinary containers are not supported installer targets. Container acceptance is an isolated systemd test, not physical hardware acceptance. Architecture and OS testing details are recorded in the release verification report.

## First installation

Log into the server with an account allowed to use sudo. Run:

```sh
curl -fL --proto '=https' --proto-redir '=https' https://github.com/r7zex/jupyter_pair_ext/releases/download/v0.6.7/pair-notebook-install.sh -o pair-notebook-install.sh && sudo sh pair-notebook-install.sh
```

The downloaded launcher checks the OS and privileges, installs Python if necessary, verifies the installer checksum and opens the interactive installer. Nothing is built from source. The installer downloads the matching dependency-bundled server, verifies its checksum and file manifest, installs a private Node.js 22 runtime and Caddy, separate service identities and secrets, an isolated Python/Jupyter worker, systemd startup, TLS and all required routes. SSH, firewall rules, VPN services, routes and unrelated service units are not modified.

If curl is absent, download `pair-notebook-install.sh` from the release in a browser, transfer it to the server and run `sudo sh ./pair-notebook-install.sh`. The launcher installs its missing download dependencies itself.

Enter only the connection mode, server address, private broker port (default 8787), and installation confirmation. In existing-proxy mode select the supported proxy. Full installation also accepts the Let's Encrypt subscriber agreement for public certificates. No configuration file editing is required.

After local checks, the installer prints the HTTPS origin and the administrative credential. Keep the root-only recovery file `/var/lib/pair-notebook-install/owner-server.json`. The credential authorizes creating projects on this server; it is not a participant credential. Do not paste it into an invitation or public issue.

Install the release VSIX on each computer and reload VS Code when prompted. The extension's output channel logs the version and path actually activated by Extension Host. The installed extension list alone does not establish the active version.

1. Owner: run **Pair Notebook: Create Server Project**. Enter the printed HTTPS origin and administrative credential, then a project name and a session password of at least 12 characters.
2. Participant: run **Pair Notebook: Connect to Server**, then use the invitation or the server origin and project password. The participant does not need SSH, the administrative credential or the worker secret.
3. Open a notebook, edit the same cell together and select the server CPU to run it.
4. **Leave Server Project** leaves the server data running. Explicit leave is remembered after restart. **Configure Server Connections → Forget connection** removes only the saved local identity; it does not delete server data or local history. **Manage Server Project → Delete** is a separate, confirmed owner operation.

## Address and TLS choices

- **domain**: point every public A/AAAA record to the server. Incoming TCP 80 and the chosen HTTPS port (default 443) must reach this machine. Certbot issues a publicly trusted certificate using HTTP-01 and automatically renews it. Incorrect DNS or inaccessible ACME validation fails installation.
- **ip**: supply a globally routable IPv4 or IPv6 address. Certbot 5.4+ requests a Let's Encrypt `shortlived` IP certificate and an hourly systemd timer checks renewal. Private, reserved and CGNAT addresses are rejected in this mode. No invented DNS name is needed.
- **lan**: use the LAN hostname or private IP. Caddy creates a private local CA and renews server certificates. Each client must trust `/etc/pair-notebook/local-ca.crt`; certificate verification is never disabled. Transfer that public certificate over a trusted channel, verify its SHA-256 fingerprint on the server, and install it into the client's trusted roots. On Windows: `certutil -user -addstore Root local-ca.crt`, then fully restart VS Code. On Debian/Ubuntu clients: copy it to `/usr/local/share/ca-certificates/pair-notebook-local.crt` and run `sudo update-ca-certificates`. On macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain local-ca.crt`, then restart VS Code. The CA private key stays on the server.
- **proxy**: automatic integration supports existing Caddy (`/etc/caddy/Caddyfile`) or nginx (`/etc/nginx/conf.d`), adding a separate virtual host with validation and backup. Caddy integration uses a new public domain; nginx also supports a public IP through managed Certbot. An existing hostname collision is rejected. Other proxy implementations are preserved and are not currently claimed as automatic installation targets. Managed public-IP certificates use the dedicated proxy mode; existing-Caddy mode uses Caddy's own certificate management.

Ports are checked before installation. If managed HTTPS port 443 is busy, the installer offers an alternative (default 8443); the printed origin includes that port. You can also enter an explicit origin such as `https://192.168.1.20:8443`. LAN mode does not require port 80. Public certificates still require incoming TCP 80 for HTTP-01. Other conflicts produce an actionable error; the installer never stops the process that owns the port. A server behind NAT requires forwarding TCP 80 and the selected HTTPS port; CGNAT cannot be solved by issuing a certificate. Use LAN access or arrange a publicly reachable endpoint. A valid certificate or a request from the server to itself does not prove reachability from another network.

Node.js 22.15+ clients include explicitly trusted OS certificates. With an older embedded Node runtime, start VS Code with `NODE_EXTRA_CA_CERTS` pointing to the transferred CA file, or update VS Code. This adds trust without bypassing certificate verification.

Before inviting participants, run the packaged check **from their network**, using Node.js 20+:

```sh
node server/out/src/vps/relayCheck.js https://YOUR_SERVER
```

It requires a real WebSocket 101 upgrade, AES-256-GCM message exchange, a disconnect, reconnection using the same identity and a second exchange. The installer runs this locally and through the configured HTTPS origin; external client reachability must be checked separately. Installation output clearly distinguishes these scopes.

Official TLS references, checked during development:

- [Let's Encrypt: six-day and IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Let's Encrypt: Certbot IP support and renewal](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
- [Caddy: local HTTPS and trust](https://caddyserver.com/docs/automatic-https)

## Check, repair, update and rollback

Rerun the same downloaded command. Existing installations offer **check**, **repair**, **update** and **rollback**. Projects and owner credentials stay in their original storage. Releases use separate versioned directories and an atomic `server` symlink. Downloads and hashes are verified before stopping Pair services; a failed upgrade restores the previous binary, configurations and previously running Pair services and checks their health. A private project backup is retained. Project data is not replaced with an older snapshot during automatic rollback, so edits accepted during a brief upgrade are retained. No storage migration is introduced in 0.6.7.

Update stops Pair workers and may interrupt active kernels. Schedule it while participants are idle. This does not stop unrelated services. Old manual deployments are not silently adopted: if the broker port or installation path is occupied, use the existing manual upgrade procedure in `PERSISTENT_VPS.md`, or install the new layout on an isolated host and migrate a consistent backed-up data directory explicitly.

The installer deliberately keeps the admin token outside notebook execution. Worker sandbox checks fail closed if user/mount namespaces are unavailable. On Ubuntu, a profile for a private Pair-only bubblewrap binary permits its user namespace without changing the system-wide user-namespace sysctl.

## Relay only

Run the same installer with `--mode relay`:

```sh
curl -fL --proto '=https' --proto-redir '=https' https://github.com/r7zex/jupyter_pair_ext/releases/download/v0.6.7/pair-notebook-install.sh -o pair-notebook-install.sh && sudo sh pair-notebook-install.sh --mode relay
```

This installs the ready relay service and TLS without Python/Jupyter worker packages. Python itself is used only by the installer. For an existing managed TLS proxy and Node.js 20+, the extracted server package also supports:

```sh
PAIR_VPS_BIND=127.0.0.1 PAIR_VPS_PORT=8787 node server/out/src/vps/relayCli.js
```

Forward `/v1/temporary-relay` with WebSocket upgrade support and `/health` from your HTTPS proxy. The standalone relay rejects session RPC and legacy administrative relay routes. Set **Pair Notebook: Relay Url** to its HTTPS origin; the last connected server is used when the setting is empty. Temporary invitations carry this origin, never the administrative credential. Existing P2P and encrypted transports remain available; the UI distinguishes direct and relayed paths. A relay reachable by both participants provides a fallback route, not a promise of direct P2P.

## Restored projects and unsaved notebooks

The `pair-vps` URI scheme, existing command identifiers, settings, credentials and local histories are retained. The UI calls these server projects. Before mounting an editable project the client negotiates protocol support, checks membership, project state and snapshot availability, and initializes restored notebooks. Version 0.6.7 requires a server with compatibility discovery (0.6.7+); older servers produce one update action before editing begins.

**Pair Notebook: Server Restore** has `automatic`, `ask` and `manual` modes. Automatic startup retries transient failures at bounded backoff, then waits for an explicit reconnect. Revoked membership, deleted projects and protocol incompatibility stop retries. Explicit leave disables automatic restoration of that saved identity. Forgetting it does not clear journals, dirty editors or server data. The old 0.6.5 empty-notebook request returns 426 on 0.6.6 because it lacks the `bootstrapEmpty` capability; keep the unsaved editor open while updating, and let the new client reconcile the first cell. Never delete globalStorage or discard a dirty notebook to solve a compatibility error.
