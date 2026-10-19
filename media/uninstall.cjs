/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, __dirname, console, process */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { removeGuest } = require('./cleanup-session.cjs');

async function uninstall() {
  let locations;
  try { locations = JSON.parse(await fs.readFile(path.join(__dirname, 'storage-locations.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Array.isArray(locations)) throw new Error('Invalid storage registry');
  for (const candidate of locations) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('Invalid storage path');
    const target = path.resolve(candidate);
    if (path.basename(target).toLowerCase() !== 'pair-notebook.pair-notebook' || path.basename(path.dirname(target)).toLowerCase() !== 'globalstorage') throw new Error('Storage is outside the Pair Notebook directory');
    const info = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Storage must be a real extension directory');
    if (!info) continue;
    const sessions = path.join(target, 'sessions');
    const sessionInfo = await fs.lstat(sessions).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (sessionInfo && (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink())) throw new Error('Session cleanup must stay inside real extension directories');
    for (const session of await fs.readdir(sessions, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!session.isDirectory() || session.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,128}$/.test(session.name)) continue;
      for (const peer of await fs.readdir(path.join(sessions, session.name), { withFileTypes: true })) {
        if (!peer.isDirectory() || peer.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,128}$/.test(peer.name)) continue;
        const root = path.join(sessions, session.name, peer.name);
        let active = false;
        try {
          const lease = JSON.parse(await fs.readFile(path.join(root, '.pair-guest-lease.json'), 'utf8'));
          if (Number.isSafeInteger(lease.pid) && lease.pid > 0) { process.kill(lease.pid, 0); active = true; }
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        await fs.writeFile(path.join(root, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, sessionId: session.name, peerId: peer.name }));
        if (active || !await removeGuest(target, root)) {
          const child = spawn(process.execPath, [path.join(__dirname, 'cleanup-session.cjs'), target, root, ...(active ? ['--watch'] : [])], { cwd: os.tmpdir(), detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
          child.on('error', () => { process.exitCode = 1; }); child.unref();
        }
      }
    }
    // Recovery and pending-work journals survive uninstall. Removing credentials
    // still invalidates saved connections without recursively erasing user state.
    for (const name of ['state.json', 'credential-key']) await fs.unlink(path.join(target, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (require.main === module) uninstall().catch(() => { console.error('Pair Notebook could not remove its local storage.'); process.exitCode = 1; });
module.exports = { uninstall };
