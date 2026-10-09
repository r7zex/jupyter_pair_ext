import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SharedTerminal } from '../src/core/sharedTerminal';
import type { WireFrame } from '../src/core/wire';

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) assert.fail('Host terminal did not produce the expected output'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

describe('shared host command terminal', () => {
  it('keeps the owner repository identity after cd and refreshes it when the shell resets', async function () {
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-shell-owner-'));
    const first = path.join(root, 'first repository'); const second = path.join(root, 'second repository');
    await Promise.all([mkdir(first), mkdir(second)]);
    let directory = first;
    const inherited = process.env.PAIR_NOTEBOOK_WORKSPACE;
    process.env.PAIR_NOTEBOOK_WORKSPACE = '/stale-owner-workspace';
    const host = new SharedTerminal({ isHost: () => true, hostId: () => 'host', available: () => true,
      directory: () => directory, prepare: async () => undefined, send: () => undefined });
    try {
      await host.execute('mkdir nested; cd nested');
      await host.execute('printf "%s" "$PAIR_NOTEBOOK_WORKSPACE" > ../owner.txt; pwd > ../cwd.txt; printf "FIRST_OWNER_READY\\n"');
      await until(() => host.view().text.includes('FIRST_OWNER_READY\n'));
      assert.equal(await readFile(path.join(first, 'owner.txt'), 'utf8'), first);
      assert.equal((await readFile(path.join(first, 'cwd.txt'), 'utf8')).trim(), path.join(first, 'nested'));
      directory = second; host.reset();
      await host.execute('printf "%s" "$PAIR_NOTEBOOK_WORKSPACE" > owner.txt; printf "SECOND_OWNER_READY\\n"');
      await until(() => host.view().text.includes('SECOND_OWNER_READY\n'));
      assert.equal(await readFile(path.join(second, 'owner.txt'), 'utf8'), second);
    } finally {
      if (inherited === undefined) delete process.env.PAIR_NOTEBOOK_WORKSPACE;
      else process.env.PAIR_NOTEBOOK_WORKSPACE = inherited;
      host.dispose(); await rm(root, { recursive: true, force: true });
    }
  });

  it('imports host root and inherited Python modules from a nested command entrypoint', async function () {
    if (process.platform === 'win32' || spawnSync('python3', ['-c', 'pass']).status !== 0) this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-shell-imports-'));
    const repository = path.join(root, 'host'); const inheritedModules = path.join(root, 'python-environment');
    await Promise.all([mkdir(repository), mkdir(inheritedModules)]);
    await mkdir(path.join(repository, 'nested'));
    await writeFile(path.join(repository, 'owner_helper.py'), 'VALUE = 73\n');
    await writeFile(path.join(inheritedModules, 'environment_helper.py'), 'VALUE = 81\n');
    await writeFile(path.join(repository, 'nested', 'inspect_owner.py'),
      'import json\nfrom pathlib import Path\nimport owner_helper, environment_helper\n'
      + 'result = {"owner": owner_helper.VALUE, "environment": environment_helper.VALUE}\n'
      + '(Path(__file__).resolve().parent.parent / "imports.json").write_text(json.dumps(result))\n'
      + 'print("OWNER_IMPORTS_READY", flush=True)\n');
    const inherited = process.env.PYTHONPATH;
    process.env.PYTHONPATH = inheritedModules + (inherited ? path.delimiter + inherited : '');
    const host = new SharedTerminal({ isHost: () => true, hostId: () => 'host', available: () => true,
      directory: () => repository, prepare: async () => undefined, send: () => undefined });
    try {
      await host.execute('cd nested');
      await host.execute('python3 inspect_owner.py');
      await until(() => host.view().text.includes('OWNER_IMPORTS_READY\n') || host.view().text.includes('ModuleNotFoundError'));
      assert.ok(host.view().text.includes('OWNER_IMPORTS_READY\n'), host.view().text);
      assert.deepEqual(JSON.parse(await readFile(path.join(repository, 'imports.json'), 'utf8')), { owner: 73, environment: 81 });
    } finally {
      if (inherited === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = inherited;
      host.dispose(); await rm(root, { recursive: true, force: true });
    }
  });

  it('executes in the host repository, preserves shell state and replays output to guests', async function () {
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-shell-'));
    let online = true;
    const send = (source: string) => (_peer: string | undefined, type: string, meta: Record<string, unknown>, payload = new Uint8Array()): void => {
      if (online) (source === 'host' ? guest : host).handle({ type, meta, payload }, source);
    };
    const common = { hostId: () => 'host', available: () => true, directory: () => root, prepare: async () => undefined };
    const host = new SharedTerminal({ ...common, isHost: () => true, send: send('host') });
    const guest = new SharedTerminal({ ...common, isHost: () => false, send: send('guest') });
    try {
      guest.requestSnapshot();
      await host.execute('VALUE=host-only');
      await host.execute('printf "%s" "$VALUE" > host-result.txt; printf "обучение 🧠\\n"');
      await until(() => guest.view().text.includes('обучение 🧠\n'));
      assert.equal(await readFile(path.join(root, 'host-result.txt'), 'utf8'), 'host-only');
      assert.equal(host.view().text, guest.view().text);
      await assert.rejects(guest.execute('touch forbidden'), /Only the active session host/);
      host.handle({ type: 'shellInput', meta: {}, payload: Buffer.from('touch forbidden') }, 'guest');
      await assert.rejects(readFile(path.join(root, 'forbidden')), { code: 'ENOENT' });
      online = false;
      await host.execute('printf "offline-result\\n"');
      await until(() => host.view().text.includes('offline-result\n'));
      online = true;
      host.peerConnected('guest');
      assert.equal(guest.view().text, host.view().text);
    } finally { host.dispose(); guest.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects forged output, repairs sequence gaps and ignores stale/duplicate snapshots', () => {
    const sent: string[] = [];
    const guest = new SharedTerminal({ isHost: () => false, hostId: () => 'host', available: () => true,
      directory: () => '', prepare: async () => undefined, send: (_peer, type) => { sent.push(type); } });
    const generation = randomUUID();
    const frame = (type: string, sequence: number, text: string): WireFrame => ({ type, meta: { generation, sequence }, payload: Buffer.from(text) });
    try {
      guest.handle(frame('shellSnapshot', 1, 'forged'), 'guest');
      assert.equal(guest.view().text, '');
      guest.handle(frame('shellSnapshot', 1, 'one'), 'host');
      guest.handle(frame('shellOutput', 3, 'gap'), 'host');
      assert.deepEqual(sent, ['shellSnapshotRequest']);
      guest.handle(frame('shellSnapshot', 3, 'one-two-three'), 'host');
      guest.handle(frame('shellSnapshot', 2, 'stale'), 'host');
      guest.handle(frame('shellOutput', 3, 'duplicate'), 'host');
      assert.equal(guest.view().text, 'one-two-three');
    } finally { guest.dispose(); }
  });

  it('never restores an older shell generation after a repository reset, even when output arrives before its snapshot', () => {
    const requests: string[] = [];
    let requestId: unknown;
    const guest = new SharedTerminal({ isHost: () => false, hostId: () => 'host', available: () => true,
      directory: () => '', prepare: async () => undefined, send: (_peer, type, meta) => { requests.push(type); requestId = meta.requestId; } });
    const streamId = randomUUID();
    const old = randomUUID(); const current = randomUUID(); const next = randomUUID();
    const frame = (type: string, generation: string, generationIndex: number, sequence: number, text: string, reply?: unknown): WireFrame =>
      ({ type, meta: { streamId, generation, generationIndex, sequence, requestId: reply }, payload: Buffer.from(text) });
    try {
      guest.requestSnapshot();
      guest.handle(frame('shellSnapshot', current, 1, 1, 'new repository', requestId), 'host');
      requests.length = 0;
      // The old generation need not have been seen by this newly joined guest.
      guest.handle(frame('shellSnapshot', old, 0, 20, 'old repository'), 'host');
      guest.handle(frame('shellOutput', old, 0, 21, 'old output'), 'host');
      assert.equal(guest.view().text, 'new repository');
      guest.handle(frame('shellOutput', next, 2, 3, 'output before snapshot'), 'host');
      guest.handle(frame('shellSnapshot', current, 1, 30, 'late old snapshot'), 'host');
      assert.notEqual(guest.view().text, 'late old snapshot');
      guest.handle(frame('shellSnapshot', next, 2, 3, 'latest repository', requestId), 'host');
      assert.equal(guest.view().text, 'latest repository');
      assert.deepEqual(requests, ['shellSnapshotRequest']);
    } finally { guest.dispose(); }
  });

  it('validates ordered metadata, rejects legacy rollback and accepts a new host with a fresh counter', () => {
    let host = 'host';
    let requestId: unknown; let streamId = randomUUID();
    const guest = new SharedTerminal({ isHost: () => false, hostId: () => host, available: () => true,
      directory: () => '', prepare: async () => undefined, send: (_peer, _type, meta) => { requestId = meta.requestId; } });
    const generation = randomUUID();
    const snapshot = (generationIndex: unknown, text: string, reply?: unknown): WireFrame => ({ type: 'shellSnapshot',
      meta: { streamId, generation, generationIndex, sequence: 0, requestId: reply }, payload: Buffer.from(text) });
    try {
      guest.handle(snapshot(undefined, 'legacy'), host);
      for (const invalid of [-1, 0.5, '0', NaN, Number.MAX_SAFE_INTEGER + 1]) guest.handle(snapshot(invalid, 'invalid'), host);
      assert.equal(guest.view().text, 'legacy');
      guest.requestSnapshot(); guest.handle(snapshot(5, 'ordered', requestId), host);
      guest.handle(snapshot(undefined, 'legacy rollback'), host);
      guest.handle({ ...snapshot(5, 'counter collision'), meta: { streamId, generation: randomUUID(), generationIndex: 5, sequence: 0 } }, host);
      assert.equal(guest.view().text, 'ordered');
      guest.reset(); host = 'new-host'; streamId = randomUUID();
      guest.requestSnapshot(); guest.handle(snapshot(0, 'new host', requestId), host);
      assert.equal(guest.view().text, 'new host');
    } finally { guest.dispose(); }
  });

  it('accepts a restarted host with the same host clock only through a fresh snapshot response', () => {
    let requestId: unknown;
    const guest = new SharedTerminal({ isHost: () => false, hostId: () => 'host', available: () => true,
      directory: () => '', prepare: async () => undefined, send: (_peer, _type, meta) => { requestId = meta.requestId; } });
    const oldStream = randomUUID(); const newStream = randomUUID();
    const oldGeneration = randomUUID(); const newGeneration = randomUUID();
    const snapshot = (streamId: string, generation: string, generationIndex: number, text: string, reply?: unknown): WireFrame =>
      ({ type: 'shellSnapshot', meta: { streamId, generation, generationIndex, sequence: 0, requestId: reply }, payload: Buffer.from(text) });
    try {
      guest.requestSnapshot();
      guest.handle(snapshot(oldStream, oldGeneration, 5, 'before restart', requestId), 'host');
      const oldRequest = requestId;
      guest.peerConnected('host');
      guest.handle(snapshot(newStream, newGeneration, 0, 'restarted host', requestId), 'host');
      assert.equal(guest.view().text, 'restarted host');
      guest.handle(snapshot(oldStream, randomUUID(), 20, 'late old stream'), 'host');
      guest.handle(snapshot(oldStream, oldGeneration, 5, 'old reply', oldRequest), 'host');
      assert.equal(guest.view().text, 'restarted host');
    } finally { guest.dispose(); }
  });

  it('recovers real shell output from a replacement host process without replaying the previous stream', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-shell-restart-'));
    const common = { hostId: () => 'host', available: () => true, directory: () => root, prepare: async () => undefined };
    let host: SharedTerminal;
    const stale: WireFrame[] = [];
    const guest = new SharedTerminal({ ...common, isHost: () => false,
      send: (_peer, type, meta, payload = new Uint8Array()) => { host.handle({ type, meta, payload }, 'guest'); } });
    const makeHost = () => new SharedTerminal({ ...common, isHost: () => true,
      send: (_peer, type, meta, payload = new Uint8Array()) => { const frame = { type, meta, payload }; stale.push(frame); guest.handle(frame, 'host'); } });
    const first = host = makeHost();
    try {
      first.reset(); first.reset();
      await first.execute('echo before-restart');
      await until(() => /(^|\r?\n)before-restart\r?\n/.test(guest.view().text));
      const oldFrames = [...stale];
      first.dispose(); host = makeHost(); guest.peerConnected('host');
      await host.execute('echo after-restart');
      await until(() => /(^|\r?\n)after-restart\r?\n/.test(guest.view().text));
      const current = guest.view().text;
      oldFrames.forEach((frame) => guest.handle(frame, 'host'));
      assert.equal(guest.view().text, current);
      assert.ok(!current.includes('before-restart'));
    } finally { first.dispose(); host!.dispose(); guest.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('cancels a prepared command when host authority changes and contains delivery failures', async () => {
    let finish!: () => void;
    let localHost = true;
    const terminal = new SharedTerminal({ isHost: () => localHost, hostId: () => localHost ? 'local' : 'new-host',
      available: () => true, directory: () => os.tmpdir(), prepare: () => new Promise<void>((resolve) => { finish = resolve; }),
      send: () => { throw new Error('route lost'); } });
    try {
      const pending = terminal.execute('echo never');
      await Promise.resolve();
      terminal.reset(); localHost = false; finish();
      await assert.rejects(pending, /host changed/);
      assert.doesNotThrow(() => terminal.requestSnapshot());
      await assert.rejects(terminal.execute('echo guest'), /Only the active session host/);
    } finally { terminal.dispose(); }
  });

  it('bounds retained output and keeps final UTF-8 output intact', async function () {
    if (process.platform === 'win32') this.skip();
    const terminal = new SharedTerminal({ isHost: () => true, hostId: () => 'host', available: () => true,
      directory: () => os.tmpdir(), prepare: async () => undefined, send: () => { throw new Error('offline'); } });
    try {
      await terminal.execute(`"${process.execPath}" -e 'process.stdout.write("🧠".repeat(150000)+"END\\n")'`);
      await until(() => terminal.view().text.endsWith('END\n'));
      assert.ok(terminal.view().text.length <= 128 * 1024);
      assert.ok(!terminal.view().text.includes('\uFFFD'));
      await assert.rejects(terminal.execute('bad\ud800'), /8192/);
    } finally { terminal.dispose(); }
  });
});
