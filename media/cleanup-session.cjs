/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, setTimeout */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createGzip } = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

async function realDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Recovery must stay inside real extension directories');
}

async function archiveGuest(base, candidate, parts, preserveAll) {
  let baseline;
  try { baseline = JSON.parse(await fs.readFile(path.join(candidate, '.pair-guest-baseline.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  async function scan(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && entry.name.startsWith('.pair-guest-') || name === 'workspace/.pair-notebook-session.json') continue;
      if (entry.isSymbolicLink()) throw new Error('Cannot retire a working copy containing directory or file links');
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename, name);
      else if (entry.isFile()) {
        const hash = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
        if (!preserveAll && name.startsWith('workspace/') && baseline?.version === 1) {
          if (baseline.files?.[name.slice(10)] === hash) continue;
        }
        files.push({ path: name, filename, hash });
      } else throw new Error('Cannot retire a working copy containing special files');
    }
  }
  await scan(candidate);
  let buffers = [];
  try { buffers = JSON.parse(await fs.readFile(path.join(candidate, '.pair-guest-buffers.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(buffers)) throw new Error('Invalid temporary buffer recovery');
  if (!files.length && !buffers.length) return;
  files.sort((left, right) => left.path.localeCompare(right.path));
  const recovery = path.join(base, 'recovery');
  await realDirectory(recovery);
  const directory = path.join(recovery, 'temporary-sessions');
  await realDirectory(directory);
  const digest = createHash('sha256').update(JSON.stringify([files.map(file => [file.path, file.hash]), buffers])).digest('hex');
  const destination = path.join(directory, `${parts[0]}-${parts[1]}-${digest}.jsonl.gz`);
  try { await fs.access(destination); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function* records() {
    yield JSON.stringify({ format: 'pair-temporary-recovery-v1', sessionId: parts[0], peerId: parts[1] }) + '\n';
    for (const file of files) yield JSON.stringify({ path: file.path, content: (await fs.readFile(file.filename)).toString('base64') }) + '\n';
    for (const buffer of buffers) {
      if (typeof buffer.path !== 'string' || !buffer.path || buffer.path.split(/[\\/]/).some(part => part === '..') || path.isAbsolute(buffer.path) || typeof buffer.content !== 'string') throw new Error('Invalid temporary buffer recovery');
      yield JSON.stringify({ path: `buffers/${buffer.path}`, content: buffer.content }) + '\n';
    }
  }
  const temporary = destination + '.' + randomUUID() + '.tmp';
  await pipeline(Readable.from(records()), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  const handle = await fs.open(temporary, 'r+');
  try {
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, destination);
}

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
  await archiveGuest(base, retired, parts, request.preserveAll === true);
  await fs.rm(retired, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.rmdir(path.dirname(target)).catch(error => { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; });
  return true;
}

async function main(base, target, watch = false) {
  if (watch) for (;;) {
    let lease;
    try { lease = JSON.parse(await fs.readFile(path.join(target, '.pair-guest-lease.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let alive = false;
    if (Number.isSafeInteger(lease.pid) && lease.pid > 0) {
      try { process.kill(lease.pid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') return; }
    }
    if (!alive) {
      await fs.writeFile(path.join(target, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, preserveAll: true, sessionId: path.basename(path.dirname(target)), peerId: path.basename(target) }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await removeGuest(base, target)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
if (require.main === module) main(process.argv[2], process.argv[3], process.argv[4] === '--watch').catch(() => { process.exitCode = 1; });
module.exports = { removeGuest };
