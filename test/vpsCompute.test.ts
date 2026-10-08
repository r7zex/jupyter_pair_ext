import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { VpsServer, type VpsServerOptions } from '../src/vps/server';
import { VpsClient } from '../src/vps/client';
import { type JobSubmission, LOG_RETENTION_BYTES, MAX_LOG_CHUNK, normalizeVpsUrl, validateSubmission, vpsSecretKey } from '../src/vps/protocol';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';

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

  it('separates team and per-machine credentials and rejects traversal and invalid GPU targets', async () => {
    assert.equal((await request(endpoint, 'invalid', '/v1/jobs')).status, 401);
    assert.equal((await request(endpoint, agentToken, '/v1/jobs')).status, 401);
    assert.equal((await request(endpoint, clientToken, '/v1/agents/compute-pc/poll', inventory)).status, 401);
    assert.equal((await request(endpoint, otherToken, '/v1/agents/compute-pc/poll', inventory)).status, 401);
    for (const name of ['../escape.py', '/absolute.py', 'C:/windows.py', 'folder\\escape.py', 'con.py']) {
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

  it('runs training without an editor, survives agent/VPS outages and reconciles once after restart', async function () {
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
    originalAgent.kill('SIGTERM'); await stopped;
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
