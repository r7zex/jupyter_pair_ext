import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'mocha';
import { atomicWriteFile } from '../src/core/atomicFile';

describe('persistent metadata directory durability', () => {
  for (const code of ['EACCES', 'EPERM']) it(`rejects Linux directory fsync ${code} after rename, while retaining the Windows compatibility branch`, async () => {
    const directory = await filesystem.mkdtemp(path.join(os.tmpdir(), 'pair-directory-sync-'));
    const target = path.join(directory, 'session.json');
    const originalOpen = filesystem.open;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    filesystem.open = async (...args) => {
      if (String(args[0]) === directory) throw Object.assign(new Error('Directory sync unavailable'), { code });
      return originalOpen(...args);
    };
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await assert.rejects(atomicWriteFile(target, 'new receipt'), { code });
      assert.equal(await filesystem.readFile(target, 'utf8'), 'new receipt');
      // Simulated platform contract only; this does not verify native Windows.
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await atomicWriteFile(target, 'portable receipt');
      assert.equal(await filesystem.readFile(target, 'utf8'), 'portable receipt');
    } finally {
      filesystem.open = originalOpen;
      Object.defineProperty(process, 'platform', platform);
      await filesystem.rm(directory, { recursive: true, force: true });
    }
  });
});
