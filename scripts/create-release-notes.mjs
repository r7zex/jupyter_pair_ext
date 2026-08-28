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
const downloadUrl = repository
  ? `https://github.com/${repository}/releases/download/${tag}/pair-notebook.vsix`
  : undefined;
const downloadLink = downloadUrl
  ? `[Download pair-notebook.vsix](${downloadUrl})`
  : '`pair-notebook.vsix`';

const notes = `# Pair Notebook ${version}

Ready-to-install VS Code extension with all collaboration runtime dependencies bundled.

## Install

Install this version on every participating computer.

1. ${downloadLink}.
2. In VS Code, run **Extensions: Install from VSIX...**.
3. Select the downloaded file and reload VS Code when prompted.

Or install it from a terminal:

\`\`\`text
code --install-extension pair-notebook.vsix --force
\`\`\`

## What's changed

${changes}

## Downloads

- \`pair-notebook.vsix\` — stable filename for downloading the latest release directly.
- \`pair-notebook-${version}.vsix\` — the same ready-to-install extension with its version in the filename.
- \`pair-notebook-complete-${version}.zip\` — source snapshot, documentation, tests, and the packaged extension.
- \`SHA256SUMS.txt\` — checksums for verifying downloaded files.

## Verification

GitHub Actions publishes this release only after a clean dependency install, Python bridge tests, production dependency audit, TypeScript lint/build/tests, and packaged-artifact validation succeed.
`;

fs.writeFileSync(outputPath, notes, 'utf8');
console.log(`Release notes written to ${outputPath}.`);
