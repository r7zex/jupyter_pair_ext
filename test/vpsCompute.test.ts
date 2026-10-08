import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { VpsServer, type VpsServerOptions } from '../src/vps/server';
import { VpsClient } from '../src/vps/client';
import { type JobSubmission, LOG_RETENTION_BYTES, MAX_LOG_CHUNK, normalizeVpsUrl, validateSubmission, vpsSecretKey } from '../src/vps/protocol';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';
import * as Y from 'yjs';
import { RedundantFrameRelay } from '../src/runtime/redundantFrameRelay';
import type { FrameRelay } from '../src/runtime/frameRelay';

async function until(check: () => Promise<boolean> | boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true before timeout');
}

function request(endpoint: string, token: string, route: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(endpoint + route, { method: bytes ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${token}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

describe('VPS durable background compute', function () {
  this.timeout(20_000);
  let directory: string;
  let options: VpsServerOptions;
  let server: VpsServer;
  let endpoint: string;
  let client: VpsClient;
  let clientToken: string;
  let agentToken: string;
  let otherToken: string;
  const children: ChildProcess[] = [];
  const relays: VpsFrameRelay[] = [];
  const inventory = { instanceId: 'installation-one', name: 'GPU PC', resources: { cpuCount: 16, python: 'python3', gpus: [] } };
  const job = (id: string): JobSubmission => ({ id, agentId: 'compute-pc', title: 'train.py', device: 'cpu',
    entrypoint: 'train.py', files: { 'train.py': 'print("train")' }, args: [] });

  beforeEach(async () => {
    installProxyAwareWebSocket({ env: {} });
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-vps-test-'));
    clientToken = randomBytes(32).toString('hex'); agentToken = randomBytes(32).toString('hex'); otherToken = randomBytes(32).toString('hex');
    options = { dataDirectory: path.join(directory, 'broker'), clientToken, agentTokens: { 'compute-pc': agentToken, 'other-pc': otherToken } };
    server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`;
    client = new VpsClient(endpoint, clientToken);
  });
  afterEach(async () => {
    for (const relay of relays.splice(0)) relay.stop();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM'); await closed;
      }
    }
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps submission retries idempotent, preserves jobs on VPS restart and pins claims to the agent installation', async () => {
    await client.submit(job('durable'));
    await client.submit(job('durable'));
    assert.equal((await client.jobs()).length, 1);
    assert.equal((await request(endpoint, clientToken, '/v1/jobs', { ...job('durable'), files: { 'train.py': 'different' } })).status, 409);
    const claimed = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    assert.equal(claimed.data.job.status, 'running');
    await server.stop(); server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`; client = new VpsClient(endpoint, clientToken);
    assert.equal((await client.job('durable')).status, 'running');
    assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', { ...inventory, instanceId: 'fresh-install' })).status, 409);
    assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory)).data.job.id, 'durable');
    const compact = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', { ...inventory, knownJobId: 'durable' });
    assert.equal(compact.data.job.files, undefined);
  });

  it('accepts reordered immutable sources and restores a large source snapshot plus retained output', async () => {
    const input = { ...job('large-snapshot'), files: { 'train.py': '#'.repeat(3 * 1024 * 1024), 'helper.py': 'VALUE=1' } };
    await client.submit(input);
    await client.submit({ ...input, files: { 'helper.py': 'VALUE=1', 'train.py': input.files['train.py'] } });
    await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    for (let offset = 0; offset < LOG_RETENTION_BYTES; offset += MAX_LOG_CHUNK) {
      assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/report', {
        ...inventory, jobId: input.id, offset, log: Buffer.alloc(MAX_LOG_CHUNK, 'x').toString('base64'),
      })).status, 200);
    }
    await server.stop(); server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`; client = new VpsClient(endpoint, clientToken);
    assert.equal((await client.job(input.id)).logEnd, LOG_RETENTION_BYTES);
    assert.equal((await client.submit(input)).status, 'running');
  });

  it('rejects changed overlapping logs and conflicting or appended terminal reports', async () => {
    await client.submit(job('immutable-result'));
    await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    const report = (body: unknown) => request(endpoint, agentToken, '/v1/agents/compute-pc/report', body);
    const body = { ...inventory, jobId: 'immutable-result', offset: 0, log: Buffer.from('hello').toString('base64') };
    assert.equal((await report(body)).status, 200);
    assert.equal((await report({ ...body, offset: 2, log: Buffer.from('XXX new').toString('base64') })).status, 409);
    const result = { status: 'succeeded', exitCode: 0 };
    assert.equal((await report({ ...body, result })).status, 200);
    assert.equal((await report({ ...body, result })).status, 200);
    assert.equal((await report({ ...body, offset: 5, log: Buffer.from('extra').toString('base64') })).status, 409);
    assert.equal((await report({ ...body, result: { status: 'failed', exitCode: 1 } })).status, 409);
    assert.equal(Buffer.from((await client.job(body.jobId)).log, 'base64').toString(), 'hello');
    assert.equal((await client.job(body.jobId)).status, 'succeeded');
  });

  it('enforces one writer and safely reclaims the lock of a dead local broker', async () => {
    const second = new VpsServer(options);
    await assert.rejects(second.start(), /Another VPS broker/);
    await second.stop();
    await client.submit(job('still-owned'));
    await server.stop();
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const lock = path.join(options.dataDirectory, '.broker-lock');
    await mkdir(lock);
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, host: os.hostname(), nonce: 'dead-owner' }));
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    assert.equal((await new VpsClient(endpoint, clientToken).jobs()).length, 1);
  });

  it('rejects incoherent restored state and releases ownership after startup validation fails', async () => {
    const input = job('restore-check'); await client.submit(input); await server.stop();
    const location = path.join(options.dataDirectory, `${input.id}.json`);
    const original = JSON.parse(await readFile(location, 'utf8'));
    for (const corruption of [{ cancelRequested: 'false' }, { cancelRequested: true }, { status: 'running' },
      { log: '!!!!' }, { startedAt: 1 }, { finishedAt: 1 }, { status: 'succeeded', finishedAt: 1, exitCode: 1 }]) {
      await writeFile(location, JSON.stringify({ ...original, ...corruption }));
      const invalid = new VpsServer(options); await assert.rejects(invalid.start(), /inconsistent/); await invalid.stop();
    }
    await writeFile(location, JSON.stringify(original)); server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`;
    assert.equal((await new VpsClient(endpoint, clientToken).job(input.id)).status, 'queued');
  });

  it('opens a 128 MiB source store with a 96 MiB heap and loads the selected job on demand', async () => {
    await server.stop();
    const source = '#'.repeat(2 * 1024 * 1024);
    for (let index = 0; index < 64; index++) {
      const input = { ...job(`memory-${index}`), files: { 'train.py': source } };
      await writeFile(path.join(options.dataDirectory, `${input.id}.json`), JSON.stringify({ ...input,
        createdAt: index, status: 'queued', cancelRequested: false, logStart: 0, logEnd: 0, log: '' }));
    }
    const script = `
      const { VpsServer } = require(process.argv[1]);
      const { VpsClient } = require(process.argv[2]);
      require(process.argv[3]).installProxyAwareWebSocket({ env: {} });
      const options = JSON.parse(process.argv[4]);
      (async () => {
        const broker = new VpsServer(options);
        try {
          const url = 'http://127.0.0.1:' + await broker.start();
          const count = (await new VpsClient(url, options.clientToken).jobs()).length;
          const response = await fetch(url + '/v1/agents/compute-pc/poll', { method: 'POST',
            headers: { authorization: 'Bearer ' + options.agentTokens['compute-pc'], 'content-type': 'application/json' },
            body: JSON.stringify({ instanceId: 'bounded-heap', name: 'PC', resources: { cpuCount: 1, python: 'python3', gpus: [] } }) });
          const result = await response.json();
          process.stdout.write(JSON.stringify({ count, sourceLength: result.job.files['train.py'].length }));
        } finally { await broker.stop(); }
      })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['--max-old-space-size=96', '-e', script,
      require.resolve('../src/vps/server'), require.resolve('../src/vps/client'), require.resolve('../src/runtime/proxyWebSocket'), JSON.stringify(options)],
      { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = ''; let stderr = '';
    child.stdout!.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr!.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, stderr.slice(0, 1600));
    assert.deepEqual(JSON.parse(stdout), { count: 64, sourceLength: source.length });
  });

  for (let mask = 0; mask < 4; mask++) {
    it(`Stage 4 case ${mask}: cancellation survives claim timing and broker restart`, async () => {
      const input = job(`cancel-${mask}`); await client.submit(input);
      if (mask & 1) await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
      await client.cancel(input.id);
      if (mask & 2) {
        await server.stop(); server = new VpsServer(options);
        endpoint = `http://127.0.0.1:${await server.start()}`; client = new VpsClient(endpoint, clientToken);
      }
      const saved = await client.job(input.id);
      assert.equal(saved.cancelRequested, true);
      assert.equal(saved.status, mask & 1 ? 'running' : 'cancelled');
      const polled = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
      if (mask & 1) assert.equal(polled.data.job.cancelRequested, true); else assert.equal(polled.data.job, null);
    });
  }

  it('separates team and per-machine credentials and rejects traversal and invalid GPU targets', async () => {
    assert.equal((await request(endpoint, 'invalid', '/v1/jobs')).status, 401);
    assert.equal((await request(endpoint, agentToken, '/v1/jobs')).status, 401);
    assert.equal((await request(endpoint, clientToken, '/v1/agents/compute-pc/poll', inventory)).status, 401);
    assert.equal((await request(endpoint, otherToken, '/v1/agents/compute-pc/poll', inventory)).status, 401);
    for (const name of ['../escape.py', '/absolute.py', 'C:/windows.py', 'folder\\escape.py', 'con.py', 'a'.repeat(256) + '.py', '\uD800.py']) {
      assert.equal((await request(endpoint, clientToken, '/v1/jobs', { ...job('bad'), entrypoint: name, files: { [name]: '' } })).status, 400);
    }
    await client.submit({ ...job('gpu-unavailable'), device: 'gpu:0' });
    await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    const failed = await client.job('gpu-unavailable');
    assert.equal(failed.status, 'failed');
    assert.equal(Buffer.from(failed.log, 'base64').length, failed.logEnd);
    // Failed jobs also survive strict store validation at restart.
    await server.stop(); server = new VpsServer(options); await server.start();
  });

  it('preserves queue order after restart rather than sorting random job IDs', async () => {
    await client.submit(job('z-first'));
    await client.submit(job('a-second'));
    await server.stop(); server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`;
    const first = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    assert.equal(first.data.job.id, 'z-first');
    await request(endpoint, agentToken, '/v1/agents/compute-pc/report', {
      ...inventory, jobId: 'z-first', offset: 0, log: '', result: { status: 'succeeded', exitCode: 0 },
    });
    const second = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    assert.equal(second.data.job.id, 'a-second');
  });

  it('deduplicates acknowledged log retries, retains bounded logs and delivers queued/running cancellation', async () => {
    await client.submit(job('logs'));
    await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory);
    const body = { ...inventory, jobId: 'logs', offset: 0, log: Buffer.from('hello\n').toString('base64') };
    await request(endpoint, agentToken, '/v1/agents/compute-pc/report', body);
    await request(endpoint, agentToken, '/v1/agents/compute-pc/report', body);
    assert.equal((await client.job('logs')).logEnd, 6);
    assert.equal(Buffer.from((await client.job('logs', 2)).log, 'base64').toString(), 'llo\n');
    assert.equal((await client.job('logs', 6)).log, '');
    assert.equal((await request(endpoint, clientToken, '/v1/jobs/logs?offset=-1')).status, 400);
    const chunk = Buffer.alloc(MAX_LOG_CHUNK, 'x').toString('base64');
    let offset = 6;
    for (let i = 0; i < 17; i++) {
      const result = await request(endpoint, agentToken, '/v1/agents/compute-pc/report', { ...body, offset, log: chunk });
      assert.equal(result.status, 200); offset = result.data.offset;
    }
    const detail = await client.job('logs');
    assert.equal(Buffer.from(detail.log, 'base64').length, LOG_RETENTION_BYTES);
    assert.equal(detail.logStart, offset - LOG_RETENTION_BYTES);
    assert.equal((await request(endpoint, otherToken, '/v1/agents/other-pc/report', { ...body, offset })).status, 403);
    await client.cancel('logs');
    assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory)).data.job.cancelRequested, true);
    assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/report', {
      ...body, offset, log: '', result: { status: 'cancelled', exitCode: -1 },
    })).status, 200);
    assert.equal((await client.job('logs')).status, 'cancelled');
    await client.submit(job('never-start'));
    await client.cancel('never-start');
    assert.equal((await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', inventory)).data.job, null);
  });

  it('relays authenticated encrypted P2P frames and recovers after a VPS restart', async () => {
    const port = new URL(endpoint).port;
    const common = { token: 'session-invitation-secret', sessionId: 'p2p-session', vps: { url: endpoint, token: clientToken } };
    const first = new VpsFrameRelay({ ...common, localPeerId: 'first' });
    const second = new VpsFrameRelay({ ...common, localPeerId: 'second' });
    const isolated = new VpsFrameRelay({ ...common, token: 'different-invitation', localPeerId: 'third' });
    relays.push(first, second, isolated);
    const received: Buffer[] = [];
    let isolatedFrames = 0;
    const announced: string[] = [];
    second.onFrame = (sender, bytes) => { assert.equal(sender, 'first'); received.push(bytes); };
    second.onPeerAnnounce = (peer) => announced.push(peer);
    isolated.onFrame = () => isolatedFrames++;
    first.start(); second.start(); isolated.start();
    await Promise.all(relays.map((relay) => relay.waitUntilReady(3000)));
    await until(() => announced.includes('first'));
    const bytes = Buffer.from('private notebook output');
    first.send(bytes, 'second'); await until(() => received.length === 1);
    assert.deepEqual(received[0], bytes); assert.equal(isolatedFrames, 0);
    await server.stop();
    await until(() => first.connectedRelayCount === 0);
    server = new VpsServer(options); await server.start(Number(port));
    await Promise.all([first.waitUntilReady(6000), second.waitUntilReady(6000)]);
    first.send(Buffer.from('after restart'), 'second'); await until(() => received.length === 2);
    assert.equal(received[1]!.toString(), 'after restart');
  });

  it('rotates a live private relay while keeping the other transport available', async () => {
    const other = new VpsServer({ ...options, dataDirectory: path.join(directory, 'other-broker') });
    const otherEndpoint = `http://127.0.0.1:${await other.start()}`;
    let starts = 0; let stops = 0; let sends = 0;
    const fallback: FrameRelay = { connectedRelayCount: 1, onFrame: () => undefined, onPeerAnnounce: () => undefined,
      start: () => { starts++; }, stop: () => { stops++; }, send: () => { sends++; }, sendAnnounce: () => undefined, waitUntilReady: async () => undefined };
    const common = { token: 'rotation-invite', sessionId: 'rotation-session' };
    const changing = new RedundantFrameRelay({ ...common, localPeerId: 'changing', channels: [fallback], vps: { url: endpoint, token: clientToken } });
    const firstPeer = new VpsFrameRelay({ ...common, localPeerId: 'other', vps: { url: endpoint, token: clientToken } });
    const secondPeer = new VpsFrameRelay({ ...common, localPeerId: 'other', vps: { url: otherEndpoint, token: clientToken } });
    relays.push(firstPeer, secondPeer); const firstFrames: string[] = []; const secondFrames: string[] = [];
    firstPeer.onFrame = (_sender, bytes) => firstFrames.push(bytes.toString()); secondPeer.onFrame = (_sender, bytes) => secondFrames.push(bytes.toString());
    try {
      changing.start(); firstPeer.start(); secondPeer.start();
      await Promise.all([firstPeer.waitUntilReady(3000), secondPeer.waitUntilReady(3000)]);
      await until(() => changing.connectedRelayCount === 2);
      changing.send(Buffer.from('before'), 'other'); await until(() => firstFrames.length === 1);
      changing.updateVps({ url: otherEndpoint, token: clientToken });
      await until(() => changing.connectedRelayCount === 2);
      changing.send(Buffer.from('after'), 'other'); await until(() => secondFrames.length === 1);
      assert.deepEqual(firstFrames, ['before']); assert.deepEqual(secondFrames, ['after']);
      assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(sends, 2);
      changing.updateVps(); assert.equal(changing.connectedRelayCount, 1);
      changing.send(Buffer.from('fallback remains')); assert.equal(sends, 3);
    } finally { changing.stop(); await other.stop(); }
    assert.equal(changing.connectedRelayCount, 0);
  });

  it('pins a queued GPU selection to its UUID when inventory indices change', async () => {
    const uuid = 'GPU-01234567-89ab-cdef-0123-456789abcdef';
    await client.submit({ ...job('gpu-identity'), device: 'gpu:7', gpuUuid: uuid });
    const polled = await request(endpoint, agentToken, '/v1/agents/compute-pc/poll', { ...inventory,
      resources: { ...inventory.resources, gpus: [{ index: 2, name: 'Selected GPU', memoryMb: 8192, uuid }] } });
    assert.equal(polled.data.job.status, 'running'); assert.equal(polled.data.job.gpuUuid, uuid);
  });

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`Stage 2 ${signal}: training survives agent/VPS outages and reconciles once after restart`, async function () {
      if (process.platform === 'win32') this.skip();
      const port = Number(new URL(endpoint).port);
      const state = path.join(directory, 'agent');
      const launch = (): ChildProcess => {
        const child = spawn('python3', [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'compute-pc',
          '--state', state, '--workspace', directory, '--poll-seconds', '0.1'], {
          env: { ...process.env, PAIR_AGENT_TOKEN: agentToken, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore',
        });
        children.push(child); return child;
      };
      const originalAgent = launch();
      await until(async () => (await client.agents()).length === 1);
      await client.submit({ ...job('offline-training'), files: {
        'helper.py': 'VALUE = "completed once"',
        'train.py': 'import os, time\nfrom pathlib import Path\nfrom helper import VALUE\nroot = Path(os.environ["PAIR_NOTEBOOK_WORKSPACE"])\nwith (root / "runs").open("a") as f: f.write("run\\n")\nprint("training started", flush=True)\ntime.sleep(1.2)\n(root / "finished").write_text(VALUE)\nprint(VALUE, flush=True)\n',
      } });
      await until(async () => { try { return (await readFile(path.join(directory, 'runs'), 'utf8')) === 'run\n'; } catch { return false; } });
      const stopped = new Promise<void>((resolve) => originalAgent.once('exit', () => resolve()));
      originalAgent.kill(signal); await stopped;
      await server.stop();
      await until(async () => { try { return (await readFile(path.join(directory, 'finished'), 'utf8')) === 'completed once'; } catch { return false; } });
      server = new VpsServer(options); await server.start(port);
      assert.equal((await client.job('offline-training')).status, 'running');
      launch();
      await until(async () => (await client.job('offline-training')).status === 'succeeded');
      const completed = await client.job('offline-training');
      assert.match(Buffer.from(completed.log, 'base64').toString(), /completed once/);
      assert.equal(await readFile(path.join(directory, 'runs'), 'utf8'), 'run\n');
      // Repeated heartbeat/recovery never executes an already completed job again.
      assert.equal((await client.jobs()).length, 1);
    });
  }

  it('Stage 1 acceptance: a guest submits synchronized source to a separate PC, then both peers and VPS go offline', async function () {
    if (process.platform === 'win32') this.skip();
    const hostDocument = new Y.Doc(); const guestDocument = new Y.Doc();
    const source = 'import os,time\nfrom pathlib import Path\np=Path(os.environ["PAIR_NOTEBOOK_WORKSPACE"])\nwith (p/"acceptance-runs").open("a") as f: f.write("once\\n")\nprint("guest training",flush=True)\ntime.sleep(0.8)\n(p/"acceptance-done").write_text("complete")\n';
    hostDocument.getMap<string>('sources').set('train.py', source);
    const common = { token: 'acceptance-invite', sessionId: 'acceptance-session', vps: { url: endpoint, token: clientToken } };
    const hostRelay = new VpsFrameRelay({ ...common, localPeerId: 'host-editor' });
    const guestRelay = new VpsFrameRelay({ ...common, localPeerId: 'guest-editor' }); relays.push(hostRelay, guestRelay);
    guestRelay.onFrame = (_sender, bytes) => Y.applyUpdate(guestDocument, bytes);
    hostRelay.start(); guestRelay.start();
    await Promise.all([hostRelay.waitUntilReady(3000), guestRelay.waitUntilReady(3000)]);
    hostRelay.send(Buffer.from(Y.encodeStateAsUpdate(hostDocument)), 'guest-editor');
    await until(() => guestDocument.getMap('sources').get('train.py') === source);
    const state = path.join(directory, 'acceptance-agent');
    const launch = (): ChildProcess => {
      const child = spawn('python3', [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'compute-pc',
        '--state', state, '--workspace', directory, '--poll-seconds', '0.1'], {
        env: { ...process.env, PAIR_AGENT_TOKEN: agentToken, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore',
      }); children.push(child); return child;
    };
    const daemon = launch(); await until(async () => (await client.agents()).length === 1);
    const guestClient = new VpsClient(endpoint, clientToken);
    await guestClient.submit({ ...job('guest-acceptance'), files: guestDocument.getMap<string>('sources').toJSON() });
    await until(async () => { try { return (await readFile(path.join(directory, 'acceptance-runs'), 'utf8')) === 'once\n'; } catch { return false; } });
    hostRelay.stop(); guestRelay.stop(); hostDocument.destroy(); guestDocument.destroy();
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve())); daemon.kill('SIGKILL'); await exited;
    const port = Number(new URL(endpoint).port); await server.stop();
    await until(async () => { try { return (await readFile(path.join(directory, 'acceptance-done'), 'utf8')) === 'complete'; } catch { return false; } });
    server = new VpsServer(options); await server.start(port); launch();
    await until(async () => (await guestClient.job('guest-acceptance')).status === 'succeeded');
    assert.equal(await readFile(path.join(directory, 'acceptance-runs'), 'utf8'), 'once\n');
    assert.match(Buffer.from((await guestClient.job('guest-acceptance')).log, 'base64').toString(), /guest training/);
  });

  it('cancels an actual detached training process without making a participant the host', async function () {
    if (process.platform === 'win32') this.skip();
    const state = path.join(directory, 'cancel-agent');
    const child = spawn('python3', [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'compute-pc',
      '--state', state, '--workspace', directory, '--poll-seconds', '0.1'], {
      env: { ...process.env, PAIR_AGENT_TOKEN: agentToken, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore',
    });
    children.push(child);
    await until(async () => (await client.agents()).length === 1);
    await client.submit({ ...job('cancel-real'), files: { 'train.py': 'import time\nprint("started", flush=True)\ntime.sleep(5)\nprint("must not finish")' } });
    await until(async () => Buffer.from((await client.job('cancel-real')).log, 'base64').toString().includes('started'));
    await client.cancel('cancel-real');
    await until(async () => (await client.job('cancel-real')).status === 'cancelled');
    const detail = await client.job('cancel-real');
    assert.doesNotMatch(Buffer.from(detail.log, 'base64').toString(), /must not finish/);
    assert.equal(await readFile(path.join(state, 'jobs', 'cancel-real', 'work', 'train.py'), 'utf8'), 'import time\nprint("started", flush=True)\ntime.sleep(5)\nprint("must not finish")');
  });

  it('cancels training descendants in the same Linux process group', async function () {
    if (process.platform !== 'linux') this.skip();
    const state = path.join(directory, 'descendant-agent');
    const daemon = spawn('python3', [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'compute-pc',
      '--state', state, '--workspace', directory, '--poll-seconds', '0.1'], {
      env: { ...process.env, PAIR_AGENT_TOKEN: agentToken, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore',
    }); children.push(daemon);
    await until(async () => (await client.agents()).length === 1);
    await client.submit({ ...job('cancel-descendants'), files: {
      'train.py': 'import subprocess,sys,time\nsubprocess.Popen([sys.executable,"child.py"])\ntime.sleep(20)\n',
      'child.py': 'import os,time\nfrom pathlib import Path\np=Path(os.environ["PAIR_NOTEBOOK_WORKSPACE"])\n(p/"child-pid").write_text(str(os.getpid()))\ntime.sleep(20)\n(p/"child-finished").write_text("should not finish")\n',
    } });
    let pid = '';
    await until(async () => { try { pid = await readFile(path.join(directory, 'child-pid'), 'utf8'); return /^\d+$/.test(pid); } catch { return false; } });
    await client.cancel('cancel-descendants');
    await until(async () => (await client.job('cancel-descendants')).status === 'cancelled');
    await until(async () => {
      try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(')')[1]!.trim().startsWith('Z '); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    });
    await assert.rejects(readFile(path.join(directory, 'child-finished')));
  });
});

describe('VPS source and credential boundaries', () => {
  it('binds secrets to the canonical endpoint and requires TLS outside loopback', () => {
    assert.equal(normalizeVpsUrl('https://my-vps.example/'), 'https://my-vps.example');
    assert.equal(vpsSecretKey('https://my-vps.example/'), vpsSecretKey('https://my-vps.example'));
    assert.notEqual(vpsSecretKey('https://my-vps.example'), vpsSecretKey('https://other.example'));
    for (const url of ['http://my-vps.example', 'https://user:secret@my-vps.example', 'https://my-vps.example/?token=secret']) {
      assert.throws(() => normalizeVpsUrl(url));
    }
  });
  it('rejects case collisions and file/directory collisions in portable source snapshots', () => {
    const base = { id: 'job', agentId: 'agent', title: 'train', device: 'cpu', entrypoint: 'train.py', args: [] };
    assert.throws(() => validateSubmission({ ...base, files: { 'train.py': '', 'TRAIN.py': '' } }));
    assert.throws(() => validateSubmission({ ...base, files: { 'train.py': '', 'train.py/child.py': '' } }));
  });
});
