// Public downloads contain their own verified server and installer payload.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';

export async function packageServerSetup({ root, installer, artifacts, relay, version }) {
  const payload = path.join(installer, 'pair_installer/payload');
  await fs.mkdir(payload, { recursive: true });
  for (const name of ['pair-notebook-server-persistent.tar.gz', 'pair-notebook-server-persistent.tar.gz.sha256']) {
    await fs.copyFile(path.join(artifacts, name), path.join(payload, name));
  }
  const pyz = path.join(artifacts, 'pair-notebook-install.pyz');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipapp', installer, '-o', pyz, '-p', '/usr/bin/env python3', '--compress'], { stdio: 'inherit' });
  const bytes = await fs.readFile(pyz);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const template = (await fs.readFile(path.join(root, 'deploy/install.sh'), 'utf8')).replace(/\r\n/g, '\n');
  const encoded = bytes.toString('base64').match(/.{1,76}/g).join('\n') + '\n';
  const setup = mode => template.replace('__PAIR_VERSION__', version)
    .replace('__PAIR_DEFAULT_MODE__', mode).replace('__PAIR_INSTALLER_SHA256__', digest) + encoded;
  await fs.writeFile(path.join(artifacts, 'pair-notebook-server-setup.sh'), setup('full'), { mode: 0o755 });
  await fs.writeFile(path.join(relay, 'pair-notebook-ws-server.sh'), setup('relay'), { mode: 0o755 });
  await fs.writeFile(path.join(relay, 'README.md'), `# Pair Notebook WebSocket server ${version}

Run your own encrypted fallback relay when direct peer connections are unavailable.

On Ubuntu 24.04 LTS or Debian 12 with systemd:

\`\`\`sh
sh pair-notebook-ws-server.sh
\`\`\`

Choose domain or public IP and enter your address. Setup installs HTTPS and an automatic background service, without a Jupyter worker. TCP 80 and the selected HTTPS port must reach this server. A home computer behind NAT needs port forwarding; CGNAT requires another reachable server.

In VS Code set Pair Notebook: Relay Url (pairNotebook.relayUrl) to the printed HTTPS origin, then create a temporary session and share its invitation. Participants receive the relay address automatically. Session contents remain end-to-end encrypted. This relay forwards collaboration; it does not run notebooks or store persistent projects. The full server setup already includes this relay.

For an existing HTTPS reverse proxy and Node.js 20+, run \`node relay.js\` with PAIR_VPS_BIND=127.0.0.1 and PAIR_VPS_PORT set to your private port. Forward /v1/temporary-relay with WebSocket upgrade support and /health. Verify with \`node check.js https://YOUR_SERVER\` from a participant's network.
`);
  const names = ['pair-notebook-ws-server.sh', 'relay.js', 'check.js', 'README.md', 'LICENSE'];
  const manifest = JSON.parse(await fs.readFile(path.join(relay, 'BUILD.json'), 'utf8'));
  manifest.files = {};
  for (const name of names) manifest.files[name] = createHash('sha256').update(await fs.readFile(path.join(relay, name))).digest('hex');
  await fs.writeFile(path.join(relay, 'BUILD.json'), JSON.stringify(manifest, null, 2) + '\n');
  const zip = new yazl.ZipFile();
  const output = path.join(artifacts, 'pair-notebook-ws-server.zip');
  const handle = await fs.open(output, 'w');
  await new Promise((resolve, reject) => {
    const stream = handle.createWriteStream();
    stream.on('error', reject); zip.outputStream.on('error', reject);
    stream.on('close', resolve); zip.outputStream.pipe(stream);
    for (const name of [...names, 'BUILD.json']) {
      zip.addFile(path.join(relay, name), name, { mode: name.endsWith('.sh') ? 0o100755 : 0o100644 });
    }
    zip.end();
  });
}
