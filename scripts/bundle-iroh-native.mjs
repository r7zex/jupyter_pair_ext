import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const targets = ['win32-x64-msvc', 'win32-arm64-msvc', 'linux-x64-gnu', 'linux-arm64-gnu',
  'linux-x64-musl', 'linux-arm64-musl', 'darwin-arm64'];
const directory = path.join(root, 'media', 'native');
await fs.mkdir(directory, { recursive: true });
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const manifest = {};

for (const target of targets) {
  const packageName = `@number0/iroh-${target}`;
  const entry = lock.packages[`node_modules/${packageName}`];
  if (!entry?.integrity?.startsWith('sha512-') || !entry.resolved?.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`Missing trusted lockfile integrity for ${packageName}.`);
  }
  const filename = `iroh.${target}.node`;
  const destination = path.join(directory, filename);
  let existing;
  try { existing = await fs.readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (existing && previous[filename]?.integrity === entry.integrity && previous[filename]?.sha256 === hash(existing)) {
    manifest[filename] = previous[filename];
    continue;
  }
  const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Native package download failed: ${packageName} (${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== entry.integrity) throw new Error(`Native package integrity mismatch: ${packageName}.`);
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  let binary;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error(`Invalid native package archive: ${packageName}.`);
    if (name === `package/${filename}` && (header[156] === 0 || header[156] === 48)) {
      binary = tar.subarray(offset + 512, offset + 512 + size);
      break;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary?.length) throw new Error(`Native binary missing from ${packageName}.`);
  await fs.writeFile(destination, binary);
  manifest[filename] = { package: packageName, version: entry.version, integrity, sha256: hash(binary) };
  console.log(`Bundled ${packageName}@${entry.version}`);
}
await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Iroh native assets verified: ${targets.length} platforms.`);
