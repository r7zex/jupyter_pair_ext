import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { VpsServer, type VpsServerOptions } from '../src/vps/server';
import type { PersistentMembership } from '../src/vps/persistentProtocol';

const administrator = 'X'.repeat(40);
const agent = 'Y'.repeat(40);
const password = 'privacy regression password';
const encode = (value: string): string => Buffer.from(value).toString('base64');
const notebook = (output?: string): string => encode(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
  cells: [{ id: 'stable', cell_type: 'code', source: 'print("output")', metadata: {}, execution_count: null,
    outputs: output ? [{ output_type: 'stream', name: 'stdout', text: output }] : [] }] }));
interface RpcResult { status: number; data: Record<string, any> }

describe('Persistent execution privacy boundaries', function () {
  this.timeout(15000);
  let directory: string;
  let options: VpsServerOptions;
  let server: VpsServer;
  let endpoint: string;
  let owner: PersistentMembership;

  async function rpc(body: Record<string, unknown>, credential?: string): Promise<RpcResult> {
    const bytes = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request(`${endpoint}/v1/sessions/rpc`, { method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': bytes.length,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject); request.end(bytes);
    });
  }
  const call = (operation: string, fields: Record<string, unknown> = {}, credential = owner.token): Promise<RpcResult> =>
    rpc({ operation, sessionId: owner.sessionId, ...fields }, credential);
  async function launchGuest(): Promise<{ guest: PersistentMembership; command: Record<string, any>; request: Record<string, unknown> }> {
    const joined = await rpc({ operation: 'join', sessionId: owner.sessionId, password, name: 'Guest' });
    assert.equal(joined.status, 200);
    const guest = joined.data as unknown as PersistentMembership;
    const snapshot = await call('snapshot');
    const request = { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.data.revision, requestId: 'privacy-execution' };
    assert.equal((await call('execute', request, guest.token)).status, 200);
    const claimed = await rpc({ operation: 'claim', deviceId: 'vps' }, agent);
    assert.equal(claimed.status, 200); assert.ok(claimed.data.command);
    return { guest, command: claimed.data.command, request };
  }
  async function report(command: Record<string, any>, text: string, state: 'running' | 'completed'): Promise<void> {
    const response = await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state,
      events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text } }],
    }, agent);
    assert.equal(response.status, 200);
  }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-privacy-boundary-'));
    options = { dataDirectory: directory, clientToken: administrator, agentTokens: { vps: agent } };
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    const created = await rpc({ operation: 'create', name: 'Privacy test', password }, administrator);
    assert.equal(created.status, 200); owner = created.data as unknown as PersistentMembership;
    assert.equal((await rpc({ operation: 'registerDevice', deviceId: 'vps', device: { id: 'vps', name: 'CPU', python: 'python3',
      cpu: 'CPU', gpus: [], ready: true, isolation: 'test device' } }, agent)).status, 200);
    assert.equal((await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).status, 200);
  });
  afterEach(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });

  it('returns output-free summaries without mutating retained results or bypassing privacy checks', async () => {
    const { guest, command } = await launchGuest();
    const text = 'saved output '.repeat(1024);
    await report(command, text, 'completed');
    const summary = await call('execution', { executionId: command.executionId, summary: true }, guest.token);
    assert.equal(summary.status, 200); assert.equal(summary.data.id, command.executionId);
    assert.deepEqual(summary.data.events, []);
    const full = await call('execution', { executionId: command.executionId }, guest.token);
    assert.equal(full.data.events[0].content.text, text);
    const snapshot = await call('snapshot');
    assert.equal((await call('visibility', { path: 'work.ipynb', visibility: 'private', expectedRevision: snapshot.data.revision })).status, 200);
    const denied = await call('execution', { executionId: command.executionId, summary: true }, guest.token);
    assert.ok([403, 404].includes(denied.status));
    assert.deepEqual((await call('execution', { executionId: command.executionId, summary: true })).data.events, []);
  });

  it('does not disclose old execution output through active kernel controls after a privacy change', async () => {
    const { guest, command } = await launchGuest();
    const snapshot = await call('snapshot');
    assert.equal((await call('visibility', { path: 'work.ipynb', visibility: 'private', expectedRevision: snapshot.data.revision })).status, 200);
    await report(command, 'private output sentinel', 'running');
    const controlled = await call('kernelControl', { executionId: command.executionId, command: { command: 'interrupt' } }, guest.token);
    assert.equal(JSON.stringify(controlled.data).includes('private output sentinel'), false);
  });

  it('checks notebook access when replaying an execution request after a move into a private directory', async () => {
    const { guest, command, request } = await launchGuest();
    let snapshot = await call('snapshot');
    snapshot = await call('mkdir', { path: 'private', visibility: 'private', expectedRevision: snapshot.data.revision });
    assert.equal((await call('rename', { path: 'work.ipynb', newPath: 'private/work.ipynb', expectedRevision: snapshot.data.revision })).status, 200);
    await report(command, 'renamed private output sentinel', 'running');
    const replay = await call('execute', request, guest.token);
    assert.equal(JSON.stringify(replay.data).includes('renamed private output sentinel'), false);
  });

  it('does not resend now-private dependency contents when recovering an already accepted command', async () => {
    let snapshot = await call('snapshot');
    snapshot = await call('write', { path: 'data.txt', content: encode('private dependency sentinel'), expectedRevision: snapshot.data.revision });
    await launchGuest();
    assert.equal((await call('visibility', { path: 'data.txt', visibility: 'private', expectedRevision: snapshot.data.revision })).status, 200);
    const recovered = await rpc({ operation: 'claim', deviceId: 'vps' }, agent);
    assert.equal(JSON.stringify(recovered.data).includes(encode('private dependency sentinel')), false);
  });

  it('retains an editor change to notebook output when an older execution later completes', async () => {
    const { command } = await launchGuest();
    const snapshot = await call('snapshot');
    assert.equal((await call('write', { path: 'work.ipynb', content: notebook('editor output sentinel'), expectedRevision: snapshot.data.revision })).status, 200);
    await report(command, 'old execution output', 'completed');
    const saved = await call('read', { path: 'work.ipynb' });
    assert.equal(Buffer.from(saved.data.content, 'base64').toString('utf8').includes('editor output sentinel'), true);
  });

  it('retires public kernels and fences guest output when a dependency moves beneath a private ancestor', async () => {
    let snapshot = await call('snapshot');
    snapshot = await call('write', { path: 'data.txt', content: encode('private dependency'), expectedRevision: snapshot.data.revision });
    snapshot = await call('mkdir', { path: 'private', visibility: 'private', expectedRevision: snapshot.data.revision });
    const { guest, command } = await launchGuest();
    const before = (await call('view')).data.generation;
    snapshot = await call('rename', { path: 'data.txt', newPath: 'renamed-data.txt', expectedRevision: snapshot.data.revision });
    assert.equal(snapshot.status, 200); assert.equal((await call('view')).data.generation, before);
    snapshot = await call('rename', { path: 'renamed-data.txt', newPath: 'private/data.txt', expectedRevision: snapshot.data.revision });
    assert.equal(snapshot.status, 200); assert.equal((await call('view')).data.generation, before + 1);
    await report(command, 'prior dependency output', 'completed');
    assert.equal((await call('execution', { executionId: command.executionId }, guest.token)).status, 403);
    assert.equal((await call('execution', { executionId: command.executionId })).data.events[0].content.text, 'prior dependency output');
    const next = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.data.revision, requestId: 'after-private-rename' }, guest.token);
    assert.equal(next.status, 200); assert.equal(next.data.generation, before + 1);
    const nextCommand = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    assert.equal(nextCommand.files.some((file: { path: string }) => file.path.startsWith('private/')), false);
    const saved = JSON.parse(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString('utf8'));
    assert.deepEqual(saved.cells[0].outputs, []);
  });

  it('keeps retained results and artifact transport readable by the owner after a notebook move and deletion', async () => {
    const { guest, command } = await launchGuest();
    assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state: 'completed',
      events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'retained result' } }],
      files: [{ path: 'result.txt', content: encode('retained artifact'), version: 0 }],
    }, agent)).status, 200);
    let snapshot = await call('snapshot');
    snapshot = await call('rename', { path: 'work.ipynb', newPath: 'moved.ipynb', expectedRevision: snapshot.data.revision });
    assert.equal(snapshot.status, 200);
    for (const mutation of ['rename', 'remove']) {
      if (mutation === 'remove') {
        snapshot = await call('remove', { path: 'moved.ipynb', expectedRevision: snapshot.data.revision }); assert.equal(snapshot.status, 200);
      }
      const retained = await call('execution', { executionId: command.executionId });
      assert.equal(retained.status, 200); assert.equal(retained.data.notebook, 'work.ipynb');
      assert.equal(retained.data.events[0].content.text, 'retained result');
      const artifacts = await call('artifacts', { executionId: command.executionId });
      assert.equal(artifacts.status, 200); assert.equal(artifacts.data.files[0].content, encode('retained artifact'));
      assert.notEqual((await call('execution', { executionId: command.executionId }, guest.token)).status, 200);
      assert.equal((await call('artifacts', { executionId: command.executionId }, guest.token)).status, 404);
    }
  });

  it('rejects symlinked saved authority instead of loading an external session record', async () => {
    await server.stop();
    const authority = path.join(directory, 'sessions', owner.sessionId, 'session.json');
    const outside = path.join(directory, 'external-authority.json');
    await writeFile(outside, await readFile(authority));
    await unlink(authority); await symlink(outside, authority);
    server = new VpsServer(options);
    await assert.rejects(server.start());
  });
});
