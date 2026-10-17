// Build the matching, dependency-bundled server without installing npm packages on a small VPS.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceProvenance } from './build-provenance.mjs';
import { packageServerSetup } from './package-server-setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-server-package-'));
const server = path.join(staging, 'server');
const artifacts = path.join(root, 'artifacts');
const archive = path.join(artifacts, 'pair-notebook-server-persistent.tar.gz');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  await fs.mkdir(path.join(server, 'out/src/vps'), { recursive: true });
  await build({
    absWorkingDir: root, entryPoints: ['src/vps/cli.ts'], bundle: true,
    platform: 'node', target: 'node20', format: 'cjs',
    outfile: path.join(server, 'out/src/vps/cli.js'),
    define: { 'process.env.WS_NO_BUFFER_UTIL': "'1'", 'process.env.WS_NO_UTF_8_VALIDATE': "'1'" },
  });
  // The detached soak harness uses an actual importable Host module. Bundle it
  // independently so archive validation never resolves checkout node_modules.
  await build({ absWorkingDir: root, entryPoints: ['src/vps/server.ts'], bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', outfile: path.join(server, 'out/src/vps/server.js'),
    define: { 'process.env.WS_NO_BUFFER_UTIL': "'1'", 'process.env.WS_NO_UTF_8_VALIDATE': "'1'" } });
  for (const entry of ['relayCli', 'relayCheck']) await build({ absWorkingDir: root, entryPoints: [`src/vps/${entry}.ts`], bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', outfile: path.join(server, `out/src/vps/${entry}.js`),
    define: { 'process.env.WS_NO_BUFFER_UTIL': "'1'", 'process.env.WS_NO_UTF_8_VALIDATE': "'1'" } });
  const files = [
    'scripts/pair-notebook-server-check.py', 'docs/SERVER_SETUP.md',
    'scripts/pair-notebook-wsl-agent.ps1',
    'scripts/persistent-session-soak.py',
    'scripts/pair-notebook-session-agent.py', 'scripts/pair-notebook-session-admin.py', 'media/jupyter_kernel_bridge.py',
    'docs/PERSISTENT_VPS.md', 'docs/PERSISTENT_VPS_ARCHITECTURE.md',
    'docs/PARTICIPANT_PERMISSIONS_AND_COMMENTS.md',
    'docs/REPAIR_VERIFICATION_2026_10_15.md',
    'docs/PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md',
    'docs/evidence/persistent-0.6.3/target-continuation-2026-10-14.json',
    'LICENSE',
  ];
  for (const relative of files) {
    const destination = path.join(server, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, relative), destination);
  }
  await fs.cp(path.join(root, 'deploy/persistent'), path.join(server, 'deploy/persistent'), { recursive: true });
  const hashes = {};
  async function hashFiles(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked files cannot be included in the server package.');
      if (entry.isDirectory()) await hashFiles(target, relative);
      else if (entry.isFile()) hashes[relative] = sha256(await fs.readFile(target));
      else throw new Error('Nonregular files cannot be included in the server package.');
    }
  }
  await hashFiles(server);
  const source = sourceProvenance(root);
  const manifest = { version: pkg.version, baseCommit: source.commit,
    localChangesIncluded: source.dirty, node: '>=20', files: hashes };
  await fs.writeFile(path.join(server, 'BUILD.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.mkdir(artifacts, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', staging, 'server'], { stdio: 'inherit' });
  await fs.writeFile(`${archive}.sha256`, `${sha256(await fs.readFile(archive))}  ${path.basename(archive)}\n`);
  const installer = path.join(staging, 'installer');
  await fs.cp(path.join(root, 'installer'), installer, { recursive: true, filter: source => !source.split(path.sep).includes('__pycache__') && !source.endsWith('.pyc') });
  await fs.copyFile(path.join(root, 'docs/SERVER_SETUP.md'), path.join(artifacts, 'SERVER_SETUP.md'));
  const relay = path.join(staging, 'relay');
  await fs.mkdir(relay);
  await fs.copyFile(path.join(server, 'out/src/vps/relayCli.js'), path.join(relay, 'relay.js'));
  await fs.copyFile(path.join(server, 'out/src/vps/relayCheck.js'), path.join(relay, 'check.js'));
  await fs.copyFile(path.join(root, 'docs/SERVER_SETUP.md'), path.join(relay, 'README.md'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(relay, 'LICENSE'));
  const relayFiles = {};
  for (const name of await fs.readdir(relay)) relayFiles[name] = sha256(await fs.readFile(path.join(relay, name)));
  await fs.writeFile(path.join(relay, 'BUILD.json'), JSON.stringify({ version: pkg.version, baseCommit: source.commit, files: relayFiles }, null, 2) + '\n');
  const relayArchive = path.join(artifacts, 'pair-notebook-relay.tar.gz');
  execFileSync('tar', ['-czf', relayArchive, '-C', staging, 'relay'], { stdio: 'inherit' });
  await fs.writeFile(`${relayArchive}.sha256`, `${sha256(await fs.readFile(relayArchive))}  ${path.basename(relayArchive)}\n`);
  await packageServerSetup({ root, installer, artifacts, relay, version: pkg.version });
  console.log(`Packaged matching persistent server ${pkg.version}: ${archive}`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
