#!/usr/bin/env node
/**
 * Live join probe: connects to a real Pair Notebook session using the exact
 * bootstrap flow of the extension (MeshTransport purpose='bootstrap', host
 * key pinning from the invite, snapshot download) and reports what happened.
 *
 * Usage:
 *   node scripts/join-live.mjs '<pair-notebook://join/...>' [destination]
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rawInvite = process.argv[2];
if (!rawInvite) {
  console.error('Usage: node scripts/join-live.mjs <invite|@file> [destination]');
  process.exit(1);
}
// '@file' form avoids shell-quoting issues with '&' in invites.
const invite = rawInvite.startsWith('@') ? fs.readFileSync(rawInvite.slice(1), 'utf8') : rawInvite;
const destination = process.argv[3] ?? path.join(root, 'live-join-out');

const { parseInvite, newId } = require('../out/src/core/types.js');
const { downloadProjectSnapshot } = require('../out/src/runtime/bootstrap.js');

// werift's internal sockets can raise late unhandled rejections when relays
// are unreachable; report them instead of crashing the probe.
process.on('unhandledRejection', (reason) => {
  console.log(`BACKGROUND-ERROR ${(reason && reason.stack) ?? String(reason)}`);
});

const parsed = parseInvite(invite.trim());
console.log(`Invite OK: session=${parsed.sessionId} project=${parsed.projectName} mode=${parsed.mode} epoch=${parsed.sessionEpoch} host=${parsed.hostDisplayName} (${parsed.hostPeerId})`);
console.log(`Host key pinned: ${parsed.hostIdentityKey.slice(0, 16)}...`);

const localPeer = {
  peerId: newId(),
  displayName: 'OX-Alpha Probe',
  joinOrder: 0,
};
console.log(`Joining as ${localPeer.displayName} (${localPeer.peerId}) into ${destination}`);

const startedAt = Date.now();
let lastLoggedFiles = -1;
try {
  await downloadProjectSnapshot(parsed, localPeer, destination, (progress) => {
    if (progress.completedFiles !== lastLoggedFiles) {
      lastLoggedFiles = progress.completedFiles;
      console.log(`[${Math.round((Date.now() - startedAt) / 100) / 10}s] snapshot ${progress.completedFiles}/${progress.totalFiles} files` +
        (progress.currentFile ? ` (${progress.currentFile})` : ''));
    }
  });
  const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.pair-notebook-transfers') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(destination, full));
    }
  })(destination);
  console.log(`JOIN-OK in ${elapsed}s; received ${files.length} file(s):`);
  for (const file of files.slice(0, 50)) console.log(`  - ${file}`);
  if (files.length > 50) console.log(`  ... and ${files.length - 50} more`);
} catch (error) {
  const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
  console.log(`JOIN-FAILED after ${elapsed}s: ${error.message}`);
  // Lingering werift TURN-probe sockets keep the loop alive long after the
  // answer is known; report deterministically instead of hanging.
  process.exit(2);
}
process.exit(0);
