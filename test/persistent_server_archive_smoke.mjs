import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(repository, 'package.json'))).version;
const archive = path.join(repository, 'artifacts/pair-notebook-server-persistent.tar.gz');
const root = await mkdtemp(path.join(os.tmpdir(), 'persistent-packaged-smoke-'));
const admin = 'A'.repeat(40), password = 'packaged session validation password';
const checks = [];
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoded = (value) => Buffer.from(value).toString('base64');
async function port() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}
async function start() {
  const value = await port();
  const child = spawn(process.execPath, [path.join(root, 'server/out/src/vps/cli.js')], {
    cwd: path.join(root, 'empty'), env: { ...process.env,
      PAIR_VPS_CLIENT_TOKEN: admin, PAIR_VPS_AGENT_TOKENS: JSON.stringify({ vps: 'B'.repeat(40) }),
      PAIR_VPS_DATA: path.join(root, 'data'), PAIR_VPS_BIND: '127.0.0.1', PAIR_VPS_PORT: String(value) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child); child.on('error', () => undefined);
  child.stdout.resume(); child.stderr.resume();
  const url = `http://127.0.0.1:${value}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return { child, url, failed: true };
    try { if ((await request(url, '/health')).status === 200) return { child, url, failed: false }; } catch { /* Waiting for the listener. */ }
    await delay(50);
  }
  throw new Error('Packaged server did not become healthy');
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(5000).then(() => { throw new Error('Packaged server failed to stop'); })]);
  assert.equal(result[0], 0); children.delete(child);
}
function request(url, route, body, token) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, { method: bytes ? 'POST' : 'GET', headers: {
      ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    });
    req.setTimeout(1000, () => req.destroy(new Error('Smoke request timed out')));
    req.on('error', reject); req.end(bytes);
  });
}
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]); await mkdir(path.join(root, 'empty'));
  const manifest = JSON.parse(await readFile(path.join(root, 'server/BUILD.json')));
  assert.equal(manifest.version, version);
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(root, 'server', name))).digest('hex'), digest);
  }
  checks.push(`BUILD ${version}: ${Object.keys(manifest.files).length} file hashes`);
  let service = await start(); assert.equal(service.failed, false);
  assert.equal((await request(service.url, '/health')).data.persistentSessions, true);
  checks.push('standalone CLI from empty cwd, no node_modules');
  const rpc = (operation, fields = {}, token) => request(service.url, '/v1/sessions/rpc', { operation, ...fields }, token);
  const created = await rpc('create', { name: 'Packaged session', password }, admin); assert.equal(created.status, 200);
  const owner = created.data;
  const call = (operation, fields = {}, token = owner.token) => rpc(operation, { sessionId: owner.sessionId, ...fields }, token);
  let snap = await call('write', { path: 'public.txt', content: encoded('persistent content'), expectedRevision: 0 }); assert.equal(snap.status, 200);
  snap = await call('mkdir', { path: 'private', visibility: 'private', expectedRevision: snap.data.revision }); assert.equal(snap.status, 200);
  snap = await call('write', { path: 'private/secret.txt', content: encoded('private canary'), expectedRevision: snap.data.revision }); assert.equal(snap.status, 200);
  assert.equal((await call('leave')).status, 200); checks.push('headless create, durable files, owner leave');
  assert.equal((await call('join', { password: 'incorrect password', name: 'Bad' }, '')).status, 401);
  const joined = await call('join', { password, name: 'Guest' }, ''); assert.equal(joined.status, 200);
  const guest = joined.data;
  assert.equal((await rpc('create', { name: 'Forbidden', password }, guest.token)).status, 401);
  assert.equal((await call('view', {}, admin)).status, 401); checks.push('password join and credential separation');
  assert.equal((await call('read', { path: 'public.txt' }, guest.token)).data.content, encoded('persistent content'));
  assert.equal((await call('read', { path: 'private/secret.txt' }, guest.token)).status, 404);
  assert.equal((await call('snapshot', {}, guest.token)).data.entries.some((entry) => entry.path.startsWith('private')), false);
  checks.push('Public read, private direct API denial and snapshot exclusion');
  const duplicate = await start(); assert.equal(duplicate.failed, true); checks.push('second writer rejected');
  await stop(service.child); checks.push('clean SIGTERM');
  service = await start(); assert.equal(service.failed, false);
  const view = await call('view'); assert.equal(view.status, 200); assert.equal(view.data.id, owner.sessionId);
  assert.equal(view.data.ownerId, owner.memberId); assert.equal(view.data.state, 'running');
  assert.equal((await call('read', { path: 'public.txt' }, guest.token)).data.content, encoded('persistent content'));
  assert.equal((await call('read', { path: 'private/secret.txt' }, guest.token)).status, 404);
  assert.equal((await call('read', { path: 'private/secret.txt' })).data.content, encoded('private canary'));
  checks.push('new process restores ID, owner/member credentials, files and ACLs');
  assert.equal((await call('lifecycle', { action: 'stop' })).data.state, 'stopped');
  assert.equal((await call('snapshot', {}, guest.token)).status, 409);
  assert.equal((await call('lifecycle', { action: 'start' })).data.state, 'running');
  checks.push('owner stop/start gates participant workspace');
  await stop(service.child);
  console.log(JSON.stringify({ version: manifest.version, checks }, null, 2));
} finally {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }));
  await rm(root, { recursive: true, force: true });
}
