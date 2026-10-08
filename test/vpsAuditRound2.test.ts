import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'mocha';
import { type JobSubmission, submissionDigest, validateSubmission } from '../src/vps/protocol';
import { VpsServer } from '../src/vps/server';
import { VpsClient } from '../src/vps/client';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { MAX_WIRE_FRAME_BYTES, encodeFrame } from '../src/core/wire';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { deriveRelayFrameKey, encryptRelayPacket } from '../src/runtime/relayCrypto';
import fsPromises from 'node:fs/promises';
import { PendingSubmissionStore } from '../src/vps/pendingSubmission';
import { spawn, type ChildProcess } from 'node:child_process';
import * as Y from 'yjs';

const firstUuid = 'GPU-01234567-89ab-cdef-0123-456789abcdef';
const secondUuid = 'GPU-01234567-89ab-cdef-0123-456789abcdee';
function input(index: number): JobSubmission {
  return { id: `round2-${index}`, agentId: 'pc', title: 'Training', device: 'cpu', entrypoint: 'train.py',
    files: { 'train.py': 'print("training")', 'helper.py': 'VALUE=1' }, args: [] };
}
async function post(port: number, token: string, route: string, body: unknown): Promise<{ status: number; data: any }> {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': bytes.length, 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject); request.end(bytes);
  });
}

describe('Round 2 Stage 1024 — valid source preservation with Unicode and canonical-target faults', () => {
  for (let mask = 0; mask < 1024; mask++) {
    it(`case ${mask}: rejects unrepresentable input and preserves valid variations`, () => {
      const job = input(mask);
      if (mask & 1) { job.id = 'constructor'; job.agentId = 'toString'; }
      if (mask & 2) { job.entrypoint = 'pkg/😀_train.py'; job.files[job.entrypoint] = job.files['train.py']!; delete job.files['train.py']; }
      if (mask & 4) job.args = ['обучение 🧠', 'literal; echo no-shell', 'a b'];
      if (mask & 8) { job.device = 'gpu:0'; job.gpuUuid = firstUuid; }
      if (mask & 16) job.title = 'Training\u0085model';
      if (mask & 32) job.files = Object.fromEntries(Object.entries(job.files).reverse());
      if (mask & 64) job.title = `  ${job.title}  `;
      if (mask & 128) job.device = 'gpu:00';
      if (mask & 256) job.files[job.entrypoint] = '# unpaired Unicode \uD800';
      if (mask & 512) job.args.push('\uDFFF');
      if (mask & (16 | 128 | 256 | 512)) { assert.throws(() => validateSubmission(job)); return; }
      const normalized = validateSubmission(job);
      assert.equal(normalized.title, 'Training');
      assert.deepEqual(normalized.files, job.files); assert.deepEqual(normalized.args, job.args);
      assert.equal(submissionDigest(job), submissionDigest({ ...job, files: Object.fromEntries(Object.entries(job.files).reverse()) }));
    });
  }
});

describe('Round 2 Stage 256 — log replay, immutable completion and byte offsets', () => {
  let server: VpsServer; let root: string; let port: number; let client: VpsClient;
  const team = randomBytes(32).toString('hex'); const owner = randomBytes(32).toString('hex');
  before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'pair-round2-logs-'));
    server = new VpsServer({ dataDirectory: root, clientToken: team, agentTokens: { pc: owner } }); port = await server.start();
    client = new VpsClient(`http://127.0.0.1:${port}`, team); });
  after(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  for (let mask = 0; mask < 256; mask++) {
    it(`case ${mask}: retry preserves exact bytes and invalid completion cannot change a job`, async () => {
      const job = input(mask); await client.submit(job);
      const claimed = await post(port, owner, '/v1/agents/pc/poll', { instanceId: 'installation', name: 'PC', resources: { cpuCount: 4, python: 'python3', gpus: [] } });
      assert.equal(claimed.data.job.id, job.id);
      const bytes = Buffer.from(mask & 1 ? 'обучение 🧠\n' : 'training\n');
      const split = mask & 2 ? 1 : bytes.length; // deliberately split inside UTF-8
      const report = (offset: number, log: Buffer, result?: unknown) => post(port, owner, '/v1/agents/pc/report',
        { instanceId: 'installation', jobId: job.id, offset, log: log.toString('base64'), ...(result ? { result } : {}) });
      assert.equal((await report(0, bytes.subarray(0, split))).status, 200);
      if (mask & 4) assert.equal((await report(0, bytes.subarray(0, split))).status, 200);
      assert.equal((await report(mask & 8 ? 0 : split, mask & 8 ? bytes : bytes.subarray(split))).status, 200);
      const invalid = mask & 16 ? { status: 'failed', exitCode: Number.MAX_SAFE_INTEGER + 1 }
        : mask & 32 ? { status: 'succeeded', exitCode: 1 }
        : mask & 64 ? { status: 'cancelled', exitCode: -1 }
        : mask & 128 ? { status: 'failed', exitCode: 0 } : undefined;
      if (invalid) assert.equal((await report(bytes.length, Buffer.alloc(0), invalid)).status, 400);
      const before = await client.job(job.id); assert.equal(before.status, 'running'); assert.equal(before.logEnd, bytes.length);
      assert.deepEqual(Buffer.from(before.log, 'base64'), bytes);
      assert.equal((await report(bytes.length, Buffer.alloc(0), { status: 'succeeded', exitCode: 0 })).status, 200);
      assert.equal((await report(0, bytes, { status: 'succeeded', exitCode: 0 })).status, 200);
      assert.equal((await report(bytes.length, Buffer.from('late'))).status, 409);
      assert.equal((await client.job(job.id)).status, 'succeeded');
    });
  }
});

class Round2Socket extends EventEmitter {
  public readyState = WebSocket.OPEN; public bufferedAmount = 0; public sent: string[] = [];
  public send(bytes: string): void { this.sent.push(bytes); }
  public terminate(): void { this.emit('close'); }
}
describe('Round 2 Stage 128 — readiness, recipient binding and binary payload preservation', () => {
  for (let mask = 0; mask < 128; mask++) {
    it(`case ${mask}: authenticated routing preserves binary frames`, () => {
      const socket = new Round2Socket();
      const options = { sessionId: 'round2', token: 'invite', localPeerId: 'local', vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) },
        socketFactory: () => socket as unknown as WebSocket };
      const relay = new VpsFrameRelay(options); const bytes = mask & 1 ? Buffer.from([0, 255, 128, 10]) : Buffer.from('training'); let count = 0;
      relay.onFrame = (peer, payload) => { assert.equal(peer, 'remote'); assert.deepEqual(payload, bytes); count++; };
      try {
        relay.start(); socket.emit('open'); if (!(mask & 64)) socket.emit('message', socket.sent[0]);
        const destination = mask & 2 ? 'local' : undefined;
        const frame = encodeFrame('vpsData', { f: 'remote', ...(destination ? { to: mask & 8 ? 'other' : destination } : {}) }, bytes);
        const key = deriveRelayFrameKey('invite', mask & 16 ? 'other-session' : 'round2');
        const packet = { t: 'data', f: mask & 4 ? 'local' : 'remote', to: destination, d: encryptRelayPacket(key, frame).toString('base64') };
        if (mask & 32) { relay.stop(); socket.emit('message', socket.sent[0]); }
        socket.emit('message', JSON.stringify(packet));
        assert.equal(count, mask & (4 | 16 | 32 | 64) || (mask & 2 && mask & 8) ? 0 : 1);
      } finally { relay.stop(); }
    });
  }
});

describe('Round 2 relay boundary regression', () => {
  it('transports a maximum-size valid mesh frame without charging envelope bytes against its limit', () => {
    const socket = new Round2Socket();
    const relay = new VpsFrameRelay({ sessionId: 'large', token: 'invite', localPeerId: 'remote',
      vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) }, socketFactory: () => socket as unknown as WebSocket });
    const receiverSocket = new Round2Socket();
    const receiver = new VpsFrameRelay({ sessionId: 'large', token: 'invite', localPeerId: 'local',
      vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) }, socketFactory: () => receiverSocket as unknown as WebSocket });
    try {
      relay.start(); socket.emit('open'); socket.emit('message', socket.sent[0]);
      receiver.start(); receiverSocket.emit('open'); receiverSocket.emit('message', receiverSocket.sent[0]);
      const payload = Buffer.alloc(MAX_WIRE_FRAME_BYTES - encodeFrame('project').length, 42);
      const frame = encodeFrame('project', {}, payload); assert.equal(frame.length, MAX_WIRE_FRAME_BYTES);
      let received = 0; receiver.onFrame = (peer, bytes) => { assert.equal(peer, 'remote'); assert.deepEqual(bytes, frame); received++; };
      relay.send(frame, 'local'); receiverSocket.emit('message', socket.sent.at(-1)); assert.equal(received, 1);
      assert.throws(() => relay.send(Buffer.alloc(MAX_WIRE_FRAME_BYTES + 1)), /Invalid/);
    } finally { relay.stop(); receiver.stop(); }
  });
});

describe('Round 2 Stage 16 — stable GPU selection, replay and durable cancellation', () => {
  for (let mask = 0; mask < 16; mask++) {
    it(`case ${mask}: restarting the broker never reclaims completed work`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'pair-round2-durable-'));
      const team = randomBytes(32).toString('hex'); const owner = randomBytes(32).toString('hex');
      const options = { dataDirectory: root, clientToken: team, agentTokens: { pc: owner } };
      let server = new VpsServer(options); let port = await server.start();
      let client = new VpsClient(`http://127.0.0.1:${port}`, team);
      const poll = () => post(port, owner, '/v1/agents/pc/poll', { instanceId: 'installation', name: 'PC',
        resources: { cpuCount: 4, python: 'python3', gpus: [{ index: 7, name: 'GPU', memoryMb: 8192, uuid: firstUuid }] } });
      try {
        const job = input(mask);
        if (mask & 1) { job.device = 'gpu:0'; job.gpuUuid = firstUuid.toUpperCase(); }
        await client.submit(job);
        if (mask & 2) await client.submit({ ...job, files: Object.fromEntries(Object.entries(job.files).reverse()) });
        assert.equal((await poll()).data.job.id, job.id);
        if (mask & 4) await client.cancel(job.id);
        if (mask & 8) {
          await server.stop(); server = new VpsServer(options); port = await server.start(); client = new VpsClient(`http://127.0.0.1:${port}`, team);
          const restored = (await poll()).data.job; assert.equal(restored.id, job.id); assert.equal(restored.cancelRequested, !!(mask & 4));
        }
        const result = { status: mask & 4 ? 'cancelled' : 'succeeded', exitCode: mask & 4 ? -1 : 0 };
        assert.equal((await post(port, owner, '/v1/agents/pc/report', { instanceId: 'installation', jobId: job.id, offset: 0, log: '', result })).status, 200);
        await server.stop(); server = new VpsServer(options); port = await server.start(); client = new VpsClient(`http://127.0.0.1:${port}`, team);
        assert.equal((await poll()).data.job, null); assert.equal((await client.job(job.id)).status, result.status);
        assert.equal((await client.jobs()).length, 1);
      } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('Round 2 Stage 8 — pending receipt reconciliation during another window cleanup', () => {
  for (let mask = 0; mask < 8; mask++) {
    it(`case ${mask}: deletion of an already reconciled receipt does not hide the next one`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'pair-round2-receipts-'));
      const store = new PendingSubmissionStore(root); const endpoint = 'https://compute.example';
      const cleared = { ...input(0), id: 'a-cleared' }; const retained = { ...input(1), id: 'b-retained' };
      await store.save(mask & 1 ? 'https://other.example' : endpoint, cleared); await store.save(endpoint, retained);
      const original = fsPromises.readFile;
      // CommonJS import accesses the native method at call time. Delete after
      // readdir, exactly as a second extension window finishing recovery can.
      (fsPromises as any).readFile = async (...args: Parameters<typeof fsPromises.readFile>) => {
        if (mask & 4 && String(args[0]).endsWith('a-cleared.json')) await store.clear(cleared.id);
        return (original as any)(...args);
      };
      try {
        const loaded = await store.load(endpoint + (mask & 2 ? '/' : ''));
        assert.equal(loaded?.id, mask & (1 | 4) ? retained.id : cleared.id);
      } finally { (fsPromises as any).readFile = original; await rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('Round 2 Stage 1 — synchronized CPU training checkpoints survive both editors and a VPS outage', () => {
  it('a separate compute PC finishes training, then its live agent recovers logs exactly once', async function () {
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-round2-acceptance-'));
    const team = randomBytes(32).toString('hex'); const owner = randomBytes(32).toString('hex');
    const options = { dataDirectory: path.join(root, 'broker'), clientToken: team, agentTokens: { pc: owner } };
    let server = new VpsServer(options); const port = await server.start(); const endpoint = `http://127.0.0.1:${port}`;
    const client = new VpsClient(endpoint, team); let daemon: ChildProcess | undefined;
    const host = new Y.Doc(); const guest = new Y.Doc(); const relays: VpsFrameRelay[] = [];
    const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
      const end = Date.now() + 6000;
      while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
      assert.fail('Acceptance condition did not become true');
    };
    const contents = async (name: string): Promise<string> => { try { return await fsPromises.readFile(path.join(root, name), 'utf8'); } catch { return ''; } };
    const source = 'import json,os,time\nfrom pathlib import Path\nfrom helper import TARGET\np=Path(os.environ["PAIR_NOTEBOOK_WORKSPACE"])\nwith (p/"runs").open("a") as f: f.write("once\\n")\nw=0.0\nfor step in range(30):\n w -= 0.2*(w-TARGET)\n (p/"checkpoint.json").write_text(json.dumps({"step":step,"weight":w}))\n print(step,w,flush=True)\n time.sleep(0.03)\n(p/"done").write_text(str(w))\n';
    try {
      host.getMap<string>('source').set('train.py', source);
      const common = { sessionId: 'round2-acceptance', token: 'shared-invitation', vps: { url: endpoint, token: team } };
      const hostRelay = new VpsFrameRelay({ ...common, localPeerId: 'host-editor' });
      const guestRelay = new VpsFrameRelay({ ...common, localPeerId: 'guest-editor' }); relays.push(hostRelay, guestRelay);
      hostRelay.onFrame = (_peer, bytes) => Y.applyUpdate(host, bytes);
      guestRelay.onFrame = (_peer, bytes) => Y.applyUpdate(guest, bytes);
      hostRelay.start(); guestRelay.start(); await Promise.all(relays.map((relay) => relay.waitUntilReady(3000)));
      hostRelay.send(Buffer.from(Y.encodeStateAsUpdate(host)), 'guest-editor'); await until(() => guest.getMap('source').get('train.py') === source);
      guest.getMap<string>('source').set('helper.py', 'TARGET=2.0');
      const update = Buffer.from(Y.encodeStateAsUpdate(guest)); guestRelay.send(update, 'host-editor'); guestRelay.send(update, 'host-editor');
      await until(() => host.getMap('source').get('helper.py') === 'TARGET=2.0');
      assert.deepEqual(host.getMap('source').toJSON(), guest.getMap('source').toJSON());
      daemon = spawn('python3', [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'pc',
        '--state', path.join(root, 'agent'), '--workspace', root, '--poll-seconds', '0.1'],
      { env: { ...process.env, PAIR_AGENT_TOKEN: owner, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore' });
      await until(async () => (await client.agents()).length === 1);
      const job = { ...input(1), id: 'checkpoint-training', files: guest.getMap<string>('source').toJSON() };
      await client.submit(job); await client.submit(job); // retry a possibly lost acknowledgement
      await until(async () => await contents('runs') === 'once\n');
      relays.forEach((relay) => relay.stop()); host.destroy(); guest.destroy(); await server.stop();
      await until(async () => (await contents('done')).length > 0);
      const checkpoint = JSON.parse(await contents('checkpoint.json'));
      assert.equal(checkpoint.step, 29); assert.ok(Math.abs(checkpoint.weight - 2) < 0.01);
      assert.equal(daemon.exitCode, null, 'Polling service stays alive through the VPS outage');
      server = new VpsServer(options); await server.start(port);
      await until(async () => (await client.job(job.id)).status === 'succeeded');
      const completed = await client.job(job.id);
      assert.equal(Buffer.from(completed.log, 'base64').toString().trim().split('\n').length, 30);
      assert.equal(await contents('runs'), 'once\n'); assert.equal((await client.jobs()).length, 1);
      assert.equal((await client.submit(job)).status, 'succeeded');
    } finally {
      relays.forEach((relay) => relay.stop()); host.destroy(); guest.destroy();
      if (daemon && daemon.exitCode === null) { const exited = new Promise<void>((resolve) => daemon!.once('exit', () => resolve())); daemon.kill('SIGTERM'); await exited; }
      await server.stop(); await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Round 2 Stage 512 — GPU identity and valid compute-profile combinations', () => {
  let server: VpsServer; let root: string; let port: number;
  const clientToken = randomBytes(32).toString('hex'); const agentToken = randomBytes(32).toString('hex');
  before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'pair-round2-inventory-'));
    server = new VpsServer({ dataDirectory: root, clientToken, agentTokens: { pc: agentToken } }); port = await server.start(); });
  after(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  for (let mask = 0; mask < 512; mask++) {
    it(`case ${mask}: each physical GPU has one unambiguous identity`, async () => {
      const gpus: Array<{ index: number; name: string; memoryMb: number; uuid?: string }> = [
        { index: 0, name: 'First GPU', memoryMb: mask & 16 ? 0 : 8192, uuid: firstUuid },
        { index: 2, name: 'Second GPU', memoryMb: 16384, ...(mask & 64 ? {} : { uuid: secondUuid }) },
      ];
      if (mask & 1) gpus[1]!.uuid = firstUuid;
      if (mask & 2) gpus[0]!.uuid = firstUuid.replace('GPU-', 'gpu-');
      if (mask & 4) gpus[0]!.uuid = 'GPU-invalid';
      if (mask & 256) gpus.reverse();
      const body = { instanceId: 'round2-installation', name: mask & 128 ? 'Компьютер 日本' : 'PC',
        resources: { cpuCount: mask & 8 ? 65536 : 8, python: mask & 32 ? '/owner/окружение/python' : 'python3', gpus } };
      assert.equal((await post(port, agentToken, '/v1/agents/pc/poll', body)).status, mask & 7 ? 400 : 200);
    });
  }
});
