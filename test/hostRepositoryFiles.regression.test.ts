import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageAdapter } from '../src/core/persistence';
import { copyProject } from '../src/core/projectFiles';
import {
  DEFAULT_TRANSFER_CHUNK_SIZE,
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_CHUNKS,
  validateIncomingTransfer,
} from '../src/core/transfer';

describe('host repository file safety', () => {
  it('rejects an isolated destination that resolves into the source through a symlink ancestor', async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-copy-alias-'));
    const source = path.join(root, 'repository');
    try {
      await mkdir(source);
      await writeFile(path.join(source, 'train.py'), 'print("source")');
      try {
        await symlink(source, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') { this.skip(); return; }
        throw error;
      }
      await assert.rejects(copyProject(source, path.join(root, 'alias', 'nested', 'working')), /must not overlap/i);
      await assert.rejects(stat(path.join(source, 'nested')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(source, 'train.py'), 'utf8'), 'print("source")');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a populated destination instead of merging stale or unsafe files into a new session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-copy-stale-'));
    const source = path.join(root, 'repository');
    const destination = path.join(root, 'working');
    try {
      await Promise.all([mkdir(source), mkdir(destination)]);
      await writeFile(path.join(source, 'train.py'), 'host data');
      await writeFile(path.join(destination, 'stale.bin'), 'old session data');
      await assert.rejects(copyProject(source, destination), /must be empty/i);
      assert.equal(await readFile(path.join(destination, 'stale.bin'), 'utf8'), 'old session data');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('copies unsaved host editor bytes and new files without saving the host repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-copy-editor-'));
    const source = path.join(root, 'repository');
    const destination = path.join(root, 'working');
    try {
      await mkdir(source);
      await writeFile(path.join(source, 'train.py'), 'old disk revision');
      await writeFile(path.join(source, '.env'), 'TOKEN=host-secret');
      const binary = Buffer.from([0, 255, 17, 128]);
      await writeFile(path.join(source, 'dataset.bin'), binary);
      await copyProject(source, destination, [
        { relativePath: 'train.py', bytes: Buffer.from('unsaved editor revision') },
        { relativePath: 'src/model.py', bytes: Buffer.from('new unsaved model') },
      ]);
      assert.equal(await readFile(path.join(destination, 'train.py'), 'utf8'), 'unsaved editor revision');
      assert.equal(await readFile(path.join(destination, 'src/model.py'), 'utf8'), 'new unsaved model');
      assert.deepEqual(await readFile(path.join(destination, 'dataset.bin')), binary);
      await assert.rejects(readFile(path.join(destination, '.env')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(source, 'train.py'), 'utf8'), 'old disk revision');
      await assert.rejects(stat(path.join(source, 'src')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(source, '.env'), 'utf8'), 'TOKEN=host-secret');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('validates editor paths before copying secrets, traversal or conflicting names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-copy-editor-path-'));
    const source = path.join(root, 'repository');
    try {
      await mkdir(source);
      for (const relativePath of ['.env', '.git/config', '../escaped.py']) {
        const destination = path.join(root, 'working');
        await assert.rejects(copyProject(source, destination, [{ relativePath, bytes: Buffer.from('private') }]),
          /excluded|unsafe/i);
        await assert.rejects(stat(destination), { code: 'ENOENT' });
      }
      await assert.rejects(copyProject(source, path.join(root, 'working'), [
        { relativePath: 'Train.py', bytes: Buffer.from('one') },
        { relativePath: 'train.py', bytes: Buffer.from('two') },
      ]), /case-conflicting/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prunes obsolete shared files while preserving ignored secrets, Git metadata and environments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-materialize-private-'));
    const backing = path.join(root, 'repository');
    const storage = new StorageAdapter({ workingRoot: path.join(root, 'working'), debounceMs: 10,
      serialize: async () => Buffer.from('') });
    try {
      await Promise.all([
        mkdir(path.join(backing, 'obsolete', '.git'), { recursive: true }),
        mkdir(path.join(backing, 'obsolete', '.venv'), { recursive: true }),
        mkdir(path.join(backing, 'empty', 'nested'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(backing, 'obsolete', '.env'), 'SECRET=keep'),
        writeFile(path.join(backing, 'obsolete', '.git', 'config'), 'git config'),
        writeFile(path.join(backing, 'obsolete', '.venv', 'pyvenv.cfg'), 'environment'),
        writeFile(path.join(backing, 'obsolete', 'stale.py'), 'obsolete shared file'),
      ]);
      await storage.materializeFolder(backing, [{ relativePath: 'train.py', bytes: Buffer.from('current model') }], [], []);
      assert.equal(await readFile(path.join(backing, 'train.py'), 'utf8'), 'current model');
      assert.equal(await readFile(path.join(backing, 'obsolete', '.env'), 'utf8'), 'SECRET=keep');
      assert.equal(await readFile(path.join(backing, 'obsolete', '.git', 'config'), 'utf8'), 'git config');
      assert.equal(await readFile(path.join(backing, 'obsolete', '.venv', 'pyvenv.cfg'), 'utf8'), 'environment');
      await assert.rejects(stat(path.join(backing, 'obsolete', 'stale.py')), { code: 'ENOENT' });
      await assert.rejects(stat(path.join(backing, 'empty')), { code: 'ENOENT' });
      const documents = [{ relativePath: 'train.py', bytes: Buffer.from('current model') }];
      assert.equal((await storage.inspectMaterializedFolder(backing, documents, [], [])).matches, true,
        'Preserved host-only directories must allow reattaching an otherwise exact repository.');
      await mkdir(path.join(backing, 'extra-empty'));
      const inspection = await storage.inspectMaterializedFolder(backing, documents, [], []);
      assert.equal(inspection.matches, false);
      assert.deepEqual(inspection.extra, ['extra-empty/'], 'Genuine extra shared directories still require review.');
    } finally { await storage.stop(false); await rm(root, { recursive: true, force: true }); }
  });

  it('bounds chunk bookkeeping and retries while permitting a full-size dataset with normal chunks', () => {
    const hash = 'a'.repeat(64);
    assert.throws(() => validateIncomingTransfer({ size: MAX_TRANSFER_BYTES, chunkSize: 1,
      chunks: MAX_TRANSFER_BYTES, hash }), /chunk limit/i);
    assert.equal(validateIncomingTransfer({ size: MAX_TRANSFER_BYTES,
      chunks: Math.ceil(MAX_TRANSFER_BYTES / DEFAULT_TRANSFER_CHUNK_SIZE), hash }).size, MAX_TRANSFER_BYTES);
    assert.equal(validateIncomingTransfer({ size: MAX_TRANSFER_CHUNKS, chunkSize: 1,
      chunks: MAX_TRANSFER_CHUNKS, hash }).expectedChunks, MAX_TRANSFER_CHUNKS);
  });

  it('preserves host-only descendants when a synchronized folder deletion reaches backing storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-delete-private-'));
    const working = path.join(root, 'working');
    const backing = path.join(root, 'repository');
    const storage = new StorageAdapter({ workingRoot: working, backingRoot: backing, debounceMs: 10,
      serialize: async () => Buffer.from('') });
    try {
      await Promise.all([
        mkdir(path.join(working, 'model', 'nested'), { recursive: true }),
        mkdir(path.join(backing, 'model', 'nested'), { recursive: true }),
        mkdir(path.join(backing, 'model', '.git'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(working, 'model', 'nested', 'train.py'), 'shared model'),
        writeFile(path.join(backing, 'model', 'nested', 'train.py'), 'shared model'),
        writeFile(path.join(backing, 'model', '.git', 'config'), 'private Git metadata'),
        writeFile(path.join(backing, 'model', 'nested', '.env'), 'HOST_SECRET=keep'),
      ]);
      await storage.remove('model');
      await assert.rejects(stat(path.join(working, 'model')), { code: 'ENOENT' });
      await assert.rejects(stat(path.join(backing, 'model', 'nested', 'train.py')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(backing, 'model', '.git', 'config'), 'utf8'), 'private Git metadata');
      assert.equal(await readFile(path.join(backing, 'model', 'nested', '.env'), 'utf8'), 'HOST_SECRET=keep');
    } finally { await storage.stop(false); await rm(root, { recursive: true, force: true }); }
  });
});
