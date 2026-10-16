import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-relay-smoke-'));
let child;
try {
  execFileSync('tar', ['-xzf', 'artifacts/pair-notebook-relay.tar.gz', '-C', directory]);
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  child = spawn(process.execPath, [path.join(directory, 'relay/relay.js')], { cwd: directory,
    env: { ...process.env, NODE_PATH: '', PAIR_VPS_PORT: String(port), PAIR_VPS_BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const health = await globalThis.fetch(endpoint + '/health'); if (health.ok) { assert.equal((await health.json()).relayOnly, true); break; } } catch { /* Startup. */ }
    assert.equal(child.exitCode, null); await new Promise(resolve => setTimeout(resolve, 50));
  }
  execFileSync(process.execPath, [path.join(directory, 'relay/check.js'), endpoint], { stdio: 'inherit', timeout: 30_000 });
  const status = await new Promise((resolve, reject) => {
    const request = http.request(endpoint + '/v1/sessions/rpc', { method: 'POST' }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(status, 404);
  console.log('PASS: standalone relay archive, no node_modules/Python, encrypted reconnect, RPC unavailable.');
} finally {
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
  await fs.rm(directory, { recursive: true, force: true });
}
