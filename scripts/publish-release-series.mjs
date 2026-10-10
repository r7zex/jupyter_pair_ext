import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const versions = Array.from({ length: 8 }, (_, index) => '0.5.' + (31 + index));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Validate every build before making any tag or Release write.
export function loadVerifiedSeries(directory) {
  return versions.map((version) => {
    const folder = path.join(directory, 'release-series-' + version);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'release-provenance.json'), 'utf8'));
    if (manifest.version !== version || manifest.tag !== 'v' + version
      || !/^[a-f0-9]{40}$/.test(manifest.commit) || manifest.verification?.passed !== true) {
      throw new Error('Invalid verified identity for ' + version);
    }
    if (!Number.isInteger(manifest.productionVulnerabilities) || manifest.productionVulnerabilities < 0
      || (version === '0.5.38' && manifest.productionVulnerabilities !== 0)) {
      throw new Error('Invalid production audit for ' + version);
    }
    const required = ['pair-notebook-' + version + '.vsix', 'pair-notebook-complete-' + version + '.zip',
      'production-audit.json', 'validation-evidence.zip'];
    if (!Array.isArray(manifest.assets) || required.some((name) => !manifest.assets.some((asset) => asset.name === name))
      || new Set(manifest.assets.map((asset) => asset.name)).size !== manifest.assets.length) {
      throw new Error('Missing or duplicate release assets for ' + version);
    }
    for (const asset of manifest.assets) {
      if (path.basename(asset.name) !== asset.name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(asset.name)
        || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Unsafe asset identity for ' + version);
      const file = path.join(folder, asset.name);
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== asset.bytes || digest(file) !== asset.sha256) {
        throw new Error('Artifact integrity mismatch: ' + version + '/' + asset.name);
      }
    }
    const audit = JSON.parse(fs.readFileSync(path.join(folder, 'production-audit.json'), 'utf8'));
    if (audit.metadata?.vulnerabilities?.total !== manifest.productionVulnerabilities) {
      throw new Error('Production audit does not match provenance for ' + version);
    }
    for (const name of ['release-notes.md', 'SHA256SUMS.txt']) {
      if (!fs.statSync(path.join(folder, name)).isFile()) throw new Error('Missing ' + name);
    }
    return { folder, manifest };
  });
}

function ghJson(args, allowMissing = false) {
  try {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    if (allowMissing && /HTTP 404/.test(String(error.stderr))) return undefined;
    throw error;
  }
}

export function verifyTag(repository, tag, expectedCommit, api = ghJson) {
  const ref = api(['api', 'repos/' + repository + '/git/ref/tags/' + tag], true);
  if (!ref) return false;
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
    object = api(['api', 'repos/' + repository + '/git/tags/' + object.sha]).object;
  }
  if (object?.type !== 'commit' || object.sha !== expectedCommit) throw new Error('Refusing to move existing tag ' + tag);
  return true;
}

export function publishSeries(directory, repository) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const series = loadVerifiedSeries(directory);
  for (const { manifest } of series) verifyTag(repository, manifest.tag, manifest.commit);
  // GITHUB_TOKEN-created refs do not recursively trigger the old tag workflows.
  for (const { folder, manifest } of series) {
    const tag = manifest.tag;
    if (!verifyTag(repository, tag, manifest.commit)) {
      const annotated = ghJson(['api', '--method', 'POST', 'repos/' + repository + '/git/tags',
        '-f', 'tag=' + tag, '-f', 'message=Pair Notebook ' + manifest.version,
        '-f', 'object=' + manifest.commit, '-f', 'type=commit']);
      ghJson(['api', '--method', 'POST', 'repos/' + repository + '/git/refs',
        '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + annotated.sha]);
    }
    verifyTag(repository, tag, manifest.commit);
    const existing = ghJson(['api', 'repos/' + repository + '/releases/tags/' + tag], true);
    const files = [...manifest.assets.map((asset) => asset.name), 'release-provenance.json', 'SHA256SUMS.txt'];
    const latest = manifest.version === '0.5.38' ? '--latest=true' : '--latest=false';
    if (existing) {
      if (existing.draft || existing.prerelease) throw new Error('Unexpected existing release state: ' + tag);
      const downloads = fs.mkdtempSync(path.join(folder, '.existing-'));
      try {
        const missing = [];
        for (const name of files) {
          if (!existing.assets.some((asset) => asset.name === name)) { missing.push(path.join(folder, name)); continue; }
          execFileSync('gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', downloads], { stdio: 'inherit' });
          if (digest(path.join(downloads, name)) !== digest(path.join(folder, name))) {
            throw new Error('Refusing to replace published asset ' + tag + '/' + name);
          }
        }
        if (missing.length) execFileSync('gh', ['release', 'upload', tag, '--repo', repository, ...missing], { stdio: 'inherit' });
      } finally { fs.rmSync(downloads, { recursive: true, force: true }); }
      execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--title', 'Pair Notebook ' + manifest.version,
        '--notes-file', path.join(folder, 'release-notes.md'), latest], { stdio: 'inherit' });
    } else {
      execFileSync('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag',
        '--title', 'Pair Notebook ' + manifest.version, '--notes-file', path.join(folder, 'release-notes.md'),
        latest, ...files.map((name) => path.join(folder, name))], { stdio: 'inherit' });
    }
    console.log('Published ' + tag + ' at ' + manifest.commit);
  }
  const latest = ghJson(['api', 'repos/' + repository + '/releases/latest']);
  if (latest.tag_name !== 'v0.5.38') throw new Error('Latest release is not v0.5.38');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: publish-release-series.mjs <artifact-directory> [--validate-only]');
  if (process.argv.includes('--validate-only')) {
    console.log('Verified ' + loadVerifiedSeries(directory).length + ' immutable release builds.');
  } else publishSeries(directory, process.env.GITHUB_REPOSITORY);
}
