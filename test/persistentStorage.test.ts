import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { PersistentStorageError, PersistentWorkspace } from '../src/vps/persistentStorage';

const base64 = (value: string): string => Buffer.from(value).toString('base64');
const errorCode = (code: string) => (error: unknown): boolean => error instanceof PersistentStorageError && error.code === code;

describe('persistent workspace storage and server ACLs', function () {
  let directory: string;
  let root: string;
  let workspace: PersistentWorkspace;
  const revision = (): number => workspace.snapshot(true).revision;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-persistent-storage-'));
    root = path.join(directory, 'workspace');
    workspace = new PersistentWorkspace(root);
    await workspace.init();
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('restores binary files, directory metadata, ACLs and revisions without any connected client', async () => {
    const content = Buffer.from([0, 1, 255, 127, 32, 10]).toString('base64');
    await workspace.write('assets/data.bin', content, revision(), true);
    await workspace.mkdir('empty', revision(), true);
    await workspace.setVisibility('assets', 'private', revision());
    const before = workspace.snapshot(true);
    const restored = new PersistentWorkspace(root);
    await restored.init();
    assert.deepEqual(restored.snapshot(true), before);
    assert.deepEqual(restored.snapshot(false).entries.map((entry) => entry.path), ['empty']);
    assert.deepEqual(await restored.read('assets/data.bin', true), { content, revision: before.revision });
    await assert.rejects(restored.read('assets/data.bin', false), errorCode('NOT_FOUND'));
  });

  it('always denies public descendants of private ancestors and removes them from compute snapshots', async () => {
    await workspace.write('shared/public.txt', base64('public'), revision(), false);
    await workspace.write('shared/secret/child/data.txt', base64('private'), revision(), true);
    await workspace.setVisibility('shared/secret', 'private', revision());
    await workspace.setVisibility('shared/secret/child', 'public', revision());
    await workspace.setVisibility('shared/secret/child/data.txt', 'public', revision());
    assert.deepEqual(workspace.snapshot(false).entries.map((entry) => entry.path), ['shared', 'shared/public.txt']);
    assert.deepEqual(await workspace.publicSnapshot(), [{ path: 'shared/public.txt', content: base64('public') }]);
    assert.equal(workspace.snapshot(true).entries.find((entry) => entry.path.endsWith('data.txt'))?.visibility, 'private');
    for (const name of ['shared/secret/child/data.txt', 'shared/secret/missing.txt']) {
      await assert.rejects(workspace.read(name, false), { code: 'NOT_FOUND', message: 'Project path not found.' });
      await assert.rejects(workspace.write(name, base64('probe'), revision(), false), errorCode('NOT_FOUND'));
    }
    await workspace.write('shared/secret/new/child.txt', base64('inherited'), revision(), true);
    assert.ok(!workspace.snapshot(false).entries.some((entry) => entry.path.includes('secret')));
    await assert.rejects(workspace.remove('shared', revision(), false), errorCode('FORBIDDEN'));
    await assert.rejects(workspace.rename('shared', 'moved', revision(), false), errorCode('FORBIDDEN'));
    await assert.rejects(workspace.write('shared', base64('overwrite'), revision(), false), errorCode('INVALID_PATH'));
  });

  it('preserves inherited privacy when an owner moves files out of a private directory', async () => {
    await workspace.write('private/report.txt', base64('secret'), revision(), true);
    await workspace.setVisibility('private', 'private', revision());
    await workspace.rename('private/report.txt', 'report.txt', revision(), true);
    await assert.rejects(workspace.read('report.txt', false), errorCode('NOT_FOUND'));
    assert.deepEqual(await workspace.publicSnapshot(), []);
    await workspace.setVisibility('report.txt', 'public', revision());
    assert.equal((await workspace.read('report.txt', false)).content, base64('secret'));
  });

  it('creates private upload folders atomically and bounds compute serialization before reading contents', async () => {
    await workspace.mkdir('upload', revision(), true, 'private');
    assert.deepEqual(workspace.snapshot(false).entries, []);
    await workspace.write('upload/data.txt', base64('private'), revision(), true);
    await assert.rejects(workspace.mkdir('member-private', revision(), false, 'private'), errorCode('FORBIDDEN'));
    await workspace.write('public.txt', base64('public'), revision(), false);
    assert.deepEqual(await workspace.publicSnapshot(100), [{ path: 'public.txt', content: base64('public') }]);
    const blob = createHash('sha256').update('public').digest('hex');
    await writeFile(path.join(root, 'blobs', blob), 'corrupt');
    // Quota must be rejected using metadata before a content read discovers the corrupt blob.
    await assert.rejects(workspace.publicSnapshot(5), errorCode('QUOTA_EXCEEDED'));
  });

  it('serializes competing CAS edits, reports conflicts and does not lose the successful write', async () => {
    await workspace.write('notebook.ipynb', base64('initial'), revision(), false);
    const expected = revision();
    const results = await Promise.allSettled([
      workspace.write('notebook.ipynb', base64('first'), expected, false),
      workspace.write('notebook.ipynb', base64('second'), expected, false),
    ]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
    if (results[1]?.status === 'rejected') assert.ok(errorCode('CONFLICT')(results[1].reason));
    assert.equal((await workspace.read('notebook.ipynb', false)).content, base64('first'));
    assert.equal(revision(), expected + 1);
    await assert.rejects(workspace.remove('notebook.ipynb', expected, false), errorCode('CONFLICT'));
    await workspace.write('notebook.ipynb', base64('next'), revision(), false);
    assert.equal((await readdir(path.join(root, 'blobs'))).length, 1, 'obsolete blobs must not accumulate indefinitely');
  });

  it('rejects traversal, platform aliases, control characters and duplicate portable names', async () => {
    for (const name of ['../outside', '/absolute', 'x\\y', 'CON.txt', 'a:b', 'name.', 'x//y', 'x/./y', 'x/../y', 'x/\u202ey', 'x/\u0000y']) {
      await assert.rejects(workspace.write(name, base64('unsafe'), revision(), true), errorCode('INVALID_PATH'));
    }
    await workspace.write('Readme.txt', base64('existing'), revision(), true);
    await assert.rejects(workspace.write('README.txt', base64('collision'), revision(), true), errorCode('INVALID_PATH'));
    await workspace.write('caf\u00e9.txt', base64('unicode'), revision(), true);
    await assert.rejects(workspace.write('cafe\u0301.txt', base64('collision'), revision(), true), errorCode('INVALID_PATH'));
    await workspace.write('Stra\u00dfe.txt', base64('unicode'), revision(), true);
    await assert.rejects(workspace.write('STRASSE.txt', base64('collision'), revision(), true), errorCode('INVALID_PATH'));
    await assert.rejects(workspace.write('readme.txt/child', base64('collision'), revision(), true), errorCode('INVALID_PATH'));
    assert.equal(workspace.snapshot(true).entries.length, 3);
  });

  it('validates base64 and enforces file, project and entry quotas before committing', async () => {
    const limited = new PersistentWorkspace(path.join(directory, 'limited'), { maxFileBytes: 6, maxProjectBytes: 8, maxEntries: 4 });
    await limited.init();
    await limited.write('a', base64('1234'), 0, true);
    for (const invalidContent of ['a', 'YWJj\n', 'AB==', '!!!=']) {
      await assert.rejects(limited.write('b', invalidContent, 1, true), errorCode('INVALID_CONTENT'));
    }
    await assert.rejects(limited.write('b', base64('1234567'), 1, true), errorCode('QUOTA_EXCEEDED'));
    await assert.rejects(limited.write('b', base64('123456'), 1, true), errorCode('QUOTA_EXCEEDED'));
    await limited.write('b', base64('1234'), 1, true);
    await limited.mkdir('c', 2, true);
    await limited.mkdir('d', 3, true);
    await assert.rejects(limited.mkdir('e', 4, true), errorCode('QUOTA_EXCEEDED'));
    assert.equal(limited.snapshot(true).revision, 4);
    const restored = new PersistentWorkspace(path.join(directory, 'limited'), { maxFileBytes: 6, maxProjectBytes: 8, maxEntries: 4 });
    await restored.init();
    assert.deepEqual(restored.snapshot(true), limited.snapshot(true));
  });

  it('recovers the committed revision and discards blobs and manifests interrupted before publication', async () => {
    await workspace.write('safe.txt', base64('committed'), revision(), true);
    const before = workspace.snapshot(true);
    const orphan = Buffer.from('uncommitted');
    const hash = createHash('sha256').update(orphan).digest('hex');
    await writeFile(path.join(root, 'blobs', hash), orphan);
    const temporary = `.manifest-${'1'.repeat(32)}.tmp`;
    await writeFile(path.join(root, temporary), '{"format":1,"revision":');
    const restored = new PersistentWorkspace(root);
    await restored.init();
    assert.deepEqual(restored.snapshot(true), before);
    assert.equal((await restored.read('safe.txt', true)).content, base64('committed'));
    assert.ok(!(await readdir(root)).includes(temporary));
    assert.ok(!(await readdir(path.join(root, 'blobs'))).includes(hash));
  });

  it('syncs a reused blob after its first fsync fails, before acknowledging the manifest', async () => {
    const bytes = 'fsync-retry'; const target = path.join(root, 'blobs', createHash('sha256').update(bytes).digest('hex'));
    const original = filesystem.open; let syncs = 0;
    filesystem.open = async (...args) => {
      const handle = await original(...args);
      if (String(args[0]) === target) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { if (++syncs === 1) throw Object.assign(new Error('Blob fsync failed'), { code: 'EIO' }); await sync(); };
      }
      return handle;
    };
    try {
      await assert.rejects(workspace.write('result.txt', base64(bytes), revision(), false), /Blob fsync failed/);
      await workspace.write('result.txt', base64(bytes), revision(), false);
      assert.ok(syncs >= 2, 'The acknowledged blob must have a successful fsync after the failed one');
    } finally { filesystem.open = original; }
    const restored = new PersistentWorkspace(root); await restored.init();
    assert.equal((await restored.read('result.txt', false)).content, base64(bytes));
  });

  it('repairs an unreferenced partial blob on retry without requiring server restart', async () => {
    const bytes = 'complete-blob'; const target = path.join(root, 'blobs', createHash('sha256').update(bytes).digest('hex'));
    const original = filesystem.open; let fail = true;
    filesystem.open = async (...args) => {
      const handle = await original(...args);
      if (String(args[0]) === target && fail) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { fail = false; await write('partial'); throw Object.assign(new Error('Partial blob write'), { code: 'EIO' }); };
      }
      return handle;
    };
    try {
      await assert.rejects(workspace.write('result.txt', base64(bytes), revision(), false), /Partial blob write/);
      await workspace.write('result.txt', base64(bytes), revision(), false);
    } finally { filesystem.open = original; }
    assert.equal((await workspace.read('result.txt', false)).content, base64(bytes));
  });

  it('commits result receipts with their files across a post-publication failure and preserves later rename and deletion', async () => {
    const id = 'execution:write:0';
    const storage = workspace as unknown as { publish: (...args: unknown[]) => Promise<void> };
    const original = storage.publish;
    storage.publish = async function (...args) { await original.apply(this, args); throw new Error('Directory acknowledgement lost'); };
    await assert.rejects(workspace.write('result.txt', base64('once'), revision(), false, id), /acknowledgement lost/);
    storage.publish = original;
    workspace = new PersistentWorkspace(root); await workspace.init();
    assert.equal(workspace.hasPublication(id), true);
    await workspace.rename('result.txt', 'renamed.txt', revision(), false);
    await workspace.write('result.txt', base64('once'), revision(), false, id);
    await assert.rejects(workspace.read('result.txt', false), errorCode('NOT_FOUND'));
    await workspace.remove('renamed.txt', revision(), false);
    workspace = new PersistentWorkspace(root); await workspace.init();
    await workspace.write('result.txt', base64('once'), revision(), false, id);
    assert.deepEqual(workspace.snapshot(false).entries, []);
    await workspace.retainPublications([]);
    assert.equal(workspace.hasPublication(id), false);
  });

  it('does not record a publication whose manifest write fails before commit', async () => {
    const storage = workspace as unknown as { publish: (...args: unknown[]) => Promise<void> };
    const original = storage.publish;
    storage.publish = async () => { throw new Error('Disk full before publication'); };
    await assert.rejects(workspace.write('result.txt', base64('once'), revision(), false, 'execution:write:0'), /Disk full/);
    storage.publish = original;
    workspace = new PersistentWorkspace(root); await workspace.init();
    assert.equal(workspace.hasPublication('execution:write:0'), false);
    await workspace.write('result.txt', base64('once'), revision(), false, 'execution:write:0');
    assert.equal((await workspace.read('result.txt', false)).content, base64('once'));
  });

  it('fails startup on corrupt metadata instead of silently resetting the workspace', async () => {
    await workspace.write('a.txt', base64('data'), revision(), true);
    const filename = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(filename, 'utf8')) as { entries: Record<string, unknown>[] };
    await writeFile(filename, JSON.stringify({ ...manifest, entries: [...manifest.entries, { ...manifest.entries[0], path: 'A.txt' }] }));
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
    await writeFile(filename, '{invalid');
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
    await unlink(filename);
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
  });

  it('does not silently recreate an empty store when its published manifest is missing', async () => {
    await workspace.mkdir('private-empty', revision(), true, 'private');
    await unlink(path.join(root, 'manifest.json'));
    assert.deepEqual(await readdir(path.join(root, 'blobs')), []);
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
  });

  it('detects modified content and rejects symlinked or hardlinked immutable blobs', async () => {
    await workspace.write('file.txt', base64('data'), revision(), true);
    const hash = createHash('sha256').update('data').digest('hex');
    const blob = path.join(root, 'blobs', hash);
    await writeFile(blob, 'evil');
    await assert.rejects(workspace.read('file.txt', true), errorCode('CORRUPT_STORAGE'));
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
    await writeFile(blob, 'data');
    await link(blob, path.join(directory, 'hardlink'));
    await assert.rejects(workspace.read('file.txt', true), errorCode('CORRUPT_STORAGE'));
    await unlink(path.join(directory, 'hardlink'));
    await unlink(blob);
    await writeFile(path.join(directory, 'outside'), 'data');
    await symlink(path.join(directory, 'outside'), blob);
    await assert.rejects(workspace.read('file.txt', true), errorCode('CORRUPT_STORAGE'));
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
  });

  it('rejects symlinked roots and metadata, including replacement after initialization', async () => {
    await symlink(root, path.join(directory, 'alias'), 'dir');
    await assert.rejects(new PersistentWorkspace(path.join(directory, 'alias')).init(), errorCode('CORRUPT_STORAGE'));
    await mkdir(path.join(directory, 'outside-directory'));
    await symlink(path.join(directory, 'outside-directory'), path.join(directory, 'parent-alias'), 'dir');
    await assert.rejects(new PersistentWorkspace(path.join(directory, 'parent-alias', 'nested')).init(), errorCode('CORRUPT_STORAGE'));
    const manifest = path.join(root, 'manifest.json');
    await link(manifest, path.join(directory, 'manifest-link'));
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
    await unlink(path.join(directory, 'manifest-link'));
    await writeFile(path.join(directory, 'outside-manifest'), await readFile(manifest));
    await unlink(manifest);
    await symlink(path.join(directory, 'outside-manifest'), manifest);
    await assert.rejects(workspace.write('file.txt', base64('data'), revision(), true), errorCode('CORRUPT_STORAGE'));
    await assert.rejects(new PersistentWorkspace(root).init(), errorCode('CORRUPT_STORAGE'));
  });
});
