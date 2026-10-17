import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceProvenance } from './build-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const files = ['out/extension.js', 'media/uninstall.cjs', 'media/cleanup-session.cjs', 'media/jupyter_kernel_bridge.py', 'scripts/pair-notebook-session-agent.py', 'scripts/isolated_packages.py', 'scripts/prepare_compute_runtime.py', 'media/native/manifest.json',
  ...(await fs.readdir(path.join(root, 'media/native'))).filter((name) => name.endsWith('.node')).sort().map((name) => `media/native/${name}`)];
const hashes = {};
for (const name of files) hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
await fs.writeFile(path.join(root, 'PAIR_BUILD.json'), JSON.stringify({ version: pkg.version, ...sourceProvenance(root), files: hashes }, null, 2) + '\n');
