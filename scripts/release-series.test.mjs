import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadVerifiedSeries, verifyTag, versions } from './publish-release-series.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-release-series-'));
  for (const version of versions) {
    const folder = path.join(directory, 'release-series-' + version); fs.mkdirSync(folder);
    const assets = ['pair-notebook-' + version + '.vsix', 'pair-notebook-complete-' + version + '.zip',
      'production-audit.json', 'validation-evidence.zip'].map((name) => {
      const bytes = Buffer.from(name === 'production-audit.json'
        ? JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) : name);
      fs.writeFileSync(path.join(folder, name), bytes);
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    fs.writeFileSync(path.join(folder, 'release-provenance.json'), JSON.stringify({
      version, tag: 'v' + version, commit: 'a'.repeat(40), productionVulnerabilities: 0,
      verification: { passed: true }, assets,
    }));
    fs.writeFileSync(path.join(folder, 'release-notes.md'), 'notes');
    fs.writeFileSync(path.join(folder, 'SHA256SUMS.txt'), 'sums');
  }
  return directory;
}

test('rejects a damaged last build before the series can be published', () => {
  const directory = fixture();
  try {
    assert.equal(loadVerifiedSeries(directory).length, 8);
    fs.appendFileSync(path.join(directory, 'release-series-0.5.38/pair-notebook-0.5.38.vsix'), 'tampered');
    assert.throws(() => loadVerifiedSeries(directory), /integrity mismatch/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('keeps historical audit findings but refuses a vulnerable latest release', () => {
  const directory = fixture();
  try {
    const edit = (version) => {
      const file = path.join(directory, 'release-series-' + version, 'release-provenance.json');
      const manifest = JSON.parse(fs.readFileSync(file)); manifest.productionVulnerabilities = 1;
      const audit = Buffer.from(JSON.stringify({ metadata: { vulnerabilities: { total: 1 } } }));
      fs.writeFileSync(path.join(path.dirname(file), 'production-audit.json'), audit);
      const asset = manifest.assets.find((item) => item.name === 'production-audit.json');
      asset.bytes = audit.length; asset.sha256 = createHash('sha256').update(audit).digest('hex');
      fs.writeFileSync(file, JSON.stringify(manifest));
    };
    edit('0.5.31'); assert.equal(loadVerifiedSeries(directory).length, 8);
    edit('0.5.38'); assert.throws(() => loadVerifiedSeries(directory), /production audit/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('checks annotated tags and never replaces a different commit', () => {
  const calls = [];
  const api = (args) => {
    calls.push(args);
    return args.at(-1).includes('/git/ref/')
      ? { object: { type: 'tag', sha: 'b'.repeat(40) } }
      : { object: { type: 'commit', sha: 'a'.repeat(40) } };
  };
  assert.equal(verifyTag('owner/repo', 'v0.5.38', 'a'.repeat(40), api), true);
  assert.throws(() => verifyTag('owner/repo', 'v0.5.38', 'c'.repeat(40), api), /Refusing to move/);
  assert.ok(calls.every((args) => args[0] === 'api' && !args.includes('POST')));
});
