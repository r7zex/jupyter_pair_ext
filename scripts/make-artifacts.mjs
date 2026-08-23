// Build helper: verifies the packaged VSIX and produces the final distribution
// ZIP.  Kept as a script (not a test) because it only runs during packaging.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import yazl from 'yazl';
import yauzl from 'yauzl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixName = `pair-notebook-${packageJson.version}.vsix`;
const zipName = `pair-notebook-complete-${packageJson.version}.zip`;

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.git', '.pytest_cache',
  '.mypy_cache', '.pair-notebook-transfers', '.ruff_cache', '.tox', '.nox',
]);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg']);
const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
  'credentials.json', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.p12', '.pfx', '.key', '.keystore', '.jks']);
const SAFE_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

function listEntries(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('entry', (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function collectFiles(directory, relative = '') {
  const files = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) {
      throw new Error(`Refusing to package symbolic link: ${relativePath}`);
    }
    if (item.isDirectory()) {
      if (SENSITIVE_DIRECTORIES.has(item.name.toLowerCase())) {
        throw new Error(`Refusing to package sensitive directory: ${relativePath}`);
      }
      if (EXCLUDED_DIRECTORIES.has(item.name.toLowerCase())) continue;
      if (relativePath === 'out/src' || relativePath === 'out/test') continue;
      files.push(...collectFiles(path.join(directory, item.name), relativePath));
      continue;
    }
    const lowerName = item.name.toLowerCase();
    if (isSensitiveFileName(lowerName)) {
      throw new Error(`Refusing to package sensitive file: ${relativePath}`);
    }
    if (/\.(?:zip|tgz|tar|gz)$/i.test(item.name)) continue;
    if (/\.vsix$/i.test(item.name) && item.name !== vsixName) continue;
    if (/\.tsbuildinfo$/i.test(item.name)) continue;
    if (/\.map$/i.test(item.name)) continue;
    if (lowerName === '.ds_store' || lowerName === 'thumbs.db') continue;
    files.push(relativePath);
  }
  return files;
}

function isSensitiveFileName(lowerName) {
  return (lowerName === '.env' || (lowerName.startsWith('.env.') && !SAFE_ENV_FILES.has(lowerName)))
    || SENSITIVE_FILE_NAMES.has(lowerName)
    || SENSITIVE_EXTENSIONS.has(path.extname(lowerName));
}

function sensitiveArchiveEntries(entries) {
  return entries.filter((entry) => {
    const name = path.posix.basename(entry).toLowerCase();
    return isSensitiveFileName(name);
  });
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');

}

function externalRequires(bundle) {
  const allowed = new Set(['vscode']);
  for (const moduleName of builtinModules) {
    allowed.add(moduleName);
    allowed.add(`node:${moduleName}`);
  }
  const imports = [...bundle.matchAll(/\brequire\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  return [...new Set(imports.filter((moduleName) => !allowed.has(moduleName)))].sort();
}

async function main() {
  const vsixPath = path.join(root, vsixName);
  const vsixEntries = await listEntries(vsixPath);
  const required = [
    'extension/package.json',
    'extension/out/extension.js',
    'extension/media/jupyter_kernel_bridge.py',
    'extension/media/pair-notebook.svg',
    'extension.vsixmanifest',
  ];
  const missing = required.filter((entry) => !vsixEntries.includes(entry));
  if (missing.length) throw new Error(`VSIX is missing required entries: ${missing.join(', ')}`);
  const unsafePaths = vsixEntries.filter((entry) => entry.startsWith('/') || entry.includes('\\')
    || entry.split('/').includes('..'));
  if (unsafePaths.length) throw new Error(`VSIX contains an unsafe archive path: ${unsafePaths.join(', ')}`);
  const sensitiveVsixEntries = sensitiveArchiveEntries(vsixEntries);
  if (sensitiveVsixEntries.length) throw new Error(`VSIX contains sensitive files: ${sensitiveVsixEntries.join(', ')}`);
  const bundled = vsixEntries.filter((entry) => entry.toLowerCase().includes('node_modules/'));
  if (bundled.length) throw new Error(`VSIX unexpectedly bundles node_modules (${bundled.length} entries).`);
  const nestedArchives = vsixEntries.filter((entry) => /\.(?:vsix|zip)$/i.test(entry));
  if (nestedArchives.length) throw new Error(`VSIX contains a nested archive: ${nestedArchives.join(', ')}`);
  const generatedCaches = vsixEntries.filter((entry) => /(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)\//i.test(entry));
  if (generatedCaches.length) throw new Error(`VSIX contains generated cache files: ${generatedCaches.join(', ')}`);
  const staleBuildFiles = vsixEntries.filter((entry) => entry.startsWith('extension/out/') && entry !== 'extension/out/extension.js');
  if (staleBuildFiles.length) throw new Error(`VSIX contains stale build output: ${staleBuildFiles.join(', ')}`);
  const extensionBundle = fs.readFileSync(path.join(root, 'out', 'extension.js'), 'utf8');
  if (!extensionBundle.includes('dev.pair-notebook.vscode.v2') || !extensionBundle.includes('relayConfig')) {
    throw new Error('The extension bundle does not contain the Trystero/Nostr runtime.');
  }
  if (/tail(?:scale)/i.test(extensionBundle)) throw new Error('The extension bundle still contains the retired Tailscale integration.');
  if (/[A-Z]:\\Users\\[^\\]+|\/home\/[^/]+\//.test(extensionBundle)) {
    throw new Error('The extension bundle contains a hard-coded local user path.');
  }
  const unbundledImports = externalRequires(extensionBundle);
  if (unbundledImports.length) {
    throw new Error(`The extension bundle has unpackaged runtime imports: ${unbundledImports.join(', ')}`);
  }
  console.log(`VSIX OK: ${vsixEntries.length} entries, all required runtime assets present.`);

  const zipPath = path.join(root, zipName);
  fs.rmSync(zipPath, { force: true });
  const files = collectFiles(root);
  const archive = new yazl.ZipFile();
  for (const relativePath of files) {
    archive.addFile(path.join(root, relativePath), `pair-notebook/${relativePath}`);
  }
  archive.end();
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(zipPath);
    archive.outputStream.pipe(stream).on('close', resolve).on('error', reject);
  });

  const zipEntries = await listEntries(zipPath);
  const bad = zipEntries.filter((entry) => !entry.startsWith('pair-notebook/'));
  if (bad.length) throw new Error(`ZIP has entries outside the top-level directory: ${bad.slice(0, 5).join(', ')}`);
  const forbidden = zipEntries.filter((entry) => /node_modules\/|__pycache__\/|\.venv\/|\/venv\/|\.pytest_cache\/|\.mypy_cache\/|\.ruff_cache\//i.test(entry));
  if (forbidden.length) throw new Error(`ZIP contains excluded content: ${forbidden.slice(0, 5).join(', ')}`);
  const sensitiveZipEntries = sensitiveArchiveEntries(zipEntries);
  if (sensitiveZipEntries.length) throw new Error(`ZIP contains sensitive files: ${sensitiveZipEntries.join(', ')}`);
  const unexpectedNestedArchives = zipEntries.filter((entry) => /\.(?:zip|tgz|tar|gz|vsix)$/i.test(entry)
    && entry !== `pair-notebook/${vsixName}`);
  if (unexpectedNestedArchives.length) {
    throw new Error(`ZIP contains an unexpected nested archive: ${unexpectedNestedArchives.join(', ')}`);
  }
  for (const needed of [
    `pair-notebook/${vsixName}`,
    'pair-notebook/package.json',
    'pair-notebook/out/extension.js',
    'pair-notebook/media/jupyter_kernel_bridge.py',
    'pair-notebook/docs/acceptance-report.md',
    'pair-notebook/src/extension.ts',
    'pair-notebook/test/audit.regression.test.ts',
  ]) {
    if (!zipEntries.includes(needed)) throw new Error(`ZIP is missing ${needed}`);
  }
  console.log(`ZIP OK: ${zipEntries.length} entries, single top-level directory 'pair-notebook/'.`);
  console.log(`SHA256 ${vsixName} = ${sha256(vsixPath)}`);
  console.log(`SHA256 ${zipName}  = ${sha256(zipPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
