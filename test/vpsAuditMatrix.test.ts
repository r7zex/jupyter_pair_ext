import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { after, before, describe, it } from 'mocha';
import { normalizeVpsUrl, validateSubmission, type JobSubmission } from '../src/vps/protocol';
import { VpsServer } from '../src/vps/server';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { RedundantFrameRelay } from '../src/runtime/redundantFrameRelay';
import { type FrameRelay } from '../src/runtime/frameRelay';
import { encodeFrame } from '../src/core/wire';
import { deriveRelayFrameKey, encryptRelayPacket } from '../src/runtime/relayCrypto';

/** Adversarial cases, not a claim that 2047 distinct defects exist or a popularity ranking. */
function submission(index: number): JobSubmission {
  return { id: `audit-${index}`, agentId: 'training-pc', title: 'Training', device: 'cpu', entrypoint: 'train.py',
    files: { 'train.py': `print(${index})`, 'pkg/helper.py': 'VALUE = 1' }, args: [] };
}

function post(port: number, token: string, route: string, body: unknown): Promise<number> {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': bytes.length, 'content-type': 'application/json' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
    });
    request.on('error', reject); request.end(bytes);
  });
}

describe('Stage 1024 — source schema and portable path corruption combinations', () => {
  for (let mask = 0; mask < 1024; mask++) {
    it(`case ${mask.toString().padStart(4, '0')}: rejects every selected corruption`, () => {
      const input: any = submission(mask);
      if (mask & 1) input.id = ['job'];
      if (mask & 2) input.agentId = ['training-pc'];
      if (mask & 4) input.title = '\u202eTraining';
      if (mask & 8) input.device = ['cpu'];
      if (mask & 16) { input.entrypoint = 'COM¹.py'; input.files['COM¹.py'] = 'print(1)'; }
      if (mask & 32) input.files['pkg/helper.py/child.py'] = 'print(1)';
      if (mask & 64) input.args = ['argument\0injection'];
      if (mask & 128) input.files['pkg/helper.py'] = ['not source text'];
      if (mask & 256) input.files['../outside.py'] = 'print(1)';
      if (mask & 512) { input.files['pkg/héllo.py'] = ''; input.files['pkg/he\u0301llo.py'] = ''; }
      if (mask === 0) assert.equal(validateSubmission(input).id, input.id);
      else assert.throws(() => validateSubmission(input), 'A malformed/ambiguous snapshot must not be accepted');
    });
  }
});

class FakeSocket extends EventEmitter {
  public readyState = WebSocket.OPEN;
  public bufferedAmount = 0;
  public sent: string[] = [];
  public send(bytes: string): void { this.sent.push(bytes); }
  public terminate(): void { this.emit('close'); }
}

describe('Stage 128 — encrypted relay corruption and late-event combinations', () => {
  for (let mask = 0; mask < 128; mask++) {
    it(`case ${mask}: only valid authenticated frames reach the mesh`, () => {
      const socket = new FakeSocket();
      const options = { sessionId: 'audit', token: 'invitation-secret', localPeerId: 'local',
        vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) }, socketFactory: () => socket as unknown as WebSocket };
      const relay = new VpsFrameRelay(options);
      let received = 0;
      relay.onFrame = (peer, bytes) => { assert.equal(peer, 'remote'); assert.equal(bytes.toString(), 'shared source'); received++; };
      try {
        relay.start(); socket.emit('open'); socket.emit('message', socket.sent[0]);
        assert.equal(relay.connectedRelayCount, 1);
        const key = deriveRelayFrameKey(mask & 8 ? 'another-invitation' : options.token, options.sessionId);
        const frame = encodeFrame(mask & 16 ? 'unexpected' : 'vpsData', { f: 'remote' }, Buffer.from('shared source'));
        const packet = { t: 'data', f: mask & 1 ? 'different-peer' : mask & 32 ? '../remote' : 'remote',
          ...(mask & 2 ? { to: 'another-recipient' } : {}), d: mask & 4 ? 'corrupted!' : encryptRelayPacket(key, frame).toString('base64') };
        if (mask & 64) { relay.stop(); socket.emit('open'); socket.emit('message', socket.sent[0]); }
        socket.emit('message', JSON.stringify(packet));
        assert.equal(received, mask === 0 ? 1 : 0);
        if (mask & 64) assert.equal(relay.connectedRelayCount, 0, 'Late probes cannot revive a stopped relay');
      } finally { relay.stop(); }
    });
  }
});

describe('Stage 16 — transport failure, duplicate delivery and stop combinations', () => {
  for (let mask = 0; mask < 16; mask++) {
    it(`case ${mask}: a remaining relay carries a frame exactly once`, async () => {
      const channels = Array.from({ length: 3 }, (_, index): FrameRelay => ({
        connectedRelayCount: mask & (1 << index) ? 0 : 1,
        onFrame: () => undefined, onPeerAnnounce: () => undefined,
        start: () => { if (mask & (1 << index)) throw new Error('channel unavailable'); }, stop: () => undefined,
        sendAnnounce: () => undefined,
        waitUntilReady: async () => { if (mask & (1 << index)) throw new Error('channel unavailable'); },
        send(bytes) { if (mask & (1 << index)) throw new Error('channel unavailable'); this.onFrame('remote', bytes); },
      }));
      const relay = new RedundantFrameRelay({ channels, sessionId: 'audit', token: 'invite', localPeerId: 'local' });
      let count = 0; relay.onFrame = () => { count++; };
      try {
        relay.start();
        if ((mask & 7) === 7) await assert.rejects(relay.waitUntilReady()); else await relay.waitUntilReady();
        if (mask & 8) relay.stop();
        if ((mask & 7) === 7 || (mask & 8)) assert.throws(() => relay.send(Buffer.from('same frame')));
        else { relay.send(Buffer.from('same frame')); relay.send(Buffer.from('same frame')); }
        assert.equal(count, (mask & 7) === 7 || (mask & 8) ? 0 : 1);
        relay.stop(); channels[0]!.onFrame('late-peer', Buffer.from('late frame'));
        assert.equal(count, (mask & 7) === 7 || (mask & 8) ? 0 : 1);
      } finally { relay.stop(); }
    });
  }
});

describe('Stage 8 — endpoint ambiguity combinations', () => {
  for (let mask = 0; mask < 8; mask++) {
    it(`case ${mask}: credentials and URL delimiters cannot change API routes`, () => {
      const endpoint = `https://${mask & 4 ? 'user:password@' : ''}compute.example/vps${mask & 1 ? '?' : ''}${mask & 2 ? '#' : ''}`;
      if (mask) assert.throws(() => normalizeVpsUrl(endpoint));
      else assert.equal(normalizeVpsUrl(endpoint), endpoint);
    });
  }
});

describe('Stage 512 — compute registration corruption combinations', () => {
  let server: VpsServer;
  let root: string;
  let port: number;
  const clientToken = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-audit-registration-'));
    server = new VpsServer({ dataDirectory: root, clientToken, agentTokens: { pc: agentToken } });
    port = await server.start();
  });
  after(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  for (let mask = 0; mask < 512; mask++) {
    it(`case ${mask.toString().padStart(3, '0')}: malformed compute inventories have a definite rejection`, async () => {
      const gpu = { index: 0, name: 'Training GPU', memoryMb: 8192, uuid: 'GPU-01234567-89ab-cdef-0123-456789abcdef' };
      const body: any = { instanceId: 'installation', name: 'Training PC', resources: { cpuCount: 16, python: 'python3', gpus: [gpu] } };
      if (mask & 1) body.instanceId = ['installation'];
      if (mask & 2) body.name = 'Training\nPC';
      if (mask & 4) body.resources.cpuCount = '16';
      if (mask & 8) body.resources.python = ['python3'];
      if (mask & 16) body.resources.gpus[0].index = 0.5;
      if (mask & 32) body.resources.gpus[0].name = '\u202eGPU';
      if (mask & 64) body.resources.gpus[0].memoryMb = '8192';
      if (mask & 128) body.resources.gpus[0].uuid = ['GPU-01234567-89ab-cdef-0123-456789abcdef'];
      if (mask & 256) body.resources.gpus.push({ ...body.resources.gpus[0] });
      const status = await post(port, agentToken, '/v1/agents/pc/poll', body);
      assert.equal(status, mask === 0 ? 200 : 400);
    });
  }
});

describe('Stage 256 — job-report authorization and state mutation combinations', () => {
  let server: VpsServer;
  let root: string;
  let port: number;
  const clientToken = randomBytes(32).toString('hex');
  const agentTokens = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`pc-${index}`, randomBytes(32).toString('hex')]));
  agentTokens.other = randomBytes(32).toString('hex');
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-audit-reports-'));
    server = new VpsServer({ dataDirectory: root, clientToken, agentTokens });
    port = await server.start();
  });
  after(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  for (let mask = 0; mask < 256; mask++) {
    it(`case ${mask.toString().padStart(3, '0')}: report validation cannot mutate a different job`, async () => {
      const id = `pc-${mask}`;
      const input = { ...submission(mask), agentId: id };
      assert.equal(await post(port, clientToken, '/v1/jobs', input), 200);
      assert.equal(await post(port, agentTokens[id]!, `/v1/agents/${id}/poll`, {
        instanceId: 'installation', name: id, resources: { cpuCount: 1, python: 'python3', gpus: [] },
      }), 200);
      const body: any = { instanceId: 'installation', jobId: input.id, offset: 0, log: '', result: { status: 'succeeded', exitCode: 0 } };
      const routeId = mask & 2 ? 'other' : id;
      const token = mask & 1 ? clientToken : agentTokens[routeId]!;
      if (mask & 4) body.jobId = `unknown-${mask}`;
      if (mask & 8) body.instanceId = 'another-installation';
      if (mask & 16) body.offset = 0.5;
      if (mask & 32) body.log = '!!!!';
      if (mask & 64) body.result.status = 'queued';
      if (mask & 128) body.result.exitCode = 1;
      const expected = mask & 1 ? 401 : mask & 14 ? 403 : mask & 48 ? 409 : mask & 192 ? 400 : 200;
      assert.equal(await post(port, token, `/v1/agents/${routeId}/report`, body), expected);
    });
  }
});
