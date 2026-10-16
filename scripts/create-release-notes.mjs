import fs from 'node:fs';

const [version, outputPath] = process.argv.slice(2);
if (!version || !outputPath) {
  console.error('Usage: node scripts/create-release-notes.mjs <version> <output-path>');
  process.exit(1);
}

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
const changelogLines = changelog.split('\n');
const heading = `## ${version}`;
const sectionStart = changelogLines.findIndex(
  (line) => line === heading || line.startsWith(`${heading} `),
);
const nextSection = sectionStart < 0
  ? -1
  : changelogLines.findIndex((line, index) => index > sectionStart && line.startsWith('## '));
const sectionEnd = nextSection < 0 ? changelogLines.length : nextSection;
const changes = sectionStart < 0
  ? ''
  : changelogLines.slice(sectionStart + 1, sectionEnd).join('\n').trim();

if (!changes) {
  console.error(`CHANGELOG.md has no release notes for version ${version}.`);
  process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY;
const tag = `v${version}`;
const vsixName = `pair-notebook-${version}.vsix`;
const downloadUrl = repository
  ? `https://github.com/${repository}/releases/download/${tag}/${vsixName}`
  : undefined;
const downloadLink = downloadUrl
  ? `[Download ${vsixName}](${downloadUrl})`
  : `\`${vsixName}\``;

const notes = `# Pair Notebook ${version}

Ready-to-install VS Code extension with all collaboration runtime dependencies bundled.

## Install

Install this version on every participating computer.

1. ${downloadLink}.
2. In VS Code, run **Extensions: Install from VSIX...**.
3. Select the downloaded file and reload VS Code when prompted.

Or install it from a terminal:

\`\`\`text
code --install-extension ${vsixName} --force
\`\`\`

## What's changed

${changes}

## Install your own server

On Ubuntu 24.04 LTS or Debian 12 with systemd, run:

\`\`\`sh
curl -fL --proto '=https' --proto-redir '=https' https://github.com/${repository || 'r7zex/jupyter_pair_ext'}/releases/download/${tag}/pair-notebook-install.sh -o pair-notebook-install.sh && sudo sh pair-notebook-install.sh
\`\`\`

Choose domain, public IP, LAN or an existing supported proxy and enter the server address. The installer prints the owner connection data after local readiness checks. Use \`--mode relay\` for a relay without a Jupyter worker. See \`SERVER_SETUP.md\` for certificate trust, external reachability, repair/update/rollback, owner and participant steps, and verification limits.

## Download

- \`${vsixName}\` — install this extension on every participating computer. GitHub displays its SHA-256 digest next to the file.
- \`pair-notebook-complete-${version}.zip\` — full source and matching compute agent for compute owners. Update editors, broker and agent together.
- \`pair-notebook-server-persistent.tar.gz\` and its \`.sha256\` file — the matching dependency-bundled server, interactive agent and service templates for server operators. Follow \`docs/PERSISTENT_VPS.md\` in the archive; preserve existing data and take a backup before updating.
- \`pair-notebook-install.sh\` and \`pair-notebook-install.pyz\` — interactive installer and verified launcher.
- \`pair-notebook-relay.tar.gz\` — standalone prebuilt relay: extract and run \`node relay/relay.js\` behind HTTPS; \`node relay/check.js https://SERVER\` verifies encrypted exchange and reconnect.
- \`SHA256SUMS\` and \`SERVER_SETUP.md\` — checksums and beginner instructions.

GitHub also adds automatic **Source code** archives. They are for reading the source and cannot be installed as a VS Code extension.

## Verification

GitHub Actions publishes this release only after a clean dependency install, Python bridge tests, production dependency audit, TypeScript lint/build/tests, and packaged extension/server validation succeed. Physical UI acceptance, macOS compute and an actually completed 24-hour soak are separate from this release gate; see the current acceptance document in the source archive.
`;

fs.writeFileSync(outputPath, notes, 'utf8');
console.log(`Release notes written to ${outputPath}.`);
