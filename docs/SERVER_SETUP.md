# Set up your own Pair Notebook server

Download from the [latest release](https://github.com/r7zex/jupyter_pair_ext/releases/latest). Setup runs on your Linux server over SSH, independently of VS Code. It works for a new user, an existing server or after reinstalling the extension.

Supported: Ubuntu 24.04 LTS or Debian 12 with systemd; x86_64/aarch64. Dedicated, cloud, physical and LAN servers use the same workflow. Other OSes and ordinary containers are not installer targets. [Verification and tested environments](SERVER_RELEASE_0_6_8.md).

## Downloads

| File | Purpose |
| --- | --- |
| `pair-notebook-0.6.8.vsix` | Install on each participating computer with Extensions: Install from VSIX..., then reload. |
| `pair-notebook-server-setup.sh` | Install/update a full server with projects, isolated Jupyter, HTTPS and the encrypted relay. |
| `pair-notebook-ws-server.zip` | Install only the encrypted WebSocket relay, without a Jupyter worker. |

The setup utility includes its matching verified server package. Separate checksum, Python-installer and server-package downloads are unnecessary. GitHub adds source archives for developers.

## New server

Connect over SSH and run:

```sh
curl -fL --proto '=https' --proto-redir '=https' https://github.com/r7zex/jupyter_pair_ext/releases/latest/download/pair-notebook-server-setup.sh -o pair-notebook-server-setup.sh && sh pair-notebook-server-setup.sh
```

If curl is absent, download the file in a browser, transfer it to the server and run `sh pair-notebook-server-setup.sh`. Setup requests sudo when needed and installs missing Python/download dependencies itself. Root accounts do not need sudo installed; no source build is required.

1. Choose domain, public IP, LAN or a supported existing Caddy/nginx proxy.
2. Enter the domain/IP, keep the suggested private port unless occupied, and confirm.
3. Wait for dependencies, HTTPS, automatic services and real execution/relay checks.
4. Keep the printed HTTPS address and administrative credential private.
5. In VS Code run **Pair Notebook: Create Server Project**, enter these data, choose a project name and a password of at least 12 characters.
6. Participants use **Connect to Server** with an invitation or the address and project password. They need no SSH or administrative credential.

Removing the extension does not uninstall or erase the server. Setup does not depend on local VS Code caches or saved connections.

## Domain, IP, LAN and existing services

- **Domain:** point public A/AAAA records to the server. Incoming TCP 80 and the selected HTTPS port must reach it. Setup obtains/renews a trusted certificate.
- **Public IP:** enter a globally routable IPv4/IPv6 address. Certbot 5.4+ obtains a short-lived Let's Encrypt IP certificate; an hourly timer checks renewal. No purchased domain is required.
- **LAN:** enter a private IP/hostname. Transfer the public `/etc/pair-notebook/local-ca.crt` over a trusted channel and trust it on every client. Windows: `certutil -user -addstore Root local-ca.crt`, then fully restart VS Code. Ubuntu/Debian: install under `/usr/local/share/ca-certificates/`, then `sudo update-ca-certificates`. macOS: trust it in Keychain Access. Never transfer the CA private key.
- **Proxy:** existing Caddy/nginx integration adds a separate validated virtual host with backup. Existing hostname collisions are refused. Caddy integration uses a public domain; nginx also supports managed public-IP certificates. Unsupported proxy configurations are preserved and rejected with an actionable error.

If 443 is occupied, setup offers an alternate HTTPS port and prints it in the address. Public ACME validation still requires incoming TCP 80. NAT requires port forwarding; CGNAT needs a reachable public endpoint or LAN mode. Setup does not change SSH, firewall rules, VPN services or network routes, or stop unrelated port owners. Valid TLS/local checks do not prove reachability from another network.

Older embedded Node runtimes may need `NODE_EXTRA_CA_CERTS` pointing to the transferred LAN CA or an updated VS Code. TLS verification is never disabled.

## Update, repair and reinstall

After setup, run `sudo pair-notebook-server check` to check GitHub, or `sudo pair-notebook-server update` to download, verify and install the latest stable release. The installed manager remains available after the setup download removes itself. An older server needs the current setup once to install this command.

For daily updates run `sudo pair-notebook-server auto-update enable`; use `disable` or `status` to control the timer. The timer is disabled by default. Automatic installation is deferred while any saved project is running or work is queued/running. Stop projects through session management before the maintenance window; idle interactive kernels are still stateful. Relay-only servers require the explicit update command because their live participant inventory is not persisted. The manager accepts only this repository's stable GitHub release asset over HTTPS with a matching GitHub SHA-256 digest. Failed checks leave services unchanged; a failed installation uses the installer's rollback.

For repair, rollback or owner recovery, download the current setup utility and run it. Existing managed installations offer **check**, **repair**, **update**, **rollback**, and **recover-owner**. An older utility refuses to downgrade a newer server.

Packaged manual installations from 0.6.3 onward are detected through documented server/environment/service paths. Confirm the HTTPS address and backed-up update. Both server directories and symlinks are supported. Existing ports, projects, identities, service limits, Python environment and HTTPS remain in place. Unsupported layouts fail before services change.

Updates stop Pair workers and active Python kernels. Save needed Python objects and update while participants are idle. Downloads/manifest checks precede interruption. A failed update restores the retained previous server and previously running Pair services without replacing current project data. Root-only backups remain under `/var/lib/pair-notebook-install/backups`. Repair of an adopted manual installation replaces the server payload; it does not rebuild broken pre-existing Node/Python dependencies.

After reinstalling the extension, reconnect a saved identity or use **Connect to Server → Import existing owner / member credential**. Members can join again with an invitation or password.

Removing the extension clears its local connection history, session working copies and credential encryption key. A reinstall starts with no remembered hosts. Keep an owner credential outside extension storage if you want to import it later, or use server-side owner recovery. User-selected project folders and server files are not removed by extension uninstall. **Pair Notebook: Forget All Connections and Local Caches** performs an explicit local reset without uninstalling.

The dashboard uses the same layout as a self-host session. **VPS** is the host; **Owner** names the project creator. Creating a project asks for your owner name and retains the returned owner membership. Joining with a password creates a participant membership. The password eye toggles visibility; Copy appears only while visible. Passwords entered during creation/join are encrypted in client SecretStorage. A password cannot be recovered from its server hash; an owner who imports an old key can set a new password under **More actions**.

**Compute** names the active notebook and its **Shared** or **Private** kernel. Shared variables/results belong to everyone with access to that notebook; Private execution is owner-only. **Restart shared/private kernel** targets that notebook and clears its variables after confirmation. Ordinary results appear in notebook cells. **Recover interrupted run**, under More actions, handles a previously accepted execution after a disconnect.

## Remove the server

Download `pair-notebook-server-remove.sh` from the release and run it on the VPS:

```sh
sh pair-notebook-server-remove.sh
```

Confirm **yes**. Only `.py` and `.ipynb` files are exported into `/root/pair-notebook-files/<timestamp>/`, retaining project paths and restricted access. Their contents are verified before removal. Then Pair services, session data, credentials, history, caches, certificates and private runtimes are removed. Shared OS packages, SSH, firewall rules, VPN and unrelated services remain. Download setup again to start fresh. Setup/removal shell downloads delete themselves after use.

If the owner's local credential was lost, choose **recover-owner**, select the project and explicitly confirm. Only that project's owner key is replaced; old owner credentials stop working. Files, ownership identity and other participants remain. Copy the printed private owner JSON securely to your computer and import it with **Connect to Server**. Recovery requires local server-administrator access; it is not a public project-takeover API.

## WebSocket server

On Windows, extract the ZIP and double-click **pair-notebook-ws-server.cmd**. Enter the hostname/IP clients will use. The tray icon starts/stops the server with one left click; its menu copies the HTTPS address, opens the trust certificate and exits. Node 20+ is used when available; otherwise a private Node runtime is downloaded and checksum-verified. Trust `server/relay-ca.crt` on each client (Windows: `certutil -user -addstore Root server\relay-ca.crt`) and restart VS Code. The Windows launcher uses local TLS trust; public access additionally requires reachable ports/forwarding. **Exit** stops the relay; temporary broker files are removed. The portable `server` directory holds one address/certificate configuration, not past sessions.

The full setup already includes `/v1/temporary-relay`. For relay-only deployment, extract `pair-notebook-ws-server.zip` and run:

```sh
sh pair-notebook-ws-server.sh
```

This installs HTTPS and automatic service startup without Jupyter. The full setup also accepts `--mode relay`. Set **Pair Notebook: Relay Url** (`pairNotebook.relayUrl`) to the printed HTTPS address, start a temporary session and share its invitation. Guests receive the relay address automatically. The extension uses it as an available fallback when direct transport fails. Contents remain end-to-end encrypted; the relay does not execute notebooks or store persistent projects.

Host it on a public VPS or another reachable Linux machine. A home host behind NAT needs forwarding; CGNAT needs another public route. The ZIP also includes bundled `relay.js` and `check.js` for Node.js 20+ behind an existing HTTPS proxy. Forward `/v1/temporary-relay` with WebSocket upgrade support and `/health`. From a participant's network run `node check.js https://YOUR_SERVER`. It requires WebSocket 101, AES-GCM exchange, disconnect, authenticated reconnect and another exchange. An open port/HTTP 200 alone is insufficient.

## Saved connections

**Leave Server Project** preserves server data and is remembered after restart. **Configure Server Connections → Forget connection** removes only the local identity; **Manage Server Project → Delete** separately confirms server deletion. Keep dirty editors and local journals during upgrades; never delete globalStorage as a compatibility workaround. Interrupted managed setup offers repair. **Pair Notebook: Server Restore** supports automatic, ask and manual reconnection with bounded retries.

Official TLS references: [Certbot IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https).
