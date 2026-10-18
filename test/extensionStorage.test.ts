import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareExtensionStorage } from '../src/vscode/extensionStorage';

describe('extension storage lifecycle', () => {
  it('keeps upgrades connected, removes history on uninstall and invalidates retained secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-storage-'));
    try {
      const storage = path.join(root, 'globalStorage', 'pair-notebook.pair-notebook');
      const extension = path.join(root, 'extension');
      await mkdir(path.join(extension, 'media'), { recursive: true });
      const connection = { endpoint: 'https://server.example', sessionId: 'project', memberId: 'owner', name: 'Analysis' };
      const membership = 'pairNotebook.persistentMembership.' + createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId])).digest('hex');
      const global = new Map<string, unknown>([['pairNotebook.persistentConnections', [connection]], ['otherExtension.preference', true]]);
      const rawSecrets = new Map<string, string>([[membership, 'old-owner-token']]);
      const context: any = {
        extensionPath: extension, globalStorageUri: { fsPath: storage },
        globalState: { keys: () => [...global.keys()], get: (key: string, fallback: unknown) => global.has(key) ? global.get(key) : fallback, update: async (key: string, value: unknown) => { if (value === undefined) global.delete(key); else global.set(key, value); } },
        secrets: { get: async (key: string) => rawSecrets.get(key), store: async (key: string, value: string) => { rawSecrets.set(key, value); }, delete: async (key: string) => { rawSecrets.delete(key); }, onDidChange: () => ({ dispose: () => undefined }) },
      };
      Object.freeze(context); // VS Code exposes non-configurable context properties.
      const first = await prepareExtensionStorage(context);
      assert.deepEqual(first.globalState.get('pairNotebook.persistentConnections'), [connection]);
      assert.equal(global.has('pairNotebook.persistentConnections'), false, 'host records leave the shared VS Code state database');
      assert.equal(await first.secrets.get(membership), 'old-owner-token');
      assert.ok(rawSecrets.get(membership)?.startsWith('pair-v1:'));
      await first.secrets.store('pairNotebook.sessionPassword.test', 'a-password-to-preserve');
      assert.ok(!rawSecrets.get('pairNotebook.sessionPassword.test')?.includes('a-password-to-preserve'));
      const upgraded = await prepareExtensionStorage(context);
      assert.equal(await upgraded.secrets.get('pairNotebook.sessionPassword.test'), 'a-password-to-preserve');
      const source = path.join(root, 'analysis.py');
      await writeFile(source, 'print(42)');
      await mkdir(path.join(storage, 'sessions', 'old-session', 'old-peer', 'workspace'), { recursive: true });
      await writeFile(path.join(storage, 'sessions', 'old-session', 'old-peer', 'workspace', 'cached.py'), 'print(1)');
      await mkdir(path.join(storage, 'persistent-replicas'), { recursive: true });
      await writeFile(path.join(storage, 'persistent-replicas', 'unsent.json'), 'pending edits');
      await cp(path.resolve('media/uninstall.cjs'), path.join(extension, 'media/uninstall.cjs'));
      await cp(path.resolve('media/cleanup-session.cjs'), path.join(extension, 'media/cleanup-session.cjs'));
      await promisify(execFile)(process.execPath, [path.join(extension, 'media/uninstall.cjs')]);
      await assert.rejects(access(path.join(storage, 'sessions', 'old-session')));
      await assert.rejects(access(path.join(storage, 'state.json')));
      assert.equal(await readFile(path.join(storage, 'persistent-replicas', 'unsent.json'), 'utf8'), 'pending edits');
      assert.ok((await readdir(path.join(storage, 'recovery', 'temporary-sessions'))).some(name => name.startsWith('old-session-old-peer-') && name.endsWith('.jsonl.gz')));
      assert.equal(await readFile(source, 'utf8'), 'print(42)', 'user project files stay untouched');
      const reinstalled = await prepareExtensionStorage(context);
      assert.equal(reinstalled.globalState.get('pairNotebook.persistentConnections'), undefined);
      assert.equal(await reinstalled.secrets.get(membership), undefined);
      assert.equal(await reinstalled.secrets.get('pairNotebook.sessionPassword.test'), undefined);
      assert.equal(rawSecrets.size, 0);
      assert.equal(global.get('otherExtension.preference'), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects uninstall paths outside extension-owned storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-uninstall-'));
    try {
      await cp(path.resolve('media/uninstall.cjs'), path.join(root, 'uninstall.cjs'));
      await cp(path.resolve('media/cleanup-session.cjs'), path.join(root, 'cleanup-session.cjs'));
      await writeFile(path.join(root, 'storage-locations.json'), JSON.stringify([root]));
      await writeFile(path.join(root, 'keep.py'), 'print(42)');
      await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, 'uninstall.cjs')]));
      assert.equal(await readFile(path.join(root, 'keep.py'), 'utf8'), 'print(42)');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
