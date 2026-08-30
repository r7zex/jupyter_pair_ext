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

## Download

- \`${vsixName}\` — the only release asset users need. GitHub displays its SHA-256 digest next to the file.

GitHub also adds automatic **Source code** archives. They are for reading the source and cannot be installed as a VS Code extension.

## Verification

GitHub Actions publishes this release only after a clean dependency install, Python bridge tests, production dependency audit, TypeScript lint/build/tests, and packaged-artifact validation succeed.
`;

fs.writeFileSync(outputPath, notes, 'utf8');
console.log(`Release notes written to ${outputPath}.`);
