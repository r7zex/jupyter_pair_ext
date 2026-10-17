/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, setTimeout */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

async function removeGuest(base, target) {
  base = path.resolve(base); target = path.resolve(target);
  const parts = path.relative(path.join(base, 'sessions'), target).split(path.sep);
  if (path.basename(base).toLowerCase() !== 'pair-notebook.pair-notebook' || parts.length !== 2 || parts.some(part => !identifier.test(part))) throw new Error('Invalid guest cleanup path');
  for (const directory of [base, path.join(base, 'sessions'), path.dirname(target)]) {
    const info = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return true;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Guest cleanup must stay inside real extension directories');
  }
  const retired = target + '.deleting';
  let candidate = target;
  let info = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) {
    candidate = retired;
    info = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  }
  if (!info) return true;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid guest directory');
  const request = JSON.parse(await fs.readFile(path.join(candidate, '.pair-guest-cleanup.json'), 'utf8'));
  if (request.version !== 1 || request.sessionId !== parts[0] || request.peerId !== parts[1]) throw new Error('Invalid guest cleanup request');
  // Rename first: on Windows an open workspace can reject this without
  // partially deleting its files. Retry after VS Code releases the folder.
  if (candidate === target) {
    try { await fs.rename(target, retired); }
    catch (error) { if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; if (error.code === 'ENOENT') return true; throw error; }
  }
  await fs.rm(retired, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.rmdir(path.dirname(target)).catch(error => { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; });
  return true;
}

async function main(base, target) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await removeGuest(base, target)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
module.exports = { removeGuest };
