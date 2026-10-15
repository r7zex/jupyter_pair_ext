import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { defaultPermissions } from '../src/core/permissions';
import { encodeRelativeOffset, resolveRelativeOffset } from '../src/core/cursorPosition';
import { VpsServer } from '../src/vps/server';
import type { PersistentMembership } from '../src/vps/persistentProtocol';

describe('VPS participant permissions and line comments through HTTP', () => {
  let directory: string, endpoint: string, server: VpsServer, owner: PersistentMembership, guest: PersistentMembership;
  const admin = 'A'.repeat(40), agent = 'B'.repeat(40), password = 'participant-test-password';
  const options = () => ({ dataDirectory: directory, clientToken: admin, agentTokens: { vps: agent } });
  async function rpc(operation: string, fields: Record<string, unknown> = {}, credential = owner?.token): Promise<{ status: number; data: any }> {
    const bytes = Buffer.from(JSON.stringify({ operation, sessionId: owner?.sessionId, ...fields }));
    return new Promise((resolve, reject) => {
      const request = http.request(endpoint + '/v1/sessions/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length, ...(credential ? { authorization: `Bearer ${credential}` } : {}) } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on('error', reject); request.end(bytes);
    });
  }
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-permissions-')); server = new VpsServer(options());
    endpoint = `http://127.0.0.1:${await server.start()}`;
    owner = (await rpc('create', { name: 'Permissions', password }, admin)).data;
    guest = (await rpc('join', { password, name: 'Guest' }, '')).data;
    assert.ok(owner.token); assert.ok(guest.token);
  });
  afterEach(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  it('enforces every file mutation and CRDT entrypoint, forbids self grants, and restores policy on restart', async () => {
    await rpc('write', { path: 'allowed.py', content: b64('a = 1'), expectedRevision: 0 });
    await rpc('write', { path: 'blocked.py', content: b64('b = 2'), expectedRevision: 1 });
    const notebook = b64(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'cell', cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [], execution_count: null }] }));
    await rpc('write', { path: 'blocked.ipynb', content: notebook, expectedRevision: 2 });
    const permissions = { ...defaultPermissions(), edit: 'selected', paths: ['allowed.py'], execute: false, comment: false, terminal: 'none' };
    assert.equal((await rpc('permissions', { memberId: guest.memberId, permissions })).status, 200);
    assert.equal((await rpc('permissions', { memberId: guest.memberId, permissions: defaultPermissions() }, guest.token)).status, 403);
    for (const operation of ['write', 'mkdir', 'remove', 'rename', 'commitUpload', 'uploadChunk']) {
      assert.equal((await rpc(operation, { path: 'blocked.py', newPath: 'allowed.py', content: b64('bad'), expectedRevision: 3 }, guest.token)).status, 403, operation);
    }
    const text = (await rpc('textSync', { path: 'blocked.py' }, guest.token)).data;
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(text.update, 'base64')); doc.getText('content').insert(0, 'bad');
    assert.equal((await rpc('textSync', { path: 'blocked.py', epoch: text.epoch, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }, guest.token)).status, 403); doc.destroy();
    const synced = (await rpc('notebookSync', { path: 'blocked.ipynb' }, guest.token)).data;
    const nb = new Y.Doc(); Y.applyUpdate(nb, Buffer.from(synced.update, 'base64')); (nb.getMap<Y.Map<unknown>>('cells').get('cell')!.get('source') as Y.Text).insert(0, 'bad');
    assert.equal((await rpc('notebookSync', { path: 'blocked.ipynb', epoch: synced.epoch, update: Buffer.from(Y.encodeStateAsUpdate(nb)).toString('base64') }, guest.token)).status, 403); nb.destroy();
    for (const operation of ['execute', 'kernel', 'kernelControl', 'select']) assert.equal((await rpc(operation, {}, guest.token)).status, 403, operation);
    assert.equal((await rpc('write', { path: 'allowed.py', content: b64('a = 3'), expectedRevision: (await rpc('snapshot')).data.revision }, guest.token)).status, 200);
    assert.equal((await rpc('addComment', { comment: { path: 'allowed.py', startLine: 0, endLine: 0, text: 'Denied', color: '#FFB74D' } }, guest.token)).status, 403);
    await server.stop(); server = new VpsServer(options()); endpoint = `http://127.0.0.1:${await server.start()}`;
    assert.deepEqual((await rpc('view', {}, guest.token)).data.members.find((member: any) => member.id === guest.memberId).permissions, permissions);
    assert.equal((await rpc('write', { path: 'blocked.py', content: b64('bad'), expectedRevision: 4 }, guest.token)).status, 403);
  });
  it('persists colored notebook anchors, filters private comments, and limits removal to author or owner', async () => {
    const notebook = b64(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'cell', cell_type: 'code', source: 'first\nsecond', metadata: {}, outputs: [], execution_count: null }] }));
    await rpc('write', { path: 'work.ipynb', content: notebook, expectedRevision: 0 });
    const state = (await rpc('notebookSync', { path: 'work.ipynb' })).data;
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state.update, 'base64')); const text = doc.getMap<Y.Map<unknown>>('cells').get('cell')!.get('source') as Y.Text;
    const comment = { path: 'work.ipynb', cellId: 'cell', epoch: state.epoch, startLine: 1, endLine: 1, startAnchor: encodeRelativeOffset(text, 6), endAnchor: encodeRelativeOffset(text, 12), text: 'Review this', color: '#FFB74D', authorId: 'spoof' };
    assert.equal((await rpc('addComment', { comment }, guest.token)).status, 200); doc.destroy();
    const saved = (await rpc('comments')).data.comments[0]; assert.equal(saved.authorId, guest.memberId); assert.equal(saved.color, '#FFB74D'); assert.equal(saved.startAnchor, comment.startAnchor);
    const other = (await rpc('join', { password, name: 'Other' }, '')).data;
    assert.equal((await rpc('removeComment', { commentId: saved.id }, other.token)).status, 403);
    assert.equal((await rpc('visibility', { path: 'work.ipynb', visibility: 'private', expectedRevision: (await rpc('snapshot')).data.revision })).status, 200);
    assert.deepEqual((await rpc('comments', {}, guest.token)).data.comments, []);
    await server.stop(); server = new VpsServer(options()); endpoint = `http://127.0.0.1:${await server.start()}`;
    assert.equal((await rpc('comments')).data.comments[0].text, 'Review this');
    assert.equal((await rpc('removeComment', { commentId: saved.id })).status, 200);
    assert.deepEqual((await rpc('comments')).data.comments, []);
  });
  it('anchors ordinary text comments to the exact persisted replica and moves them with new lines', async () => {
    await rpc('write', { path: 'main.py', content: b64('first\nsecond'), expectedRevision: 0 });
    const state = (await rpc('textSync', { path: 'main.py' })).data;
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state.update, 'base64')); const text = doc.getText('content');
    const comment = { path: 'main.py', epoch: state.epoch, startLine: 1, endLine: 1, startAnchor: encodeRelativeOffset(text, 6), endAnchor: encodeRelativeOffset(text, 12), text: 'Check second', color: '#81C784' };
    assert.equal((await rpc('addComment', { comment }, guest.token)).status, 200);
    text.insert(0, 'new\n');
    assert.equal((await rpc('textSync', { path: 'main.py', epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }, guest.token)).status, 200);
    const saved = (await rpc('comments', {}, guest.token)).data.comments[0];
    assert.equal(resolveRelativeOffset(text, saved.startAnchor, undefined), 10);
    await rpc('write', { path: 'main.py', content: b64('replaced'), expectedRevision: (await rpc('snapshot')).data.revision });
    assert.equal((await rpc('addComment', { comment }, guest.token)).status, 409);
    doc.destroy();
  });
});
