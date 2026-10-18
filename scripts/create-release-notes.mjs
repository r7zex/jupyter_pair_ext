import fs from 'node:fs';

const [version, outputPath] = process.argv.slice(2);
if (!version || !outputPath) throw new Error('Usage: node scripts/create-release-notes.mjs <version> <output-path>');
const lines = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n').split('\n');
const start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} `));
const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const changes = start < 0 ? '' : lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
if (!changes) throw new Error(`CHANGELOG.md has no release notes for ${version}.`);
const base = `https://github.com/${process.env.GITHUB_REPOSITORY || 'r7zex/jupyter_pair_ext'}`;
const asset = name => `[${name}](${base}/releases/download/v${version}/${name})`;
const notes = `## Downloads

| Download | Purpose |
| --- | --- |
| ${asset(`pair-notebook-${version}.vsix`)} | Install in VS Code using **Extensions: Install from VSIX...**, then reload. |
| ${asset('pair-notebook-server-setup.sh')} | Install/update your server: projects, isolated Jupyter, HTTPS and WebSocket relay. |
| ${asset('pair-notebook-server-remove.sh')} | Remove Pair services and export Python/notebook files on the VPS. |
| ${asset('pair-notebook-ws-server.zip')} | Standalone encrypted WebSocket server for temporary peer sessions. |

## Set up or update your server

On Ubuntu 24.04 LTS or Debian 12 with systemd, connect over SSH and run:

\`\`\`sh
curl -fL --proto '=https' --proto-redir '=https' ${base}/releases/download/v${version}/pair-notebook-server-setup.sh -o pair-notebook-server-setup.sh && sh pair-notebook-server-setup.sh
\`\`\`

Choose domain or public IP (LAN/existing Caddy/nginx also supported), enter the address and confirm. The utility contains its matching verified server; no separate installer, server-package or checksum downloads are needed. It sets up dependencies, HTTPS and automatic services, then checks real Jupyter execution and encrypted relay reconnect.

Rerun a freshly downloaded utility to check, repair, update or roll back an existing server. Projects and credentials are retained. Lost the owner key after reinstalling the extension? Choose **recover-owner** on the server, then import the private owner JSON. Updates/recovery restart Pair services and stop active Python kernels.

In VS Code use **Pair Notebook: Create Server Project** with the printed address/administrative credential, or **Connect to Server** for an existing project. Participants use an invitation or project password. [Step-by-step guide](${base}/blob/v${version}/docs/SERVER_SETUP.md).

## WebSocket server only

Extract **pair-notebook-ws-server.zip**. On Windows, run **pair-notebook-ws-server.cmd** for a tray server: click its icon to stop/start and trust its generated CA on every client. On Linux, run \`sh pair-notebook-ws-server.sh\`. Set **Pair Notebook: Relay Url** to the HTTPS address and share a temporary-session invitation. A home host needs reachable ports/port forwarding. The full setup already includes this relay.

## Changes

${changes}

[Verification and limits](${base}/blob/v${version}/docs/SERVER_RELEASE_${version.replaceAll('.', '_')}.md). GitHub's automatic source archives are for developers. Detailed build artifacts/internal checksums are retained with the workflow run.
`;
fs.writeFileSync(outputPath, notes, 'utf8');
