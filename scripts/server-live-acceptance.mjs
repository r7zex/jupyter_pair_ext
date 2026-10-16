// Two independent API clients on one host. This does not measure physical input or VS Code rendering.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { PersistentClient } = require('../out/src/vps/persistentClient.js');
const [endpoint, credentialsFile, reportFile] = process.argv.slice(2);
assert(endpoint && credentialsFile && reportFile, 'Usage: node scripts/server-live-acceptance.mjs HTTPS_ORIGIN PRIVATE_TEST_CREDENTIAL_FILE REPORT.json');
const credentials = JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
const clients = [], streams = [], docs = [new Y.Doc(), new Y.Doc()];
const local = [], acknowledgements = [], observed = [], pending = [new Map(), new Map()];
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner, ownerClient;
const encode = bytes => Buffer.from(bytes).toString('base64');
const source = doc => doc.getMap('cells').get('first-cell').get('source');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const stats = values => ({ samples: values.length, medianMs: +percentile(values, 0.5).toFixed(3), p95Ms: +percentile(values, 0.95).toFixed(3), worstMs: +Math.max(...values).toFixed(3) });
const until = async (predicate, timeout = 15_000) => { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error('Acceptance condition timed out'); await delay(5); } };
try {
  const admin = new PersistentClient(endpoint, { kind: 'admin', token: credentials.adminToken }); clients.push(admin);
  await admin.checkCompatibility();
  owner = await admin.call('create', { name: 'Release live acceptance ' + randomUUID(), password: randomUUID() });
  ownerClient = new PersistentClient(endpoint, { kind: 'membership', token: owner.token }); clients.push(ownerClient);
  const call = (operation, fields = {}) => ownerClient.call(operation, { sessionId: owner.sessionId, ...fields });
  const invite = await call('createInvitation', { lifetimeSeconds: 3600, readOnly: false });
  assert(!JSON.stringify(invite).includes(credentials.adminToken));
  const anonymous = new PersistentClient(endpoint, { kind: 'anonymous' }); clients.push(anonymous);
  const membership = await anonymous.call('acceptInvitation', { sessionId: owner.sessionId, invitationToken: invite.invitationToken, name: 'Second client' });
  const guest = new PersistentClient(endpoint, { kind: 'membership', token: membership.token }); clients.push(guest);
  checks.push('owner creates project; second client joins by invitation without administrative key');
  await call('write', { path: 'test.ipynb', content: '', expectedRevision: 0 });
  await assert.rejects(call('notebookSync', { path: 'test.ipynb' }), error => error.status === 426);
  const empty = await call('notebookSync', { path: 'test.ipynb', bootstrapEmpty: true });
  const firstSource = 'print(6 * 7)';
  const initial = await call('notebookSync', { path: 'test.ipynb', epoch: empty.epoch,
    snapshotStateVector: encode(Y.encodeStateVectorFromUpdate(Buffer.from(empty.update, 'base64'))),
    snapshot: { metadata: {}, cells: [{ id: 'first-cell', cell_type: 'code', source: firstSource, metadata: {} }] } });
  assert.equal(initial.cells[0].source, firstSource);
  checks.push('old empty-notebook request is rejected; capable client preserves first unsaved cell');
  for (const doc of docs) Y.applyUpdate(doc, Buffer.from(initial.update, 'base64'));
  const receive = index => event => {
    if (event.kind !== 'notebook' || event.path !== 'test.ipynb' || !event.update) return;
    Y.applyUpdate(docs[index], Buffer.from(event.update, 'base64'));
    const text = source(docs[index]).toString();
    for (const [marker, started] of pending[index]) if (text.includes(marker)) { observed.push(performance.now() - started); pending[index].delete(marker); }
  };
  streams.push(ownerClient.subscribe(owner.sessionId, receive(0), () => undefined), guest.subscribe(owner.sessionId, receive(1), () => undefined));
  await delay(200);
  for (let round = 0; round < 30; round++) {
    const updates = docs.map((doc, index) => {
      const vector = Y.encodeStateVector(doc), marker = ` #client${index}_${round}`;
      const started = performance.now(); source(doc).insert(source(doc).length, marker); local.push(performance.now() - started);
      pending[1 - index].set(marker, performance.now());
      return encode(Y.encodeStateAsUpdate(doc, vector));
    });
    await Promise.all([ownerClient, guest].map(async (client, index) => {
      const started = performance.now();
      const reply = await client.call('notebookSync', { sessionId: owner.sessionId, path: 'test.ipynb', epoch: initial.epoch, update: updates[index] });
      acknowledgements.push(performance.now() - started);
      Y.applyUpdate(docs[index], Buffer.from(reply.update, 'base64'));
    }));
    await until(() => !pending[0].size && !pending[1].size);
    assert.equal(source(docs[0]).toString(), source(docs[1]).toString());
  }
  checks.push('60 simultaneous same-cell/same-line CRDT edits converge; no line lock');
  let view;
  for (let attempt = 0; attempt < 60; attempt++) {
    view = await call('heartbeat');
    if (view.devices.some(device => device.id === 'vps' && device.online && device.ready)) break;
    await delay(1000);
  }
  assert(view.devices.some(device => device.id === 'vps' && device.online && device.ready));
  const snapshot = await call('snapshot');
  const execution = await call('execute', { notebook: 'test.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: randomUUID() });
  let result;
  for (let attempt = 0; attempt < 90; attempt++) {
    result = await call('execution', { executionId: execution.id });
    if (['completed', 'failed', 'interrupted'].includes(result.state)) break;
    await delay(500);
  }
  assert.equal(result.state, 'completed');
  const saved = JSON.parse(Buffer.from((await call('read', { path: 'test.ipynb' })).content, 'base64').toString());
  assert(saved.cells[0].outputs.some(output => output.text?.join?.('')?.trim() === '42' || String(output.text ?? '').trim() === '42'));
  checks.push('actual isolated Jupyter executes the jointly edited first cell and returns 42');
  const release = await call('kernel', { notebook: 'test.ipynb', command: 'release', requestId: randomUUID() });
  for (let attempt = 0; attempt < 60; attempt++) {
    const released = await call('execution', { executionId: release.id });
    if (released.state === 'completed') break;
    await delay(500);
  }
  for (const stream of streams.splice(0)) stream.dispose();
  await call('leave');
  const reopened = new PersistentClient(endpoint, { kind: 'membership', token: owner.token }); clients.push(reopened);
  await reopened.checkCompatibility(); await reopened.call('heartbeat', { sessionId: owner.sessionId });
  const restored = JSON.parse(Buffer.from((await reopened.call('read', { sessionId: owner.sessionId, path: 'test.ipynb' })).content, 'base64').toString());
  assert.equal(restored.cells[0].source.join?.('') ?? restored.cells[0].source, source(docs[0]).toString());
  checks.push('leave and reconnect with retained identity restore all cell edits and saved output');
  const report = { scope: 'two independent logical API clients in one Node process on one host; HTTPS to isolated Linux server', physicalComputers: false, vscodeUi: false,
    localInputScope: 'synchronous Y.Text insertion only; excludes keyboard, VS Code event loop and rendering',
    checks, localCrdtInput: stats(local), serverAcknowledgement: stats(acknowledgements), secondClientObservation: stats(observed) };
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally {
  for (const stream of streams) stream.dispose();
  if (ownerClient && owner) await ownerClient.call('lifecycle', { sessionId: owner.sessionId, action: 'delete' }).catch(() => { console.error('Acceptance cleanup failed; the disposable project was retained for recovery.'); process.exitCode = 1; });
  for (const client of clients) client.dispose(); for (const doc of docs) doc.destroy();
}
