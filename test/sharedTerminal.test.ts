import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
