import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionCoordinator } from '../src/core/election';
import { generateIdentityCredentials } from '../src/core/identity';
import { StorageAdapter } from '../src/core/persistence';
import { HostClock, PeerIdentity, PeerRuntime } from '../src/core/types';
import { WireFrame } from '../src/core/wire';
import { SnapshotBootstrapError, downloadProjectSnapshot } from '../src/runtime/bootstrap';
import { MeshTransport, TrysteroRoomFactory } from '../src/runtime/mesh';
import {
  abandonInMemoryTrystero,
  createInMemoryTrysteroFactory,
  resetInMemoryTrystero,
} from './support/in_memory_trystero';

function peer(peerId: string, joinOrder: number, lastHeartbeat: number, online = true): PeerRuntime {
  return {
    peerId,
    displayName: peerId,
    joinOrder,
    latency: 1,
    latencyEma: 1,
    lastHeartbeat,
    missedHeartbeats: 0,
    route: 'Direct',
    online,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function snapshotMeta(frame: WireFrame, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const snapshotId = String(frame.meta.snapshotId ?? '');
  assert.match(snapshotId, /^[A-Za-z0-9_-]{1,64}$/);
  return { snapshotId, ...meta };
}

describe('audit regressions', () => {
  describe('release workflow credentials', () => {
    it('pins external actions and isolates release write permission', async () => {
      const workflowPath = path.resolve(__dirname, '../../.github/workflows/release.yml');
      const workflow = await readFile(workflowPath, 'utf8');
      const actionRefs = [...workflow.matchAll(/uses:\s+(actions\/[A-Za-z0-9_-]+)@([^\s#]+)/g)];

      for (const [, action, reference] of actionRefs) {
        assert.match(reference ?? '', /^[a-f0-9]{40}$/, `${action} must use an immutable full SHA`);
      }
      assert.deepEqual(new Set(actionRefs.map(([, action]) => action)), new Set([
        'actions/checkout',
        'actions/setup-node',
        'actions/setup-python',
        'actions/upload-artifact',
        'actions/download-artifact',
      ]));
      assert.doesNotMatch(workflow, /uses:\s+actions\/[A-Za-z0-9_-]+@v\d/);
      assert.match(workflow, /uses:\s+actions\/checkout@[a-f0-9]{40}[^]*?persist-credentials:\s+false/);
      assert.equal((workflow.match(/GH_TOKEN:/g) ?? []).length, 1);

      const verifyJob = workflow.match(/^ {2}verify:[^]*?(?=^ {2}publish:)/m)?.[0] ?? '';
      const publishJob = workflow.match(/^ {2}publish:[^]*/m)?.[0] ?? '';
      assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read$/m);
      assert.match(verifyJob, /permissions:\s*\n\s+contents:\s+read/);
      assert.doesNotMatch(verifyJob, /contents:\s+write/);
      assert.match(publishJob, /needs:\s+verify/);
      assert.match(publishJob, /permissions:[^]*?contents:\s+write/);
      assert.equal((workflow.match(/contents:\s+write/g) ?? []).length, 1);
    });

    it('builds only a verified remote tag and never clobbers release assets', async () => {
      const workflowPath = path.resolve(__dirname, '../../.github/workflows/release.yml');
      const workflow = await readFile(workflowPath, 'utf8');
      const releaseNotesScript = await readFile(
        path.resolve(__dirname, '../../scripts/create-release-notes.mjs'),
        'utf8',
      );
      const verifyJob = workflow.match(/^ {2}verify:[^]*?(?=^ {2}publish:)/m)?.[0] ?? '';
      const publishJob = workflow.match(/^ {2}publish:[^]*/m)?.[0] ?? '';

      assert.match(verifyJob, /ref:\s+refs\/tags\/\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
      assert.match(verifyJob, /git fetch --force --no-tags origin/);
      assert.match(verifyJob, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
      assert.match(verifyJob, /HEAD_COMMIT[^]*TAG_COMMIT[^]*REMOTE_TAG_COMMIT/);
      assert.match(verifyJob, /"\$\{HEAD_COMMIT\}" != "\$\{TAG_COMMIT\}"/);
      assert.match(verifyJob, /"\$\{TAG_COMMIT\}" != "\$\{REMOTE_TAG_COMMIT\}"/);
      assert.ok(
        verifyJob.indexOf('Verify immutable remote tag checkout') < verifyJob.indexOf('run: npm ci'),
        'tag identity must be verified before dependency installation',
      );

      assert.match(verifyJob, /release-notes\.md/);
      assert.match(publishJob, /uses:\s+actions\/download-artifact@[a-f0-9]{40}/);
      assert.match(publishJob, /GH_REPO:\s+\$\{\{ github\.repository \}\}/);
      assert.match(publishJob, /VERIFIED_COMMIT:\s+\$\{\{ needs\.verify\.outputs\.verified_commit \}\}/);
      assert.match(publishJob, /"\$\{REMOTE_TAG_COMMIT\}" != "\$\{VERIFIED_COMMIT\}"/);
      assert.match(publishJob, /ASSETS=\("\$\{VERSIONED_VSIX\}"\)/);
      assert.doesNotMatch(publishJob, /pair-notebook\.vsix|SOURCE_ZIP:|SHA256SUMS\.txt/);
      assert.match(releaseNotesScript, /const vsixName = `pair-notebook-\$\{version\}\.vsix`/);
      assert.doesNotMatch(releaseNotesScript, /pair-notebook\.vsix|pair-notebook-complete|SHA256SUMS/);
      assert.doesNotMatch(workflow, /--clobber/);
      const compareIndex = publishJob.indexOf('cmp --silent');
      const editIndex = publishJob.indexOf('gh release edit');
      const uploadIndex = publishJob.indexOf('gh release upload');
      assert.ok(compareIndex >= 0 && compareIndex < editIndex && compareIndex < uploadIndex);
    });

    it('preflights package sources and rejects credential paths in every archive layout', async () => {
      const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const packageScript = manifest.scripts?.package ?? '';
      assert.match(packageScript, /make-artifacts\.mjs --preflight-only.*vsce package/);
      const vscodeIgnore = await readFile(path.resolve(__dirname, '../../.vscodeignore'), 'utf8');
      assert.match(vscodeIgnore, /^\*\*\/\.env\.!\(example\|sample\|template\)$/m);
      assert.doesNotMatch(vscodeIgnore, /^\*\*\/\.env\.\*$/m);

      const policyPath = path.resolve(__dirname, '../../scripts/sensitive-path-policy.cjs');
      const policy = await import(policyPath) as { isSensitiveArtifactPath(relativePath: string): boolean };
      for (const credentialPath of [
        '.envrc', '.pgpass', 'postgresql/pgpass.conf', '.my.cnf', '.mylogin.cnf', '.authinfo',
        '.cargo/credentials', '.cargo/credentials.toml', '.config/gh/hosts.yml',
        'AppData/Roaming/GitHub CLI/hosts.yml', 'extension/.CARGO/CREDENTIALS.TOML',
        'pair-notebook/.CONFIG/GH/HOSTS.YML', 'extension/.CARGO\\CREDENTIALS.TOML',
      ]) {
        assert.equal(policy.isSensitiveArtifactPath(credentialPath), true, credentialPath);
      }
      for (const safePath of [
        '.envrc.example', '.pgpass.example', '.my.cnf.example', '.authinfo.example',
        '.cargo/config.toml', 'config/credentials.toml', '.config/gh/config.yml',
        '.config/editor/hosts.yml',
      ]) {
        assert.equal(policy.isSensitiveArtifactPath(safePath), false, safePath);
      }
    });
  });

  describe('host election stability', () => {
    it('does not steal the host role after a local event-loop stall', () => {
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const coordinator = new SessionCoordinator({
        selfId: 'self',
        mode: 'resilient',
        clock,
        heartbeatTimeoutMs: 1000,
      });
      const start = 100_000;
      coordinator.upsertPeer(peer('host', 0, start));
      coordinator.upsertPeer(peer('self', 1, start));

      assert.equal(coordinator.evaluate(start + 500), undefined);
      assert.equal(coordinator.evaluate(start + 60_000), undefined, 'a stall must not trigger a failover');

      coordinator.markHeartbeat('host', start + 60_100);
      coordinator.markHeartbeat('self', start + 60_100);
      assert.equal(coordinator.evaluate(start + 60_500), undefined);
      assert.equal(coordinator.clock.hostId, 'host');
      assert.equal(coordinator.clock.hostEpoch, 1);
    });

    it('closes the guest without self-promotion when the host connection is really lost', () => {
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const coordinator = new SessionCoordinator({
        selfId: 'self',
        mode: 'resilient',
        clock,
        heartbeatTimeoutMs: 1000,
      });
      const start = 200_000;
      coordinator.upsertPeer(peer('host', 0, start));
      coordinator.upsertPeer(peer('self', 1, start));
      coordinator.evaluate(start);
      coordinator.markDisconnected('host');
      coordinator.markHeartbeat('self', start + 900);
      const next = coordinator.evaluate(start + 1200);
      assert.equal(next, undefined);
      assert.equal(coordinator.closed, true);
      assert.equal(coordinator.clock.hostId, 'host');
      assert.equal(coordinator.clock.hostEpoch, 1);
    });

    it('closes after a sustained heartbeat loss without a connection close', () => {
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const coordinator = new SessionCoordinator({
        selfId: 'self',
        mode: 'resilient',
        clock,
        heartbeatTimeoutMs: 1000,
      });
      const start = 300_000;
      coordinator.upsertPeer(peer('host', 0, start));
      coordinator.upsertPeer(peer('self', 1, start));
      coordinator.evaluate(start);
      coordinator.markHeartbeat('self', start + 800);
      assert.equal(coordinator.evaluate(start + 1500), undefined);
      coordinator.markHeartbeat('self', start + 2000);
      const next = coordinator.evaluate(start + 2600);
      assert.equal(next, undefined);
      assert.equal(coordinator.closed, true);
      assert.equal(coordinator.clock.hostId, 'host');
    });
  });

  describe('storage adapter failure handling', () => {
    it('reports a debounced flush failure instead of crashing the extension host', async () => {
      const workingRoot = await temporaryDirectory('pn-audit-flush-');
      try {
        const adapter = new StorageAdapter({
          workingRoot,
          debounceMs: 5,
          serialize: async () => {
            throw new Error('serialization exploded');
          },
        });
        const failure = await new Promise<Error>((resolve) => {
          adapter.once('operationError', resolve);
          adapter.schedule('notebook.ipynb');
        });
        assert.match(failure.message, /serialization exploded/);
        await adapter.stop(false);
      } finally {
        await rm(workingRoot, { recursive: true, force: true });
      }
    });

    it('completes shutdown even when the final flush fails', async () => {
      const workingRoot = await temporaryDirectory('pn-audit-stop-');
      try {
        let fail = true;
        const adapter = new StorageAdapter({
          workingRoot,
          debounceMs: 10_000,
          serialize: async () => {
            if (fail) throw new Error('final save failed');
            return new Uint8Array();
          },
        });
        adapter.on('operationError', () => undefined);
        adapter.schedule('a.txt');
        await assert.rejects(adapter.stop(true), /final save failed/);
        assert.equal(adapter.pendingCount(), 0);
        fail = false;
        adapter.schedule('b.txt');
        assert.equal(adapter.pendingCount(), 0, 'a stopped adapter must not accept new work');
      } finally {
        await rm(workingRoot, { recursive: true, force: true });
      }
    });

    it('keeps the working copy intact when a write fails mid-session', async () => {
      const workingRoot = await temporaryDirectory('pn-audit-atomic-');
      try {
        const target = path.join(workingRoot, 'keep.txt');
        await writeFile(target, 'original');
        const adapter = new StorageAdapter({
          workingRoot,
          debounceMs: 1,
          serialize: async () => {
            throw new Error('nope');
          },
        });
        adapter.on('operationError', () => undefined);
        adapter.schedule('keep.txt');
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await readFile(target, 'utf8'), 'original');
        await adapter.stop(false);
      } finally {
        await rm(workingRoot, { recursive: true, force: true });
      }
    });
  });

  describe('Trystero connection identity', () => {
    const sessionId = 'session-audit';
    const token = 'token-audit-that-is-long-enough-123456';

    function identity(peerId: string): PeerIdentity {
      return { peerId, displayName: peerId, joinOrder: 0 };
    }

    it('refuses a second connection claiming the identity of a live peer', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const host = transport(identity('host'), true, roomFactory, clock, sessionId, token);
      const clientIdentity = identity('client');
      const client = transport(clientIdentity, false, roomFactory, clock, sessionId, token);
      const impostor = transport({ ...clientIdentity, displayName: 'Impostor' }, false, roomFactory, clock, sessionId, token);
      const errors: Error[] = [];
      host.on('connectionError', (_peer, error: Error) => errors.push(error));
      try {
        await host.start();
        const connected = onceEvent(host, 'peerConnected');
        await client.start();
        await connected;
        await impostor.start();
        await waitFor(() => errors.some((error) => /different identity key/i.test(error.message)), 1000);
        assert.equal(host.peerRuntime().find((entry) => entry.peerId === 'client')?.online, true);
        assert.equal(host.peerRuntime().filter((entry) => entry.peerId === 'client').length, 1);
      } finally {
        await Promise.all([impostor.stop(), client.stop(), host.stop()]);
        resetInMemoryTrystero();
      }
    });

    it('retires a zombie identity route when the genuine peer re-connects', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const host = transport(identity('host'), true, roomFactory, clock, sessionId, token);
      // Two transports sharing one identity key model the same participant
      // re-connecting after its previous route died without a leave event.
      const credentials = generateIdentityCredentials();
      const makeClient = (): MeshTransport => new MeshTransport({
        sessionId,
        token,
        localPeer: {
          peerId: 'client', displayName: 'Client', joinOrder: 1, identityKey: credentials.publicKey,
        },
        hostClock: () => clock,
        isHost: () => false,
        roomFactory,
        identityPrivateKey: credentials.privateKey,
      });
      const zombie = makeClient();
      let reconnected: MeshTransport | undefined;
      try {
        await host.start();
        const connected = onceEvent(host, 'peerConnected');
        await zombie.start();
        await connected;
        // The first transport vanishes without its leave event ever firing.
        abandonInMemoryTrystero('test-peer-2');
        const rejoined = onceEvent(host, 'peerConnected');
        reconnected = makeClient();
        await reconnected.start();
        await rejoined;
        assert.equal(host.peerRuntime().find((entry) => entry.peerId === 'client')?.online, true);
        assert.equal(host.peerRuntime().filter((entry) => entry.peerId === 'client').length, 1);
      } finally {
        const stops: Array<Promise<void>> = [zombie.stop(), host.stop()];
        if (reconnected) stops.push(reconnected.stop());
        await Promise.all(stops);
        resetInMemoryTrystero();
      }
    });

    it('refuses an invite holder impersonating a known offline peer', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const host = transport(identity('host'), true, roomFactory, clock, sessionId, token, 25);
      const clientIdentity = identity('client');
      const client = transport(clientIdentity, false, roomFactory, clock, sessionId, token);
      const errors: Error[] = [];
      host.on('connectionError', (_peer, error: Error) => errors.push(error));
      let impostor: MeshTransport | undefined;
      try {
        await host.start();
        const connected = onceEvent(host, 'peerConnected');
        await client.start();
        await connected;
        await client.stop();
        await waitFor(() => !host.peerRuntime().some((entry) => entry.peerId === 'client' && entry.online), 1000);

        impostor = transport({ ...clientIdentity, displayName: 'Impostor' }, false, roomFactory, clock, sessionId, token);
        await impostor.start();
        await waitFor(() => errors.some((error) => /different identity key/i.test(error.message)), 1000);
        assert.equal(host.peerRuntime().some((entry) => entry.peerId === 'client' && entry.online), false);
      } finally {
        await Promise.all([impostor?.stop(), client.stop(), host.stop()]);
        resetInMemoryTrystero();
      }
    });

    it('rejects a handshake that announces our own application peer id', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const hostIdentity = identity('host');
      const host = transport(hostIdentity, true, roomFactory, clock, sessionId, token);
      const attacker = transport({ ...hostIdentity, displayName: 'Attacker' }, false, roomFactory, clock, sessionId, token);
      const errors: Error[] = [];
      host.on('connectionError', (_peer, error: Error) => errors.push(error));
      try {
        await host.start();
        await attacker.start();
        await waitFor(() => errors.some((error) => /own application identity/i.test(error.message)), 1000);
        assert.equal(host.peerRuntime().filter((entry) => entry.peerId === 'host').length, 1);
      } finally {
        await Promise.all([attacker.stop(), host.stop()]);
        resetInMemoryTrystero();
      }
    });

    it('rejects a case-insensitive display-name conflict without evicting the connected peer', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 1, hostId: 'host' };
      const hostIdentity = { ...identity('host'), displayName: 'Host' };
      const host = transport(hostIdentity, true, roomFactory, clock, sessionId, token);
      const client = transport({ ...identity('client'), displayName: 'Alice' }, false, roomFactory, clock, sessionId, token);
      const duplicate = transport(
        { ...identity('other-client'), displayName: '  aLiCe  ' },
        false,
        roomFactory,
        clock,
        sessionId,
        token,
      );
      const errors: Error[] = [];
      host.on('connectionError', (_peer, error: Error) => errors.push(error));
      try {
        await host.start();
        const connected = onceEvent(host, 'peerConnected');
        await client.start();
        await connected;
        await duplicate.start();
        await waitFor(() => errors.some((error) => /display name.*already.*use/i.test(error.message)), 1000);
        assert.equal(host.peerRuntime().find((entry) => entry.peerId === 'client')?.online, true);
        assert.equal(host.peerRuntime().some((entry) => entry.peerId === 'other-client'), false);
        assert.throws(() => host.updateLocalPeer({ ...hostIdentity, displayName: '  ALICE  ' }), /already used/i);
        assert.equal(hostIdentity.displayName, 'Host');
        assert.throws(() => host.updateLocalPeer({ ...hostIdentity, displayName: 'bad\u0000name' }), /invalid local display name/i);
      } finally {
        await Promise.all([duplicate.stop(), client.stop(), host.stop()]);
        resetInMemoryTrystero();
      }
    });
  });

  describe('snapshot bootstrap diagnostics', () => {
    it('processes chunked manifests with receiver-side checkpoints', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-chunked-manifest-token';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'chunked-snapshot',
        token,
      );
      const acknowledgements: string[] = [];
      host.on('message', (frame, sourceId) => {
        if (frame.type === 'snapshotRequest') {
          host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
            totalFiles: 0, fileCount: 0, completedFiles: 0, directoryCount: 2,
          }));
          host.sendTo(sourceId, 'snapshotManifest', snapshotMeta(frame, {
            expectedFiles: [], expectedDirectories: ['empty'], completedFiles: [],
          }));
          host.sendTo(sourceId, 'snapshotCheckpoint', snapshotMeta(frame, { checkpointId: 'checkpoint-one' }));
          host.sendTo(sourceId, 'snapshotManifest', snapshotMeta(frame, {
            expectedFiles: [], expectedDirectories: ['empty/nested'], completedFiles: [],
          }));
          host.sendTo(sourceId, 'snapshotManifestEnd', snapshotMeta(frame));
          host.sendTo(sourceId, 'snapshotCheckpoint', snapshotMeta(frame, { checkpointId: 'checkpoint-two' }));
          return;
        }
        if (frame.type !== 'snapshotCheckpointAck') return;
        const checkpointId = String(frame.meta.checkpointId);
        acknowledgements.push(checkpointId);
        if (checkpointId === 'checkpoint-two') host.sendTo(sourceId, 'snapshotEnd', snapshotMeta(frame));
      });
      const destination = await temporaryDirectory('pair-bootstrap-chunked-');
      try {
        await host.start();
        await downloadProjectSnapshot({
          sessionId: 'chunked-snapshot', projectId: 'project', projectName: 'Chunked', mode: 'resilient',
          token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
        }, {
          peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
        }, destination, undefined, roomFactory);
        assert.deepEqual(acknowledgements, ['checkpoint-one', 'checkpoint-two']);
        assert.equal((await stat(path.join(destination, 'empty', 'nested'))).isDirectory(), true);
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('retransmits missing snapshot chunks over a lossy link instead of failing the join', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-retransmit-token-that-is-long-enough';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'retransmit-snapshot',
        token,
      );
      const chunkSize = 64 * 1024;
      const fileBytes = Buffer.alloc(chunkSize + 4096);
      for (let index = 0; index < fileBytes.byteLength; index += 1) fileBytes[index] = index % 251;
      const fileHash = createHash('sha256').update(fileBytes).digest('hex');
      const retryRequests: number[][] = [];
      host.on('message', (frame, sourceId) => {
        if (frame.type === 'snapshotRequest') {
          host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
            expectedFiles: ['notes.bin'], expectedDirectories: [], totalFiles: 1, fileCount: 1,
          }));
          host.sendTo(sourceId, 'snapshotFileStart', snapshotMeta(frame, {
            transferId: 'transfer-one', relativePath: 'notes.bin',
            size: fileBytes.byteLength, chunks: 2, chunkSize, hash: fileHash,
          }));
          // Simulate the lossy relay route: the second chunk frame is silently
          // dropped while the end frame still arrives.
          host.sendTo(sourceId, 'snapshotFileChunk', snapshotMeta(frame, { transferId: 'transfer-one', index: 0 }), fileBytes.subarray(0, chunkSize));
          host.sendTo(sourceId, 'snapshotFileEnd', snapshotMeta(frame, { transferId: 'transfer-one' }));
          return;
        }
        if (frame.type === 'snapshotFileRetry') {
          assert.equal(String(frame.meta.transferId), 'transfer-one');
          const indices = [...(frame.meta.indices as number[])];
          retryRequests.push(indices);
          host.sendTo(sourceId, 'snapshotFileChunk', snapshotMeta(frame, { transferId: 'transfer-one', index: 1 }), fileBytes.subarray(chunkSize));
          host.sendTo(sourceId, 'snapshotFileEnd', snapshotMeta(frame, { transferId: 'transfer-one' }));
          host.sendTo(sourceId, 'snapshotEnd', snapshotMeta(frame));
          return;
        }
      });
      const destination = await temporaryDirectory('pair-bootstrap-retransmit-');
      try {
        await host.start();
        await downloadProjectSnapshot({
          sessionId: 'retransmit-snapshot', projectId: 'project', projectName: 'Retransmit', mode: 'resilient',
          token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
        }, {
          peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
        }, destination, undefined, roomFactory);
        assert.deepEqual(retryRequests, [[1]]);
        assert.deepEqual(await readFile(path.join(destination, 'notes.bin')), fileBytes);
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('removes stale files, directories, and symlinks after a complete snapshot', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-clean-destination-token';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'clean-snapshot',
        token,
      );
      host.on('message', (frame, sourceId) => {
        if (frame.type !== 'snapshotRequest') return;
        host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
          expectedFiles: [], expectedDirectories: [], totalFiles: 0, fileCount: 0,
        }));
        host.sendTo(sourceId, 'snapshotEnd', snapshotMeta(frame));
      });
      const root = await temporaryDirectory('pair-bootstrap-clean-');
      const destination = path.join(root, 'destination');
      const outside = path.join(root, 'outside');
      await Promise.all([
        mkdir(path.join(destination, 'stale-directory'), { recursive: true }),
        mkdir(outside, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(destination, 'stale.txt'), 'stale'),
        writeFile(path.join(destination, 'stale-directory', 'nested.txt'), 'stale'),
        writeFile(path.join(outside, 'keep.txt'), 'outside'),
      ]);
      await symlink(outside, path.join(destination, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
      try {
        await host.start();
        await downloadProjectSnapshot({
          sessionId: 'clean-snapshot', projectId: 'project', projectName: 'Clean', mode: 'resilient',
          token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
        }, {
          peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
        }, destination, undefined, roomFactory);
        await assert.rejects(stat(path.join(destination, 'stale.txt')));
        await assert.rejects(stat(path.join(destination, 'stale-directory')));
        await assert.rejects(stat(path.join(destination, 'outside-link')));
        assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects Unicode normalization collisions split across snapshot manifest chunks', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-cross-chunk-conflict-token';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'cross-chunk-conflict',
        token,
      );
      host.on('message', (frame, sourceId) => {
        if (frame.type !== 'snapshotRequest') return;
        host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
          totalFiles: 2, fileCount: 2, completedFiles: 0, directoryCount: 0,
        }));
        host.sendTo(sourceId, 'snapshotManifest', snapshotMeta(frame, {
          expectedFiles: ['Caf\u00e9.txt'], expectedDirectories: [], completedFiles: [],
        }));
        host.sendTo(sourceId, 'snapshotManifest', snapshotMeta(frame, {
          expectedFiles: ['Cafe\u0301.txt'], expectedDirectories: [], completedFiles: [],
        }));
      });
      const destination = await temporaryDirectory('pair-bootstrap-cross-conflict-');
      try {
        await host.start();
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'cross-chunk-conflict', projectId: 'project', projectName: 'Conflict', mode: 'resilient',
            token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
          }, {
            peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
          }, destination, undefined, roomFactory),
          /duplicate or case-conflicting paths/i,
        );
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('surfaces an explicit host snapshot failure without waiting for the idle timeout', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-explicit-error-token-long-enough';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'failed-snapshot',
        token,
      );
      host.on('message', (frame, sourceId) => {
        if (frame.type === 'snapshotRequest') {
          host.sendTo(sourceId, 'snapshotError', snapshotMeta(frame, { reason: 'host-snapshot-failed' }));
        }
      });
      const destination = await temporaryDirectory('pair-bootstrap-host-error-');
      try {
        await host.start();
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'failed-snapshot', projectId: 'project', projectName: 'Failed', mode: 'resilient',
            token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
          }, {
            peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
          }, destination, undefined, roomFactory),
          /could not prepare a safe project snapshot/i,
        );
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('rejects case-colliding and structurally ambiguous snapshot manifests', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-conflicting-manifest-token';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'conflicting-snapshot',
        token,
      );
      host.on('message', (frame, sourceId) => {
        if (frame.type !== 'snapshotRequest') return;
        host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
          expectedFiles: ['Report.txt', 'report.txt'], expectedDirectories: [], totalFiles: 2, fileCount: 2,
        }));
      });
      const destination = await temporaryDirectory('pair-bootstrap-conflicting-');
      try {
        await host.start();
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'conflicting-snapshot', projectId: 'project', projectName: 'Conflicting', mode: 'resilient',
            token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
          }, {
            peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
          }, destination, undefined, roomFactory),
          /duplicate or case-conflicting paths/i,
        );
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('rejects an incomplete snapshot instead of publishing a partial project', async function () {
      this.timeout(10_000);
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-incomplete-token-that-is-long-enough';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'incomplete-snapshot',
        token,
      );
      host.on('message', (frame, sourceId) => {
        if (frame.type !== 'snapshotRequest') return;
        host.sendTo(sourceId, 'snapshotBegin', snapshotMeta(frame, {
          expectedFiles: ['missing.txt'], expectedDirectories: [], totalFiles: 1, fileCount: 1,
        }));
        host.sendTo(sourceId, 'snapshotEnd', snapshotMeta(frame));
      });
      const destination = await temporaryDirectory('pair-bootstrap-incomplete-');
      try {
        await host.start();
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'incomplete-snapshot', projectId: 'project', projectName: 'Incomplete', mode: 'resilient',
            token, sessionEpoch: 1, hostPeerId: 'host', hostDisplayName: 'Host',
          }, {
            peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1,
          }, destination, undefined, roomFactory),
          /before every declared file/i,
        );
        await assert.rejects(readFile(path.join(destination, 'missing.txt')));
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('surfaces a display-name conflict without retrying the snapshot', async () => {
      const roomFactory = createInMemoryTrysteroFactory();
      const token = 'bootstrap-conflict-token-that-is-long-enough';
      const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
      const host = transport(
        { peerId: 'host', displayName: 'Alice', joinOrder: 0 },
        true,
        roomFactory,
        clock,
        'nickname-conflict',
        token,
      );
      let conflicts = 0;
      host.on('connectionError', (_peer, error: Error) => {
        if (/display name.*already.*use/i.test(error.message)) conflicts += 1;
      });
      await host.start();
      const destination = await temporaryDirectory('pair-bootstrap-conflict-');
      try {
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'nickname-conflict',
            projectId: 'project',
            projectName: 'Conflict project',
            mode: 'resilient',
            token,
            sessionEpoch: 1,
            hostPeerId: 'host',
            hostDisplayName: 'Alice',
          }, {
            peerId: 'joining-peer',
            displayName: ' alice ',
            joinOrder: 1,
          }, destination, undefined, roomFactory),
          (error: unknown) => {
            assert.ok(error instanceof SnapshotBootstrapError);
            assert.equal(error.kind, 'display-name-conflict');
            assert.match(error.message, /another nickname/i);
            return true;
          },
        );
        assert.equal(conflicts, 1);
      } finally {
        await host.stop();
        resetInMemoryTrystero();
        await rm(destination, { recursive: true, force: true });
      }
    });

    it('turns Trystero startup failure into one actionable connection error', async () => {
      let attempts = 0;
      const failingFactory: TrysteroRoomFactory = () => {
        attempts += 1;
        throw new Error('Nostr relay unavailable');
      };
      const destination = await temporaryDirectory('pair-bootstrap-error-');
      try {
        await assert.rejects(
          downloadProjectSnapshot({
            sessionId: 'unavailable-room',
            projectId: 'project',
            projectName: 'Unavailable project',
            mode: 'resilient',
            token: 'bootstrap-token-that-is-long-enough',
            sessionEpoch: 1,
            hostPeerId: 'host',
            hostDisplayName: 'Host',
          }, {
            peerId: 'joining-peer',
            displayName: 'Joining Peer',
            joinOrder: 1,
          }, destination, undefined, failingFactory),
          (error: unknown) => {
            assert.ok(error instanceof SnapshotBootstrapError);
            assert.equal(error.kind, 'connection-failed');
            assert.match(error.message, /Trystero/i);
            assert.match(error.message, /host is online|internet access|invite is current/i);
            return true;
          },
        );
        assert.equal(attempts, 1);
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    });
  });
});

function transport(
  localPeer: PeerIdentity,
  isHost: boolean,
  roomFactory: TrysteroRoomFactory,
  clock: HostClock,
  sessionId: string,
  token: string,
  logicalPeerRecoveryMs?: number,
): MeshTransport {
  return new MeshTransport({
    sessionId,
    token,
    localPeer,
    hostClock: () => clock,
    isHost: () => isHost,
    roomFactory,
    ...(logicalPeerRecoveryMs === undefined ? {} : { logicalPeerRecoveryMs }),
  });
}

function onceEvent(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for audit condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
