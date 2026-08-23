import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAutosaveManager } from '../src/core/autosave';

describe('host local autosaves', () => {
  it('publishes complete snapshots and retains only the latest three', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-autosave-'));
    let timestamp = Date.UTC(2026, 7, 20, 12, 0, 0, 0);
    let revision = 0;
    const manager = new LocalAutosaveManager({
      root,
      sessionId: 'session-1234567890',
      projectName: 'project-test',
      intervalMs: 60_000,
      retention: 3,
      now: () => timestamp++,
      writeSnapshot: async (targetFolder) => {
        revision += 1;
        await writeFile(path.join(targetFolder, 'state.txt'), `revision-${revision}`, 'utf8');
      },
    });
    try {
      await manager.start();
      for (let index = 0; index < 4; index += 1) await manager.runNow();
      const sessionFolders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      assert.equal(sessionFolders.length, 1);
      const sessionRoot = path.join(root, sessionFolders[0].name);
      const snapshots = (await readdir(sessionRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      assert.equal(snapshots.length, 3);
      const revisions = await Promise.all(snapshots.map((folder) => readFile(path.join(sessionRoot, folder, 'state.txt'), 'utf8')));
      assert.deepEqual(revisions, ['revision-2', 'revision-3', 'revision-4']);
      assert.equal(manager.status().copies, 3);
      assert.equal(manager.status().retention, 3);
      assert.ok(manager.status().nextAt > manager.status().lastAt);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the numerically newest snapshots when timestamps collide', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-autosave-collision-'));
    const manager = new LocalAutosaveManager({
      root,
      sessionId: 'same-time-session',
      projectName: 'same-time-project',
      intervalMs: 60_000,
      retention: 3,
      now: () => Date.UTC(2026, 7, 20, 12, 0, 0, 0),
      writeSnapshot: async (targetFolder) => writeFile(path.join(targetFolder, 'state.txt'), 'state', 'utf8'),
    });
    try {
      await manager.start();
      for (let index = 0; index < 12; index += 1) await manager.runNow();
      const [session] = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      const snapshots = (await readdir(path.join(root, session.name), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      const suffixes = snapshots.map((name) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0)).sort((a, b) => a - b);
      assert.equal(snapshots.length, 3);
      assert.ok(suffixes[0] > 9, `expected latest numeric suffixes, got ${suffixes.join(', ')}`);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes abandoned staging folders and reports an unusable root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-autosave-start-'));
    const sessionRoot = path.join(root, 'project-session');
    await mkdir(path.join(sessionRoot, '.partial-123-456-789'), { recursive: true });
    const manager = new LocalAutosaveManager({
      root, sessionId: 'session', projectName: 'project', intervalMs: 60_000,
      writeSnapshot: async () => undefined,
    });
    try {
      await manager.start();
      assert.equal((await readdir(sessionRoot)).includes('.partial-123-456-789'), false);
      await manager.stop();

      const fileRoot = path.join(root, 'not-a-directory');
      await writeFile(fileRoot, 'file', 'utf8');
      const broken = new LocalAutosaveManager({
        root: fileRoot, sessionId: 'session', projectName: 'project', writeSnapshot: async () => undefined,
      });
      await assert.rejects(broken.start());
      assert.equal(broken.status().enabled, false);
      assert.ok(broken.status().lastError);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked session folder without touching its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-autosave-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-autosave-target-'));
    await writeFile(path.join(outside, 'keep.txt'), 'do not remove', 'utf8');
    await symlink(outside, path.join(root, 'project-session'), process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new LocalAutosaveManager({
      root, sessionId: 'session', projectName: 'project', writeSnapshot: async () => undefined,
    });
    try {
      await assert.rejects(manager.start(), /regular local directory/);
      assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'do not remove');
      assert.equal(manager.status().enabled, false);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
