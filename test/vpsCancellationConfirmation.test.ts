import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { VpsServer, type VpsServerOptions } from '../src/vps/server';
import { VpsClient, VpsHttpError } from '../src/vps/client';
import { CANCELLATION_CONFIRMATION_MS, type CancellationChallenge, type ComputeScope, type JobSubmission, terminalJob } from '../src/vps/protocol';

function post(endpoint: string, token: string, route: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = http.request(endpoint + route, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': bytes.length,
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.end(bytes);
  });
}

describe('VPS scoped cancellation confirmation and durable intent', function () {
  this.timeout(15_000);
  let directory: string;
  let server: VpsServer;
  let options: VpsServerOptions;
  let endpoint: string;
  let client: VpsClient;
  const team = randomBytes(32).toString('hex');
  const agent = randomBytes(32).toString('hex');
  const member = randomBytes(32).toString('hex');
  const otherOperator = randomBytes(32).toString('hex');
  const viewer = randomBytes(32).toString('hex');
  const scope: ComputeScope = { projectId: 'fraud-project', sessionId: 'session-one' };
  const inventory = { instanceId: 'installation', name: 'PC', resources: { cpuCount: 2, python: 'python3', gpus: [] } };
  const input = (id: string, selectedScope: ComputeScope | undefined = scope): JobSubmission => ({
    id, agentId: 'pc', title: 'Synthetic fraud training', device: 'cpu', entrypoint: 'train.py',
    files: { 'train.py': 'print("training")' }, args: [], ...(selectedScope ?? {}),
  });
  const challenge = (id: string): Promise<CancellationChallenge> => client.requestCancellation({ action: 'cancel_job', scope, targetIds: [id] });
  const poll = (): Promise<{ status: number; data: any }> => post(endpoint, agent, '/v1/agents/pc/poll', inventory);
  const complete = (id: string, status = 'succeeded', exitCode = 0) => post(endpoint, agent, '/v1/agents/pc/report', {
    instanceId: inventory.instanceId, jobId: id, offset: 0, log: '', result: { status, exitCode },
  });
  const restart = async (): Promise<void> => {
    await server.stop(); server = new VpsServer(options);
    endpoint = `http://127.0.0.1:${await server.start()}`; client = new VpsClient(endpoint, team);
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-confirmation-test-'));
    options = { dataDirectory: directory, clientToken: team, agentTokens: { pc: agent }, clientPrincipals: {
      trainer: { token: member, role: 'member', projectIds: [scope.projectId] },
      operator: { token: otherOperator, role: 'operator', projectIds: [scope.projectId] },
      observer: { token: viewer, role: 'viewer' },
    } };
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    client = new VpsClient(endpoint, team);
  });
  afterEach(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });

  it('creates a frozen challenge without stopping or mutating the run', async () => {
    const submitted = await client.submit(input('metadata')); await poll();
    const confirmation = await challenge('metadata');
    assert.equal(confirmation.action, 'cancel_job'); assert.deepEqual(confirmation.scope, scope);
    assert.deepEqual(confirmation.targetIds, ['metadata']); assert.equal(confirmation.targets[0]!.createdAt, submitted.createdAt);
    assert.equal(confirmation.targets[0]!.title, input('metadata').title);
    assert.equal(confirmation.identity, 'team-operator'); assert.equal(confirmation.requiredPermission, 'cancel_any');
    assert.equal(confirmation.expiresAt - confirmation.createdAt, CANCELLATION_CONFIRMATION_MS);
    assert.equal((confirmation as unknown as Record<string, unknown>).principalGeneration, undefined);
    assert.equal((await client.job('metadata')).cancelRequested, false);
  });

  it('rejects legacy cancellation, booleans and every inexact confirmation', async () => {
    await client.submit(input('exact'));
    for (const body of [{}, { confirmed: true }, { text: 'CONFIRM' }]) {
      assert.equal((await post(endpoint, team, '/v1/jobs/exact/cancel', body)).status, 403);
    }
    const confirmation = await challenge('exact');
    for (const text of ['', 'confirm', 'Confirm', 'CONFIRM ', ' CONFIRM', 'CONFIRM\n', 'CONFIRM!', true]) {
      assert.equal((await post(endpoint, team, `/v1/confirmations/${confirmation.id}/apply`, { text })).status, 403);
      assert.equal((await client.job('exact')).cancelRequested, false);
    }
    assert.equal((await client.applyCancellation(confirmation.id, 'CONFIRM')).jobs[0]!.status, 'cancelled');
  });

  it('checks authenticated identity, ownership, operator role and project rights', async () => {
    await client.submit(input('owned-by-team'));
    const request = { action: 'cancel_job', scope, targetIds: ['owned-by-team'] };
    assert.equal((await post(endpoint, agent, '/v1/confirmations', request)).status, 401);
    assert.equal((await post(endpoint, viewer, '/v1/confirmations', request)).status, 403);
    assert.equal((await post(endpoint, member, '/v1/confirmations', request)).status, 403);
    assert.equal((await post(endpoint, member, '/v1/confirmations', { action: 'stop_session', scope })).status, 403);
    const memberClient = new VpsClient(endpoint, member);
    await memberClient.submit(input('member-owned'));
    const own = await memberClient.requestCancellation({ action: 'cancel_job', scope, targetIds: ['member-owned'] });
    assert.equal(own.identity, 'trainer'); assert.equal(own.requiredPermission, 'cancel_own');
    assert.equal((await post(endpoint, team, `/v1/confirmations/${own.id}/apply`, { text: 'CONFIRM' })).status, 403);
    assert.equal((await memberClient.applyCancellation(own.id, 'CONFIRM')).jobs[0]!.status, 'cancelled');
    assert.equal((await post(endpoint, otherOperator, '/v1/confirmations', {
      action: 'stop_session', scope: { ...scope, projectId: 'other-project' },
    })).status, 403);
  });

  it('rejects scope substitution, caller-selected session targets and action overrides', async () => {
    await client.submit(input('bound')); await client.submit(input('other'));
    assert.equal((await post(endpoint, team, '/v1/confirmations', {
      action: 'cancel_job', scope: { ...scope, sessionId: 'other-session' }, targetIds: ['bound'],
    })).status, 409);
    assert.equal((await post(endpoint, team, '/v1/confirmations', { action: 'stop_session', scope, targetIds: ['bound'] })).status, 400);
    assert.equal((await post(endpoint, team, '/v1/confirmations', { action: 'cancel_job', scope, targetIds: ['bound'], identity: 'trainer' })).status, 400);
    const confirmation = await challenge('bound');
    assert.equal((await post(endpoint, team, '/v1/jobs/other/cancel', { confirmationId: confirmation.id, text: 'CONFIRM' })).status, 409);
    assert.equal((await post(endpoint, team, `/v1/confirmations/${confirmation.id}/apply`, { text: 'CONFIRM', action: 'stop_session' })).status, 403);
    assert.equal((await client.job('other')).cancelRequested, false);
  });

  it('isolates project reads and prevents a member from adopting another submitter job ID', async () => {
    await client.submit(input('allowed-project'));
    await client.submit(input('hidden-project', { projectId: 'private-project', sessionId: scope.sessionId }));
    const memberClient = new VpsClient(endpoint, member);
    assert.deepEqual((await memberClient.jobs()).map((job) => job.id), ['allowed-project']);
    await assert.rejects(memberClient.job('hidden-project'), (error: unknown) => error instanceof VpsHttpError && error.status === 403);
    await assert.rejects(memberClient.submit(input('allowed-project')), (error: unknown) => error instanceof VpsHttpError && error.status === 403);
    await assert.rejects(memberClient.submit(input('hidden-project', { projectId: 'private-project', sessionId: scope.sessionId })),
      (error: unknown) => error instanceof VpsHttpError && error.status === 403);
  });

  it('expires consent and invalidates unconfirmed dialogs on broker restart', async () => {
    await client.submit(input('expired')); const confirmation = await challenge('expired');
    const now = Date.now;
    try {
      Date.now = () => confirmation.expiresAt;
      assert.equal((await post(endpoint, team, `/v1/confirmations/${confirmation.id}/apply`, { text: 'CONFIRM' })).status, 409);
    } finally { Date.now = now; }
    const current = await challenge('expired'); await restart();
    await assert.rejects(client.applyCancellation(current.id, 'CONFIRM'), (error: unknown) => error instanceof VpsHttpError && error.status === 409);
    assert.equal((await client.job('expired')).cancelRequested, false);
  });

  it('refuses a finished target and cannot stop its replacement run', async () => {
    await client.submit(input('old')); await poll(); const old = await challenge('old');
    assert.equal((await complete('old')).status, 200); await client.submit(input('new')); await poll();
    assert.equal((await post(endpoint, team, `/v1/confirmations/${old.id}/apply`, { text: 'CONFIRM' })).status, 409);
    assert.equal((await client.job('new')).status, 'running'); assert.equal((await client.job('new')).cancelRequested, false);
  });

  it('rejects a session target list changed while the dialog was open', async () => {
    await client.submit(input('initial'));
    const confirmation = await client.requestCancellation({ action: 'stop_session', scope });
    await client.submit(input('late'));
    assert.equal((await post(endpoint, team, `/v1/confirmations/${confirmation.id}/apply`, { text: 'CONFIRM' })).status, 409);
    assert.equal((await client.job('initial')).cancelRequested, false); assert.equal((await client.job('late')).cancelRequested, false);
    assert.equal((await client.submit(input('still-admitted'))).status, 'queued');
  });

  it('keeps offline cancellation pending across restart until the owning agent reports stopped', async () => {
    await client.submit(input('offline')); await poll(); const confirmation = await challenge('offline');
    const result = await client.applyCancellation(confirmation.id, 'CONFIRM');
    assert.equal(result.jobs[0]!.status, 'cancel_pending'); assert.equal(terminalJob('cancel_pending'), false);
    assert.equal(result.jobs[0]!.finishedAt, undefined); await restart();
    assert.equal((await client.job('offline')).status, 'cancel_pending');
    assert.equal((await poll()).data.job.cancelRequested, true);
    assert.equal((await complete('offline', 'cancelled', -1)).status, 200);
    assert.equal((await client.job('offline')).status, 'cancelled');
    assert.deepEqual(await client.applyCancellation(confirmation.id, 'CONFIRM'), result);
  });

  it('applies consent once and replays its durable receipt without touching newer jobs', async () => {
    await client.submit(input('queued')); const confirmation = await challenge('queued');
    const result = await client.applyCancellation(confirmation.id, 'CONFIRM');
    assert.equal(result.jobs[0]!.status, 'cancelled');
    await client.submit(input('newer'));
    assert.deepEqual(await client.applyCancellation(confirmation.id, 'CONFIRM'), result);
    await restart(); assert.deepEqual(await client.applyCancellation(confirmation.id, 'CONFIRM'), result);
    assert.equal((await client.job('newer')).cancelRequested, false);
  });

  it('stops exactly one project/session and persistently closes only its launch admission', async () => {
    await client.submit(input('running')); await poll(); await client.submit(input('queued'));
    const otherSession = { ...scope, sessionId: 'other-session' };
    const otherProject = { ...scope, projectId: 'other-project' };
    await client.submit(input('other-session', otherSession)); await client.submit(input('other-project', otherProject));
    const confirmation = await client.requestCancellation({ action: 'stop_session', scope });
    assert.deepEqual(confirmation.targetIds, ['running', 'queued']);
    const result = await client.applyCancellation(confirmation.id, 'CONFIRM');
    assert.deepEqual(result.jobs.map((job) => job.status), ['cancel_pending', 'cancelled']);
    assert.equal((await client.job('other-session')).cancelRequested, false);
    assert.equal((await client.job('other-project')).cancelRequested, false);
    await assert.rejects(client.submit(input('blocked')), (error: unknown) => error instanceof VpsHttpError && error.status === 409);
    assert.equal((await client.submit(input('allowed', otherSession))).status, 'queued');
    await restart();
    await assert.rejects(client.submit(input('blocked-after-restart')), (error: unknown) => error instanceof VpsHttpError && error.status === 409);
    assert.deepEqual(await client.applyCancellation(confirmation.id, 'CONFIRM'), result);
  });

  it('recovers a persisted authorized intent interrupted before its first job write', async () => {
    await client.submit(input('recover-intent'));
    const confirmation = await client.requestCancellation({ action: 'stop_session', scope });
    await server.stop();
    const ledger = path.join(directory, '.confirmations', 'operations.json');
    const records = JSON.parse(await readFile(ledger, 'utf8'));
    records[0].state = 'applying'; records[0].appliedAt = Date.now() - CANCELLATION_CONFIRMATION_MS;
    records[0].createdAt = Date.now() - 2 * CANCELLATION_CONFIRMATION_MS;
    records[0].expiresAt = records[0].createdAt + CANCELLATION_CONFIRMATION_MS;
    await writeFile(ledger, JSON.stringify(records));
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`; client = new VpsClient(endpoint, team);
    assert.equal((await client.job('recover-intent')).status, 'cancelled');
    assert.equal((await client.applyCancellation(confirmation.id, 'CONFIRM')).targetIds[0], 'recover-intent');
    await assert.rejects(client.submit(input('late-recovery')), (error: unknown) => error instanceof VpsHttpError && error.status === 409);
  });

  it('revokes replay permission after operator credential rotation while preserving confirmed session admission', async () => {
    await client.submit(input('rotated-operator'));
    const confirmation = await client.requestCancellation({ action: 'stop_session', scope });
    await client.applyCancellation(confirmation.id, 'CONFIRM');
    await server.stop(); options.clientToken = randomBytes(32).toString('hex');
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    client = new VpsClient(endpoint, options.clientToken);
    await assert.rejects(client.applyCancellation(confirmation.id, 'CONFIRM'), (error: unknown) => error instanceof VpsHttpError && error.status === 403);
    await assert.rejects(client.submit(input('rotated-blocked')), (error: unknown) => error instanceof VpsHttpError && error.status === 409);
    assert.equal((await client.job('rotated-operator')).status, 'cancelled');
  });

  it('fails closed when a recovery intent encounters a replaced generation under the same job ID', async () => {
    await client.submit(input('replaced-generation'));
    await challenge('replaced-generation'); await server.stop();
    const ledger = path.join(directory, '.confirmations', 'operations.json');
    const records = JSON.parse(await readFile(ledger, 'utf8'));
    records[0].state = 'applying'; records[0].appliedAt = Date.now();
    await writeFile(ledger, JSON.stringify(records));
    const jobFile = path.join(directory, 'replaced-generation.json');
    const job = JSON.parse(await readFile(jobFile, 'utf8')); job.createdAt += 1;
    await writeFile(jobFile, JSON.stringify(job));
    server = new VpsServer(options);
    await assert.rejects(server.start(), /Confirmed run identity changed/);
    assert.equal(JSON.parse(await readFile(jobFile, 'utf8')).cancelRequested, false);
  });

  it('requires the selected owner dataset identity before claiming a job', async () => {
    const dataset = { version: 'fraud-v1', sha256: 'a'.repeat(64), files: 2 };
    await client.submit(input('undeclared-data'));
    const declaredPoll = () => post(endpoint, agent, '/v1/agents/pc/poll', { ...inventory, resources: { ...inventory.resources, dataset } });
    assert.equal((await declaredPoll()).data.job, null);
    const failed = await client.job('undeclared-data'); assert.equal(failed.status, 'failed'); assert.match(failed.failureReason!, /dataset identity/);
    await client.submit({ ...input('matching-data'), dataset: { version: dataset.version, sha256: dataset.sha256 } });
    assert.equal((await declaredPoll()).data.job.id, 'matching-data');
  });
});
