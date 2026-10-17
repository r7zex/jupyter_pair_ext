/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, __dirname, console, process */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

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
    await fs.rm(target, { recursive: true, force: true });
  }
}

if (require.main === module) uninstall().catch(() => { console.error('Pair Notebook could not remove its local storage.'); process.exitCode = 1; });
module.exports = { uninstall };
