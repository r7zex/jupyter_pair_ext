import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateIdentityCredentials } from '../src/core/identity';
import {
  ProjectManifestV1,
  captureProjectManifest,
  classifyProjectDrift,
  refreshWorkingCopyFromStableSource,
  stableCopyProject,
} from '../src/core/projectBaseline';
import { copyProject } from '../src/core/projectFiles';
import {
  acquireRuntimeOwner,
  readRuntimeOwner,
} from '../src/core/runtimeOwner';
import {
  assertExactSessionWorkspace,
  classifyLaunchRecovery,
  createSessionLaunchControl,
  persistPendingLaunchArtifacts,
  readLaunchBaseline,
  readVerifiedLaunchArtifacts,
  sessionControlPaths,
  sha256,
  verifySessionLaunchControl,
} from '../src/core/sessionControl';
import {
  credentialsMatchPublicIdentity,
  decodeExactSessionCredentials,
  encodeSessionCredentials,
} from '../src/core/sessionCredentials';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('durable session launch control', () => {
  it('requires exact v2 per-peer credentials and verifies the private/public identity', () => {
    const identity = generateIdentityCredentials();
    const other = generateIdentityCredentials();
    const encoded = encodeSessionCredentials('t'.repeat(32), identity.privateKey);
    const decoded = decodeExactSessionCredentials(encoded);
    assert.ok(decoded);
    assert.equal(credentialsMatchPublicIdentity(decoded, identity.publicKey), true);
    assert.equal(credentialsMatchPublicIdentity(decoded, other.publicKey), false);
    assert.equal(decodeExactSessionCredentials(JSON.stringify({
      version: 1,
      token: 't'.repeat(32),
      identityPrivateKey: identity.privateKey,
    })), undefined, 'automatic pending restore must not accept legacy credentials');
  });

  it('authenticates every identity/path field and fails closed after tampering', () => {
    const identity = generateIdentityCredentials();
    const control = createSessionLaunchControl({
      generation: 1,
      launchId: 'launch-1',
      kind: 'start',
      state: 'pending',
      sessionId: 'session-1',
      projectId: 'project-1',
      peerId: 'peer-1',
      role: 'host',
      workingFolderRealPath: path.resolve('session-workspace'),
      backingFolderRealPath: path.resolve('source-workspace'),
      markerSha256: DIGEST_A,
      baselineSha256: DIGEST_B,
      createdAt: 1,
    }, identity.privateKey);
    assert.deepEqual(verifySessionLaunchControl(control, identity.privateKey), control);
    assert.throws(
      () => verifySessionLaunchControl({ ...control, peerId: 'peer-2' }, identity.privateKey),
      /authentication failed/i,
    );
    assert.throws(
      () => verifySessionLaunchControl(control, generateIdentityCredentials().privateKey),
      /authentication failed/i,
    );
  });

  it('classifies every H0/H1 crash boundary deterministically', () => {
    const identity = generateIdentityCredentials();
    const common = {
      generation: 1,
      launchId: 'launch-1',
      kind: 'start' as const,
      sessionId: 'session-1',
      projectId: 'project-1',
      peerId: 'peer-1',
      role: 'host' as const,
      workingFolderRealPath: path.resolve('session-workspace'),
      baselineSha256: DIGEST_B,
      createdAt: 1,
    };
    const pending = createSessionLaunchControl({
      ...common,
      state: 'pending',
      markerSha256: DIGEST_A,
    }, identity.privateKey);
    const committing = createSessionLaunchControl({
      ...common,
      state: 'committing',
      markerSha256: DIGEST_A,
      nextMarkerSha256: DIGEST_B,
    }, identity.privateKey);
    const established = createSessionLaunchControl({
      ...common,
      state: 'established',
      markerSha256: DIGEST_B,
    }, identity.privateKey);
    assert.equal(classifyLaunchRecovery(pending, DIGEST_A), 'resume-pending');
    assert.equal(classifyLaunchRecovery(committing, DIGEST_A), 'resume-pending');
    assert.equal(classifyLaunchRecovery(committing, DIGEST_B), 'resume-committing');
    assert.equal(classifyLaunchRecovery(established, DIGEST_B), 'established');
    assert.equal(classifyLaunchRecovery(pending, DIGEST_B), 'integrity-error');
    assert.equal(classifyLaunchRecovery(established, DIGEST_A), 'integrity-error');
  });

  it('rejects a copied workspace even when its marker bytes could match', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-control-path-'));
    const paths = sessionControlPaths(root, 'session-1', 'peer-1');
    const copied = path.join(root, 'copied-workspace');
    try {
      await Promise.all([
        mkdir(paths.workspace, { recursive: true }),
        mkdir(copied, { recursive: true }),
      ]);
      const expectedRealPath = await assertExactSessionWorkspace(paths.workspace, paths.workspace, paths.workspace);
      assert.ok(path.isAbsolute(expectedRealPath));
      await assert.rejects(
        assertExactSessionWorkspace(copied, paths.workspace, expectedRealPath),
        /not the physical workspace/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists all recovery artifacts before accepting an exact pending workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-control-artifacts-'));
    const identity = generateIdentityCredentials();
    const paths = sessionControlPaths(root, 'session-1', 'peer-1');
    try {
      await mkdir(paths.workspace, { recursive: true });
      await writeFile(path.join(paths.workspace, 'value.txt'), 'value');
      const baseline = { version: 1 as const, working: await captureProjectManifest(paths.workspace) };
      const descriptor = {
        sessionId: 'session-1', projectId: 'project-1', projectName: 'Project', mode: 'resilient' as const,
        role: 'peer' as const,
        localPeer: { peerId: 'peer-1', displayName: 'Peer', joinOrder: 1, identityKey: identity.publicKey },
        hostPeerId: 'host-1', backingFolder: '', workingFolder: paths.workspace,
        createdAt: 1, sessionEpoch: 1, hostEpoch: 0, computeExecutorId: 'host-1', pythonPath: 'python',
        freshStart: true,
        knownPeers: [{ peerId: 'host-1', displayName: 'Host', joinOrder: 0, identityKey: identity.publicKey }],
      };
      const created = await persistPendingLaunchArtifacts(
        root, descriptor, baseline, 'launch-1', 'join', identity.privateKey,
      );
      assert.equal(created.recovery, 'resume-pending');
      const verified = await readVerifiedLaunchArtifacts(root, paths.workspace, descriptor, identity.privateKey);
      assert.equal(verified.control.sessionId, descriptor.sessionId);
      assert.equal(verified.recovery, 'resume-pending');
      assert.deepEqual(verified.baseline, baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects authenticated baseline manifests containing non-portable paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-control-baseline-'));
    const target = path.join(root, 'baseline.json');
    try {
      const bytes = `${JSON.stringify({
        version: 1,
        working: {
          version: 1,
          files: [{ relativePath: '../escape.txt', kind: 'text', size: 1, hash: DIGEST_A }],
          directories: [],
        },
      })}\n`;
      await writeFile(target, bytes);
      await assert.rejects(readLaunchBaseline(target, sha256(bytes)), /unsupported schema/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runtime participant ownership', () => {
  it('never steals a live owner merely because its timestamp is old', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-owner-live-'));
    const ownerPath = path.join(root, 'runtime-owner.json');
    try {
      const first = await acquireRuntimeOwner(ownerPath, 'launch-1', { pid: 101, now: () => 1 });
      await assert.rejects(
        acquireRuntimeOwner(ownerPath, 'launch-1', {
          pid: 202,
          now: () => 86_400_001,
          probeProcess: () => 'alive',
        }),
        /already owned by live process 101/i,
      );
      assert.equal((await readRuntimeOwner(ownerPath)).ownerNonce, first.record.ownerNonce);
      await first.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers only after the previous process is definitely dead', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-owner-dead-'));
    const ownerPath = path.join(root, 'runtime-owner.json');
    try {
      const first = await acquireRuntimeOwner(ownerPath, 'launch-1', { pid: 101 });
      const second = await acquireRuntimeOwner(ownerPath, 'launch-1', {
        pid: 202,
        probeProcess: () => 'dead',
      });
      assert.equal((await readRuntimeOwner(ownerPath)).ownerNonce, second.record.ownerNonce);
      await assert.rejects(first.release(), /refusing to release another process owner/i);
      await second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stable project snapshot and delayed-source classification', () => {
  it('retries a source mutation and publishes only a content-consistent copy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-stable-copy-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'session', 'workspace');
    let copies = 0;
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, 'value.txt'), 'before');
      const result = await stableCopyProject(source, destination, {
        copy: async (from, to) => {
          copies += 1;
          await copyProject(from, to);
          if (copies === 1) await writeFile(path.join(source, 'value.txt'), 'after');
        },
      });
      assert.equal(result.attempts, 2);
      assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'after');
      assert.deepEqual(result.baseline.working, result.baseline.source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an inconsistent copy instead of publishing a mixed destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-stable-refuse-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'session', 'workspace');
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, 'value.txt'), 'before');
      await assert.rejects(stableCopyProject(source, destination, {
        maxAttempts: 1,
        copy: async (from, to) => {
          await copyProject(from, to);
          await writeFile(path.join(source, 'value.txt'), 'after');
        },
      }), /source project changed/i);
      await assert.rejects(readFile(path.join(destination, 'value.txt')), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes source-only, working-only, identical, and divergent changes', () => {
    const manifest = (hash: string): ProjectManifestV1 => ({
      version: 1,
      files: [{ relativePath: 'value.txt', kind: 'text', size: 1, hash }],
      directories: [],
    });
    const baseline = manifest(DIGEST_A);
    const changed = manifest(DIGEST_B);
    const divergent = manifest('c'.repeat(64));
    assert.equal(classifyProjectDrift(baseline, baseline, baseline), 'unchanged');
    assert.equal(classifyProjectDrift(baseline, baseline, changed), 'source-only');
    assert.equal(classifyProjectDrift(baseline, changed, baseline), 'working-only');
    assert.equal(classifyProjectDrift(baseline, changed, changed), 'identical-change');
    assert.equal(classifyProjectDrift(baseline, changed, divergent), 'conflict');
  });

  it('refreshes a source-only change through a verified staging copy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-source-refresh-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'session', 'workspace');
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, 'value.txt'), 'before');
      const initial = await stableCopyProject(source, destination);
      await writeFile(path.join(source, 'value.txt'), 'after');
      await writeFile(path.join(source, 'added.txt'), 'new');
      const refreshed = await refreshWorkingCopyFromStableSource(
        source,
        destination,
        initial.baseline.working,
        path.join(root, 'recovery'),
      );
      assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'after');
      assert.equal(await readFile(path.join(destination, 'added.txt'), 'utf8'), 'new');
      assert.deepEqual(refreshed.manifest, await captureProjectManifest(source));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
