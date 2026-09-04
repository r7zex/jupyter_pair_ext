import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import {
  CollaborativeProject,
  MAX_CELL_SOURCE_BYTES,
  MAX_CELL_OUTPUTS,
  MAX_NOTEBOOK_CELLS,
  MAX_TEXT_DOCUMENT_BYTES,
  NotebookSnapshot,
  ProjectUpdate,
  normalizeNotebookUpdateScope,
} from '../src/core/crdt';
import { SessionCoordinator } from '../src/core/election';
import { PerNotebookExecutionQueue } from '../src/core/executionQueue';
import {
  generateIdentityCredentials,
  newIdentityNonce,
  publicKeyFromPrivate,
  signIdentityTranscript,
  validateIdentityNonce,
  validateIdentityPrivateKey,
  validateIdentityPublicKey,
  verifyIdentityTranscript,
} from '../src/core/identity';
import { StableCellIdRegistry, matchInitialCellIds, minimalNotebookSplice } from '../src/core/notebookIdentity';
import { JupyterKernelEvent, PythonKernel, kernelLaunchSpec } from '../src/core/pythonKernel';
import {
  MAX_COLLABORATIVE_DOCUMENT_BYTES,
  classifyFile,
  copyProject,
  loadCrdtProject,
  parseIpynb,
  scanProject,
  serializeIpynb,
  shouldTrackProjectPath,
} from '../src/core/projectFiles';
import {
  accessibleRecentProjects,
  assertRecentReconnectMatchesDescriptor,
  clearRecentReconnect,
  forgetRecentProject,
  normalizeRecentProjects,
  reconnectIdentityFromDescriptor,
  rememberRecentProject,
} from '../src/core/recentProjects';
import {
  MAX_SESSION_TERMINATION_BYTES,
  readSessionTermination,
  writeSessionTermination,
} from '../src/core/sessionTermination';
import { StorageAdapter, safeRelativePath } from '../src/core/persistence';
import {
  HostClock,
  PeerIdentity,
  computeSelectionChanged,
  PeerRuntime,
  REMOTE_ORIGIN,
  cleanDisplayName,
  formatInvite,
  normalizeDisplayName,
  parseInvite,
  validateDisplayName,
  validateProjectName,
} from '../src/core/types';
import { decodeFrame, encodeFrame, MAX_WIRE_FRAME_BYTES, MAX_WIRE_HEADER_BYTES } from '../src/core/wire';
import {
  DUPLICATE_HANDSHAKE_WINDOW_MS,
  MeshTransport,
  TRYSTERO_RELAY_URLS,
  TRYSTERO_TURN_SERVERS,
} from '../src/runtime/mesh';
import { createInMemoryTrysteroFactory, resetInMemoryTrystero } from './support/in_memory_trystero';

const notebook: NotebookSnapshot = {
  metadata: { language_info: { name: 'python' } },
  cells: [
    { id: 'cell-a', kind: 2, language: 'python', source: 'x = 1', metadata: {}, outputs: [] },
    { id: 'cell-b', kind: 1, language: 'markdown', source: '# Notes', metadata: {}, outputs: [] },
  ],
};
const execFileAsync = promisify(execFile);
const TEST_IDENTITY_PUBLIC_KEY = generateIdentityCredentials().publicKey;

describe('canonical notebook cell text revision', () => {
  it('changes only with canonical cell text and gives a new stable cell a new revision lineage', () => {
    const project = new CollaborativeProject();
    try {
      project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{
          id: 'cell-a', kind: 2, language: 'python', source: 'same text',
          metadata: {}, outputs: [],
        }],
      });
      const before = project.cellTextState('work.ipynb', 'cell-a');
      const digestBefore = createHash('sha256').update(before.source, 'utf8').digest('hex');
      assert.match(before.revision, /^r1_[A-Za-z0-9_-]+$/, 'new cell starts an ordered revision lineage');

      project.setCellMetadata('work.ipynb', 'cell-a', { owner: 'remote' });
      project.setCellOutputs('work.ipynb', 'cell-a', [{
        metadata: { outputType: 'stream' },
        items: [{ mime: 'text/plain', dataBase64: Buffer.from('out').toString('base64') }],
      }]);
      project.setCellExecution('work.ipynb', 'cell-a', { executionOrder: 3, success: true });

      const afterNonText = project.cellTextState('work.ipynb', 'cell-a');
      const digestAfterNonText = createHash('sha256').update(afterNonText.source, 'utf8').digest('hex');
      assert.equal(afterNonText.revision, before.revision);
      assert.equal(digestAfterNonText, digestBefore);

      project.applyCellTextChanges('work.ipynb', 'cell-a', [{
        offset: 0, deleteCount: 4, insertText: 'DIFF',
      }]);
      const afterText = project.cellTextState('work.ipynb', 'cell-a');
      assert.notEqual(afterText.revision, before.revision);
      assert.match(afterText.revision, /^r2_[A-Za-z0-9_-]+$/, 'text edit advances the ordered revision');
      assert.notEqual(
        createHash('sha256').update(afterText.source, 'utf8').digest('hex'),
        digestBefore,
      );

      const snapshot = project.notebookSnapshot('work.ipynb');
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [
          ...snapshot.cells,
          {
            id: 'cell-b', kind: 2, language: 'python', source: afterText.source,
            metadata: {}, outputs: [],
          },
        ],
      });
      const newCell = project.cellTextState('work.ipynb', 'cell-b');
      assert.notEqual(newCell.revision, afterText.revision, 'new stable cell ID gets a new text revision lineage');
    } finally {
      project.destroy();
    }
  });
});

describe('cell execution request identity', () => {
  it('round-trips a bounded request ID and rejects malformed identities', () => {
    const project = new CollaborativeProject();
    try {
      project.ensureNotebook('exec-id.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: '1+1', metadata: {}, outputs: [] }],
      });
      project.setCellExecution('exec-id.ipynb', 'cell-a', {
        requestId: 'request_123',
        executionOrder: 4,
        success: true,
      });
      assert.deepEqual(project.notebookCellSnapshot('exec-id.ipynb', 'cell-a')?.execution, {
        requestId: 'request_123',
        executionOrder: 4,
        success: true,
      });
      assert.throws(
        () => project.setCellExecution('exec-id.ipynb', 'cell-a', { requestId: 'bad request id!' }),
        /request identity/i,
      );
    } finally {
      project.destroy();
    }
  });
});

describe('notebook update scopes', () => {
  it('normalizes all six semantic scopes and requires stable IDs for cell scopes', () => {
    assert.deepEqual(normalizeNotebookUpdateScope({ type: 'structure' }), { type: 'structure' });
    assert.deepEqual(normalizeNotebookUpdateScope({ type: 'notebookMetadata' }), { type: 'notebookMetadata' });
    for (const type of ['cellText', 'cellMetadata', 'cellOutputs', 'cellExecution'] as const) {
      assert.deepEqual(normalizeNotebookUpdateScope({ type, cellId: 'stable-cell' }), {
        type,
        cellId: 'stable-cell',
      });
      assert.equal(normalizeNotebookUpdateScope({ type }), undefined);
      assert.equal(normalizeNotebookUpdateScope({ type, cellId: 'invalid cell id!' }), undefined);
    }
    assert.equal(normalizeNotebookUpdateScope({ type: 'genericNotebookChanged' }), undefined);
  });
});

describe('participant display names', () => {
  it('cleans names and compares normalized case-insensitive forms', () => {
    assert.equal(validateDisplayName('  Alice  '), undefined);
    assert.equal(cleanDisplayName('  Alice  '), 'Alice');
    assert.equal(normalizeDisplayName('ＡLICE'), normalizeDisplayName('alice'));
    assert.equal(normalizeDisplayName('Straße'), normalizeDisplayName('STRASSE'));
  });

  it('rejects empty, overlong, and control-character display names', () => {
    assert.match(validateDisplayName('   ') ?? '', /required/i);
    assert.match(validateDisplayName('a'.repeat(65)) ?? '', /64/);
    assert.match(validateDisplayName('Alice\nAdmin') ?? '', /control/i);
    assert.match(validateDisplayName('Alice\u202eAdmin') ?? '', /control/i);
    assert.match(validateProjectName('Project\u2028Injected') ?? '', /control/i);
  });
});

describe('participant identity proofs', () => {
  it('round-trips canonical Ed25519 credentials and rejects transcript tampering', () => {
    const identity = generateIdentityCredentials();
    const transcript = Buffer.from('session-a\0host\0nonce-a\0peer\0nonce-b');
    const signature = signIdentityTranscript(identity.privateKey, transcript);

    assert.equal(validateIdentityPublicKey(identity.publicKey), undefined);
    assert.equal(validateIdentityPrivateKey(identity.privateKey), undefined);
    assert.equal(publicKeyFromPrivate(identity.privateKey), identity.publicKey);
    assert.equal(verifyIdentityTranscript(identity.publicKey, transcript, signature), true);
    assert.equal(verifyIdentityTranscript(identity.publicKey, Buffer.from(`${transcript.toString()}!`), signature), false);
    assert.match(validateIdentityPublicKey('not-a-key') ?? '', /identity key/i);
  });

  it('uses fixed-size canonical nonces', () => {
    const nonce = newIdentityNonce();
    assert.equal(validateIdentityNonce(nonce), true);
    assert.equal(validateIdentityNonce(`${nonce}=`), false);
    assert.equal(validateIdentityNonce(nonce.slice(1)), false);
  });
});

describe('compute selection comparison', () => {
  it('treats a Python environment change on the same executor/device as a compute change', () => {
    const current = { executorId: 'peer-a', device: 'cpu' as const, pythonPath: '/env/a/python' };
    assert.equal(computeSelectionChanged(current, { ...current, pythonPath: '/env/b/python' }), true);
    assert.equal(computeSelectionChanged(current, { ...current }), false);
  });
});

describe('project file classification', () => {
  it('shares safe project dotfiles while excluding common credential files', () => {
    assert.equal(classifyFile('.gitignore'), 'text');
    assert.equal(classifyFile('.gitattributes'), 'text');
    assert.equal(classifyFile('.dockerignore'), 'text');
    assert.equal(classifyFile('.editorconfig'), 'text');
    assert.equal(classifyFile('.env.example'), 'text');
    assert.equal(shouldTrackProjectPath('.env.example'), true);
    assert.equal(shouldTrackProjectPath('.env'), false);
    assert.equal(shouldTrackProjectPath('.env.local'), false);
    assert.equal(shouldTrackProjectPath('.npmrc'), false);
    for (const credentialPath of [
      '.envrc', '.pgpass', 'postgresql/pgpass.conf', '.my.cnf', '.mylogin.cnf', '.authinfo',
      '.cargo/credentials', '.cargo/credentials.toml', '.config/gh/hosts.yml',
      'AppData/Roaming/GitHub CLI/hosts.yml', 'HOME/.CARGO/CREDENTIALS.TOML',
      '.CONFIG/GH/HOSTS.YML', '.CARGO\\CREDENTIALS.TOML',
    ]) {
      assert.equal(shouldTrackProjectPath(credentialPath), false, credentialPath);
    }
    for (const safePath of [
      '.envrc.example', '.envrc.sample', '.envrc.template', '.pgpass.example',
      '.my.cnf.example', '.authinfo.example', '.cargo/config', '.cargo/config.toml',
      'config/credentials.toml', '.config/gh/config.yml', '.config/editor/hosts.yml',
      '.config/project/settings.yml',
    ]) {
      assert.equal(shouldTrackProjectPath(safePath), true, safePath);
    }
    assert.equal(shouldTrackProjectPath('.ssh/id_ed25519'), false);
    assert.equal(shouldTrackProjectPath('deploy/private.key'), false);
    assert.equal(shouldTrackProjectPath('.docker/config.json'), false);
    assert.equal(shouldTrackProjectPath('.kube/config'), false);
    assert.equal(shouldTrackProjectPath('.terraform/terraform.tfstate'), false);
    assert.equal(shouldTrackProjectPath('.pulumi/meta.yaml'), false);
    assert.equal(shouldTrackProjectPath('infra/prod.tfstate'), false);
    assert.equal(shouldTrackProjectPath('infra/prod.tfstate.backup'), false);
    assert.equal(shouldTrackProjectPath('infra/secrets.tfvars'), false);
    assert.equal(shouldTrackProjectPath('infra/secrets.tfvars.json'), false);
    assert.equal(shouldTrackProjectPath('vpn/friend.ovpn'), false);
    assert.equal(shouldTrackProjectPath('keys/legacy.ppk'), false);
    assert.equal(shouldTrackProjectPath('ios/team.mobileprovision'), false);
    assert.equal(shouldTrackProjectPath('config/application_default_credentials.json'), false);
    assert.equal(shouldTrackProjectPath('oauth/client_secret_desktop.apps.googleusercontent.com.json'), false);
    assert.equal(shouldTrackProjectPath('cluster/admin.kubeconfig'), false);
    assert.equal(shouldTrackProjectPath('docker-compose.yml'), true);
    assert.equal(shouldTrackProjectPath('infra/main.tf'), true);
    assert.equal(shouldTrackProjectPath('infra/terraform.lock.hcl'), true);
    assert.equal(shouldTrackProjectPath('infra/terraform.tfvars.example'), true);
    assert.equal(shouldTrackProjectPath('kubeconfig.example'), true);
    assert.equal(shouldTrackProjectPath('NODE_MODULES/package/index.js'), false);
    assert.equal(classifyFile('weights.bin'), 'binary');
    assert.equal(classifyFile('oversized.py', MAX_COLLABORATIVE_DOCUMENT_BYTES + 1), 'binary');
    assert.equal(classifyFile('oversized.ipynb', MAX_COLLABORATIVE_DOCUMENT_BYTES + 1), 'binary');
  });

  it('omits credential paths from scans and isolated copies without deleting the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-credential-filter-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'copy');
    try {
      await Promise.all([
        mkdir(path.join(source, '.cargo'), { recursive: true }),
        mkdir(path.join(source, '.config/gh'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(source, 'main.py'), 'print(1)', 'utf8'),
        writeFile(path.join(source, '.envrc'), 'export TOKEN=secret', 'utf8'),
        writeFile(path.join(source, '.cargo/credentials.toml'), '[registry]\ntoken="secret"', 'utf8'),
        writeFile(path.join(source, '.config/gh/hosts.yml'), 'oauth_token: secret', 'utf8'),
        writeFile(path.join(source, '.cargo/config.toml'), '[build]', 'utf8'),
      ]);

      assert.deepEqual((await scanProject(source)).map((file) => file.relativePath).sort(), [
        '.cargo/config.toml', 'main.py',
      ]);
      await copyProject(source, destination);
      assert.equal(await readFile(path.join(destination, '.cargo/config.toml'), 'utf8'), '[build]');
      await assert.rejects(readFile(path.join(destination, '.envrc')));
      await assert.rejects(readFile(path.join(destination, '.cargo/credentials.toml')));
      await assert.rejects(readFile(path.join(destination, '.config/gh/hosts.yml')));
      assert.equal(await readFile(path.join(source, '.envrc'), 'utf8'), 'export TOKEN=secret');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses project copies whose source and isolated destination overlap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-copy-overlap-'));
    try {
      await writeFile(path.join(root, 'project.py'), 'print(1)', 'utf8');
      await assert.rejects(copyProject(root, path.join(root, 'nested-working-copy')), /must not overlap/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves invalid UTF-8 and malformed notebooks as binary files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-binary-text-'));
    try {
      await writeFile(path.join(root, 'invalid.py'), Buffer.from([0xff, 0xfe, 0x61]));
      await writeFile(path.join(root, 'broken.ipynb'), '{not valid json', 'utf8');
      await writeFile(path.join(root, 'bom.py'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
      const files = await scanProject(root);
      const kinds = new Map(files.map((file) => [file.relativePath, file.kind]));
      assert.equal(kinds.get('invalid.py'), 'binary');
      assert.equal(kinds.get('broken.ipynb'), 'binary');
      assert.equal(kinds.get('bom.py'), 'text');

      const project = new CollaborativeProject();
      await loadCrdtProject(root, project);
      assert.equal(project.has('invalid.py'), false);
      assert.equal(project.has('broken.ipynb'), false);
      assert.equal(project.text('bom.py').toString(), '\ufeffa');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('authenticated session termination marker', () => {
  it('accepts a valid marker and refuses an oversized polling payload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-session-end-'));
    const descriptor = {
      sessionId: 'session-end-test', projectId: 'project-end-test', sessionEpoch: 1, backingFolder: root,
    };
    const token = 'session-end-token-that-is-long-enough';
    try {
      await writeSessionTermination(descriptor as any, token, {
        peerId: 'host-peer', displayName: 'Host', joinOrder: 0,
      });
      assert.equal((await readSessionTermination(descriptor, token))?.endedByPeerId, 'host-peer');
      await writeFile(
        path.join(root, '.pair-notebook-ended.json'),
        Buffer.alloc(MAX_SESSION_TERMINATION_BYTES + 1, 0x20),
      );
      assert.equal(await readSessionTermination(descriptor, token), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the isolated working copy when no host backing folder was selected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-session-end-working-'));
    const descriptor = {
      sessionId: 'session-end-working', projectId: 'project-end-working', sessionEpoch: 2,
      backingFolder: '', workingFolder: root,
    };
    const token = 'session-end-working-token-that-is-long-enough';
    try {
      await writeSessionTermination(descriptor as any, token, {
        peerId: 'new-host', displayName: 'New Host', joinOrder: 1,
      });
      const marker = await readSessionTermination(descriptor, token);
      assert.equal(marker?.endedByPeerId, 'new-host');
      assert.equal(marker?.sessionEpoch, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Pair Notebook CRDT', () => {
  it('merges simultaneous Y.Text insertions on two peers', () => {
    const [a, b] = pairedTextProjects('abc');
    const updatesA: Uint8Array[] = [];
    const updatesB: Uint8Array[] = [];
    a.on('update', (event: ProjectUpdate) => { if (event.origin !== REMOTE_ORIGIN) updatesA.push(event.update); });
    b.on('update', (event: ProjectUpdate) => { if (event.origin !== REMOTE_ORIGIN) updatesB.push(event.update); });
    a.applyTextChanges('a.py', [{ offset: 1, deleteCount: 0, insertText: 'A' }]);
    b.applyTextChanges('a.py', [{ offset: 1, deleteCount: 0, insertText: 'B' }]);
    for (const update of updatesA) b.applyRemoteUpdate('a.py', 'text', update);
    for (const update of updatesB) a.applyRemoteUpdate('a.py', 'text', update);
    assert.equal(a.text('a.py').toString(), b.text('a.py').toString());
    assert.match(a.text('a.py').toString(), /^a(?:AB|BA)bc$/);
  });

  it('converges after concurrent deletion and insertion', () => {
    const [a, b] = pairedTextProjects('abcdef');
    const updatesA = captureLocalUpdates(a);
    const updatesB = captureLocalUpdates(b);
    a.applyTextChanges('a.py', [{ offset: 1, deleteCount: 3, insertText: '' }]);
    b.applyTextChanges('a.py', [{ offset: 3, deleteCount: 2, insertText: 'XY' }]);
    exchange(a, b, updatesA, updatesB, 'a.py', 'text');
    assert.equal(a.text('a.py').toString(), b.text('a.py').toString());
  });

  it('adds a notebook cell and preserves its stable ID', () => {
    const [a, b] = pairedNotebookProjects();
    const updates = captureLocalUpdates(a);
    a.reconcileNotebook('article.ipynb', {
      ...notebook,
      cells: [...notebook.cells, { id: 'cell-c', kind: 2, language: 'python', source: 'print(x)', metadata: {}, outputs: [] }],
    });
    for (const update of updates) b.applyRemoteUpdate('article.ipynb', 'notebook', update);
    assert.deepEqual(b.notebookSnapshot('article.ipynb').cells.map((cell) => cell.id), ['cell-a', 'cell-b', 'cell-c']);
  });

  it('deletes a notebook cell on every peer', () => {
    const [a, b] = pairedNotebookProjects();
    const updates = captureLocalUpdates(a);
    a.reconcileNotebook('article.ipynb', { ...notebook, cells: [notebook.cells[1]!] });
    for (const update of updates) b.applyRemoteUpdate('article.ipynb', 'notebook', update);
    assert.deepEqual(b.notebookSnapshot('article.ipynb').cells.map((cell) => cell.id), ['cell-b']);
  });

  it('moves a notebook cell with an incremental Y.Array order change', () => {
    const [a, b] = pairedNotebookProjects();
    const updates = captureLocalUpdates(a);
    a.reconcileNotebook('article.ipynb', { ...notebook, cells: [notebook.cells[1]!, notebook.cells[0]!] });
    for (const update of updates) b.applyRemoteUpdate('article.ipynb', 'notebook', update);
    assert.deepEqual(b.notebookSnapshot('article.ipynb').cells.map((cell) => cell.id), ['cell-b', 'cell-a']);
  });

  it('merges two peers editing the same notebook cell', () => {
    const [a, b] = pairedNotebookProjects();
    const updatesA = captureLocalUpdates(a);
    const updatesB = captureLocalUpdates(b);
    a.applyCellTextChanges('article.ipynb', 'cell-a', [{ offset: 0, deleteCount: 0, insertText: 'A' }]);
    b.applyCellTextChanges('article.ipynb', 'cell-a', [{ offset: 0, deleteCount: 0, insertText: 'B' }]);
    exchange(a, b, updatesA, updatesB, 'article.ipynb', 'notebook');
    assert.equal(a.notebookSnapshot('article.ipynb').cells[0]!.source, b.notebookSnapshot('article.ipynb').cells[0]!.source);
  });

  it('converges when peers concurrently edit different cells and notebook metadata', () => {
    const [a, b] = pairedNotebookProjects();
    const updatesA = captureLocalUpdates(a);
    const updatesB = captureLocalUpdates(b);
    a.applyCellTextChanges('article.ipynb', 'cell-a', [{ offset: 5, deleteCount: 0, insertText: ' + 1' }]);
    a.setNotebookMetadata('article.ipynb', { owner: 'A' });
    b.applyCellTextChanges('article.ipynb', 'cell-b', [{ offset: 7, deleteCount: 0, insertText: ' B' }]);
    b.setCellMetadata('article.ipynb', 'cell-b', { editedBy: 'B' });
    exchange(a, b, updatesA, updatesB, 'article.ipynb', 'notebook');
    assert.deepEqual(a.notebookSnapshot('article.ipynb'), b.notebookSnapshot('article.ipynb'));
    assert.match(a.notebookSnapshot('article.ipynb').cells[0]!.source, /\+ 1/);
    assert.equal(a.notebookSnapshot('article.ipynb').cells[1]!.metadata.editedBy, 'B');
  });

  it('converges after concurrent notebook insertion and deletion without duplicate IDs', () => {
    const [a, b] = pairedNotebookProjects();
    const updatesA = captureLocalUpdates(a);
    const updatesB = captureLocalUpdates(b);
    a.reconcileNotebook('article.ipynb', {
      ...notebook,
      cells: [notebook.cells[0]!, { id: 'cell-new', kind: 2, language: 'python', source: 'NEW', metadata: {}, outputs: [] }, notebook.cells[1]!],
    });
    b.reconcileNotebook('article.ipynb', { ...notebook, cells: [notebook.cells[1]!] });
    exchange(a, b, updatesA, updatesB, 'article.ipynb', 'notebook');
    const idsA = a.notebookSnapshot('article.ipynb').cells.map((cell) => cell.id);
    const idsB = b.notebookSnapshot('article.ipynb').cells.map((cell) => cell.id);
    assert.deepEqual(idsA, idsB);
    assert.equal(new Set(idsA).size, idsA.length);
  });

  it('recovers only missing changes with state vectors', () => {
    const [a, b] = pairedTextProjects('one');
    a.applyTextChanges('a.py', [{ offset: 3, deleteCount: 0, insertText: '-a' }]);
    b.applyTextChanges('a.py', [{ offset: 0, deleteCount: 0, insertText: 'b-' }]);
    const diffA = a.encodeUpdate('a.py', b.encodeStateVector('a.py'));
    const diffB = b.encodeUpdate('a.py', a.encodeStateVector('a.py'));
    a.applyRemoteUpdate('a.py', 'text', diffB);
    b.applyRemoteUpdate('a.py', 'text', diffA);
    assert.equal(a.text('a.py').toString(), b.text('a.py').toString());
  });

  it('does not treat a remote update as a new local provider update', () => {
    const a = new CollaborativeProject();
    const b = new CollaborativeProject();
    a.ensureText('a.py', 'x');
    b.applyRemoteUpdate('a.py', 'text', a.encodeUpdate('a.py'));
    let forwarded = 0;
    b.on('update', (event: ProjectUpdate) => { if (event.origin !== REMOTE_ORIGIN) forwarded += 1; });
    const update = captureLocalUpdates(a);
    a.applyTextChanges('a.py', [{ offset: 1, deleteCount: 0, insertText: 'y' }]);
    b.applyRemoteUpdate('a.py', 'text', update[0]!);
    assert.equal(forwarded, 0);
  });

  it('emits single-cell scope and keeps one-character updates synchronous', () => {
    const project = new CollaborativeProject();
    project.ensureNotebook('article.ipynb', notebook);
    let updates = 0;
    let scope = '';
    project.on('update', (event: ProjectUpdate) => {
      updates += 1;
      scope = event.scope?.type ?? '';
    });
    const started = performance.now();
    for (let index = 0; index < 1000; index += 1) {
      project.applyCellTextChanges('article.ipynb', 'cell-a', [{ offset: index, deleteCount: 0, insertText: 'x' }]);
    }
    assert.equal(updates, 1000);
    assert.equal(scope, 'cellText');
    assert.ok(performance.now() - started < 1000, 'one-character CRDT updates must stay in the synchronous hot path');
  });

  it('preserves CRDT documents across an atomic directory rename', () => {
    const project = new CollaborativeProject();
    project.ensureText('old/code.py', 'print(1)');
    project.renameDocument('old', 'new');
    assert.equal(project.has('old/code.py'), false);
    assert.equal(project.text('new/code.py').toString(), 'print(1)');
    const update = captureLocalUpdates(project);
    project.applyTextChanges('new/code.py', [{ offset: 6, deleteCount: 1, insertText: '2' }]);
    assert.equal(update.length, 1);
  });

  it('sanitizes malformed notebook output state received through Yjs', () => {
    const attacker = new Y.Doc();
    attacker.transact(() => {
      const order = attacker.getArray<string>('cells');
      const data = attacker.getMap<Y.Map<unknown>>('cellData');
      const cell = new Y.Map<unknown>();
      const source = new Y.Text();
      source.insert(0, 'print(1)');
      cell.set('source', source);
      cell.set('kind', 2);
      cell.set('language', 'python');
      cell.set('metadata', '{not-json');
      cell.set('outputs', JSON.stringify([{ items: null }]));
      data.set('safe-cell', cell);
      order.insert(0, ['safe-cell', '../unsafe-cell']);
    });

    const project = new CollaborativeProject();
    project.applyRemoteUpdate('unsafe.ipynb', 'notebook', Y.encodeStateAsUpdate(attacker));
    const snapshot = project.notebookSnapshot('unsafe.ipynb');
    assert.deepEqual(snapshot.cells.map((cell) => cell.id), ['safe-cell']);
    assert.deepEqual(snapshot.cells[0]!.metadata, {});
    assert.deepEqual(snapshot.cells[0]!.outputs, []);
  });

  it('bounds notebook output block counts before storing them in Yjs', () => {
    const project = new CollaborativeProject();
    project.ensureNotebook('bounded.ipynb', {
      metadata: {},
      cells: [{ id: 'cell', kind: 2, language: 'python', source: '', metadata: {}, outputs: [] }],
    });
    const output = { items: [{ mime: 'text/plain', dataBase64: '' }] };
    assert.throws(
      () => project.setCellOutputs('bounded.ipynb', 'cell', Array.from({ length: MAX_CELL_OUTPUTS + 1 }, () => output)),
      /output limit/,
    );
  });

  it('emits the replaced destination document before destroying it on rename', () => {
    const project = new CollaborativeProject();
    project.ensureText('source.py', 'source');
    const replaced = project.ensureText('destination.py', 'destination').doc;
    let deleted: Y.Doc | undefined;
    project.on('documentDeleted', (key: string, kind: string, doc: Y.Doc) => {
      if (key === 'destination.py' && kind === 'text') deleted = doc;
    });
    project.renameDocument('source.py', 'destination.py');
    assert.equal(deleted, replaced);
    assert.equal(project.text('destination.py').toString(), 'source');
  });
});

describe('stable notebook cell identity', () => {
  it('preserves A and B when NEW is inserted between them', () => {
    const generated = ['cell-new'];
    const registry = new StableCellIdRegistry<object>(() => generated.shift() ?? 'unexpected');
    const a = {};
    const b = {};
    registry.seed(a, undefined, 'cell-a');
    registry.seed(b, undefined, 'cell-b');
    const inserted = {};
    assert.deepEqual([a, inserted, b].map((cell) => registry.idFor(cell)), ['cell-a', 'cell-new', 'cell-b']);
  });

  it('preserves identity after deleting the first cell and moving cells', () => {
    const registry = new StableCellIdRegistry<object>(() => 'new');
    const a = {};
    const b = {};
    const c = {};
    registry.seed(a, undefined, 'a');
    registry.seed(b, undefined, 'b');
    registry.seed(c, undefined, 'c');
    assert.deepEqual([b, c].map((cell) => registry.idFor(cell)), ['b', 'c']);
    assert.deepEqual([c, a, b].map((cell) => registry.idFor(cell)), ['c', 'a', 'b']);
  });

  it('uses a minimal structural splice for insertion and keeps the trailing cell untouched', () => {
    const target: NotebookSnapshot = {
      metadata: {},
      cells: [
        { id: 'a', kind: 2, language: 'python', source: 'A', metadata: {}, outputs: [] },
        { id: 'new', kind: 2, language: 'python', source: 'NEW', metadata: {}, outputs: [] },
        { id: 'b', kind: 2, language: 'python', source: 'B', metadata: {}, outputs: [] },
      ],
    };
    const splice = minimalNotebookSplice([
      { id: 'a', kind: 2, language: 'python' },
      { id: 'b', kind: 2, language: 'python' },
    ], target.cells);
    assert.deepEqual(splice, { start: 1, deleteCount: 0, cells: [target.cells[1]] });
  });

  it('round-trips stable IDs through registry, real Yjs update, and ipynb serialization', () => {
    const registry = new StableCellIdRegistry<object>(() => 'new-id');
    const a = {};
    const b = {};
    registry.seed(a, undefined, 'a-id');
    registry.seed(b, undefined, 'b-id');
    const inserted = {};
    const snapshot: NotebookSnapshot = {
      metadata: { language_info: { name: 'python' } },
      cells: [a, inserted, b].map((cell, index) => ({
        id: registry.idFor(cell), kind: 2, language: 'python', source: String(index), metadata: {}, outputs: [],
      })),
    };
    const local = new CollaborativeProject();
    const remote = new CollaborativeProject();
    local.ensureNotebook('n.ipynb', snapshot);
    remote.applyRemoteUpdate('n.ipynb', 'notebook', local.encodeUpdate('n.ipynb'));
    const restored = parseIpynb(Buffer.from(serializeIpynb(remote.notebookSnapshot('n.ipynb'))).toString('utf8'));
    assert.deepEqual(restored.cells.map((cell) => cell.id), ['a-id', 'new-id', 'b-id']);
  });
});


describe('repair regressions', () => {
  it('rejects multi-byte text that exceeds the byte limit before mutating CRDT state', () => {
    const project = new CollaborativeProject();
    project.ensureText('unicode.txt', 'safe');
    const oversized = '😀'.repeat(Math.floor(MAX_TEXT_DOCUMENT_BYTES / 4) + 1);
    assert.throws(() => project.replaceText('unicode.txt', oversized), /text-size limit/i);
    assert.equal(project.text('unicode.txt').toString(), 'safe');
    assert.throws(
      () => project.applyTextChanges('unicode.txt', [{ offset: 4, deleteCount: 0, insertText: oversized }]),
      /text change is outside|text-size limit/i,
    );
    assert.equal(project.text('unicode.txt').toString(), 'safe');
    project.destroy();
  });

  it('never silently truncates an oversized cell produced by a remote merge', () => {
    const project = new CollaborativeProject();
    project.ensureNotebook('oversized.ipynb', {
      metadata: {},
      cells: [{ id: 'cell', kind: 2, language: 'python', source: '', metadata: {}, outputs: [] }],
    });
    project.cellSource('oversized.ipynb', 'cell').insert(0, 'x'.repeat(MAX_CELL_SOURCE_BYTES + 1));
    assert.throws(
      () => project.notebookSnapshot('oversized.ipynb'),
      /source-size limit after collaborative merging/i,
    );
    project.destroy();
  });

  it('matches initial cell IDs by cell identity fingerprint instead of numerical index', () => {
    const target: NotebookSnapshot = {
      metadata: {},
      cells: [
        { id: 'a', kind: 2, language: 'python', source: 'A', metadata: {}, outputs: [] },
        { id: 'b', kind: 2, language: 'python', source: 'B', metadata: {}, outputs: [] },
      ],
    };
    assert.deepEqual(matchInitialCellIds([
      { kind: 2, language: 'python', source: 'A' },
      { kind: 2, language: 'python', source: 'NEW' },
      { kind: 2, language: 'python', source: 'B' },
    ], target.cells), ['a', undefined, 'b']);
    assert.deepEqual(matchInitialCellIds([
      { kind: 2, language: 'python', source: 'same' },
      { kind: 2, language: 'python', source: 'same' },
    ], {
      metadata: {},
      cells: [
        { id: 'x', kind: 2, language: 'python', source: 'same', metadata: {}, outputs: [] },
        { id: 'y', kind: 2, language: 'python', source: 'same', metadata: {}, outputs: [] },
      ],
    }.cells), [undefined, undefined]);
  });

  it('recovers the persistence queue after one failed operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-persistence-recovery-'));
    let fail = true;
    const adapter = new StorageAdapter({
      workingRoot: root,
      debounceMs: 10,
      serialize: async (relativePath) => {
        if (fail) { fail = false; throw new Error('transient write failure'); }
        return Buffer.from(`ok:${relativePath}`);
      },
    });
    adapter.on('operationError', () => undefined);
    try {
      adapter.schedule('first.py');
      await assert.rejects(adapter.flush(), /transient write failure/);
      adapter.schedule('second.py');
      await adapter.flush();
      assert.equal(await readFile(path.join(root, 'second.py'), 'utf8'), 'ok:second.py');
    } finally {
      await adapter.stop(false);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redirects an in-flight flush to the renamed path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-persistence-rename-'));
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new StorageAdapter({
      workingRoot: root,
      debounceMs: 10,
      serialize: async (relativePath) => {
        started();
        await gate;
        return Buffer.from(`content:${relativePath}`);
      },
    });
    try {
      adapter.schedule('old/a.py');
      const flushing = adapter.flush();
      await startedPromise;
      const renaming = adapter.rename('old', 'new', true);
      release();
      await Promise.all([flushing, renaming]);
      assert.equal(await readFile(path.join(root, 'new/a.py'), 'utf8'), 'content:old/a.py');
      await assert.rejects(stat(path.join(root, 'old/a.py')));
    } finally {
      await adapter.stop(false);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows the old path to be recreated after a rename without redirecting it again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-persistence-recreate-'));
    const values = new Map<string, string>([['old.py', 'FIRST']]);
    const adapter = new StorageAdapter({
      workingRoot: root,
      debounceMs: 10,
      serialize: async (relativePath) => Buffer.from(values.get(relativePath) ?? ''),
    });
    try {
      adapter.schedule('old.py');
      await adapter.flush();
      await adapter.rename('old.py', 'new.py');
      values.set('old.py', 'SECOND');
      adapter.schedule('old.py');
      await adapter.flush();
      assert.equal(await readFile(path.join(root, 'new.py'), 'utf8'), 'FIRST');
      assert.equal(await readFile(path.join(root, 'old.py'), 'utf8'), 'SECOND');
    } finally {
      await adapter.stop(false);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('excludes dependency, VCS, cache, venv and session-marker paths from project snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-project-filter-'));
    try {
      await Promise.all([
        mkdir(path.join(root, '.git'), { recursive: true }),
        mkdir(path.join(root, 'node_modules/pkg'), { recursive: true }),
        mkdir(path.join(root, '.venv'), { recursive: true }),
        mkdir(path.join(root, '__pycache__'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(root, 'main.py'), 'print(1)'),
        writeFile(path.join(root, '.git/config'), 'secret-ish metadata'),
        writeFile(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 1'),
        writeFile(path.join(root, '.venv/pyvenv.cfg'), 'home=x'),
        writeFile(path.join(root, '__pycache__/a.pyc'), 'cache'),
        writeFile(path.join(root, '.pair-notebook-session.json'), '{}'),
        writeFile(path.join(root, '.pair-notebook-ended.json'), '{}'),
        writeFile(path.join(root, '.pair-notebook-autosave.json'), '{}'),
        writeFile(path.join(root, 'main.py.pair-notebook-123.tmp'), 'partial'),
      ]);
      assert.equal(shouldTrackProjectPath('.git/config'), false);
      assert.equal(shouldTrackProjectPath('src/node_modules/pkg.js'), false);
      assert.equal(shouldTrackProjectPath('.venv/pyvenv.cfg'), false);
      assert.equal(shouldTrackProjectPath('__pycache__/x.pyc'), false);
      assert.equal(shouldTrackProjectPath('main.py.pair-notebook-123.tmp'), false);
      assert.equal(shouldTrackProjectPath('.pair-notebook-ended.json'), false);
      assert.deepEqual((await scanProject(root)).map((file) => file.relativePath), ['main.py']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('queues Trystero frames under backpressure instead of silently dropping them', async () => {
    const peer: PeerIdentity = { peerId: 'self', displayName: 'Self', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'bp', token: 'token-that-is-long-enough-123456', localPeer: peer,
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    (transport as any).connections.set('transport-peer', {
      transportPeerId: 'transport-peer', identity: { peerId: 'remote', displayName: 'Remote', joinOrder: 1 }, purpose: 'runtime', lastSeen: Date.now(),
    });
    (transport as any).action = {
      send: async (frame: ArrayBuffer) => {
        sent.push(Buffer.from(frame).toString());
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    (transport as any).enqueue('transport-peer', Buffer.from('one'), 'realtime');
    (transport as any).enqueue('transport-peer', Buffer.from('two'), 'realtime');
    (transport as any).enqueue('transport-peer', Buffer.from('three'), 'realtime');
    await waitFor(() => sent.length === 1, 1000, 'first queued Trystero frame');
    assert.equal((transport as any).outboundQueues.get('transport-peer').realtimeFrames.length, 2);
    releases.shift()?.();
    await waitFor(() => sent.length === 2, 1000, 'second queued Trystero frame');
    releases.shift()?.();
    await waitFor(() => sent.length === 3, 1000, 'third queued Trystero frame');
    releases.shift()?.();
    assert.deepEqual(sent, ['one', 'two', 'three']);
  });

  it('lets a live edit overtake queued bulk-transfer frames', async () => {
    const peer: PeerIdentity = { peerId: 'self', displayName: 'Self', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'priority', token: 'token-that-is-long-enough-123456', localPeer: peer,
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    (transport as any).connections.set('transport-peer', {
      transportPeerId: 'transport-peer', identity: { peerId: 'remote', displayName: 'Remote', joinOrder: 1 }, purpose: 'runtime', lastSeen: Date.now(),
    });
    (transport as any).action = {
      send: async (frame: ArrayBuffer) => {
        sent.push(Buffer.from(frame).toString());
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    (transport as any).enqueue('transport-peer', Buffer.from('bulk-1'), 'bulk');
    (transport as any).enqueue('transport-peer', Buffer.from('bulk-2'), 'bulk');
    (transport as any).enqueue('transport-peer', Buffer.from('edit'), 'realtime');
    await waitFor(() => sent.length === 1, 1000, 'first bulk frame');
    releases.shift()?.();
    await waitFor(() => sent.length === 2, 1000, 'priority frame');
    assert.deepEqual(sent, ['bulk-1', 'edit']);
    releases.shift()?.();
    await waitFor(() => sent.length === 3, 1000, 'remaining bulk frame');
    releases.shift()?.();
    assert.deepEqual(sent, ['bulk-1', 'edit', 'bulk-2']);
  });

  it('surfaces a failed Trystero send and releases the failed peer queue', async () => {
    const peer: PeerIdentity = { peerId: 'self', displayName: 'Self', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'failed-send', token: 'failed-send-token-that-is-long-enough', localPeer: peer,
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    (transport as any).connections.set('transport-peer', {
      transportPeerId: 'transport-peer', identity: { peerId: 'remote', displayName: 'Remote', joinOrder: 1 }, purpose: 'runtime', lastSeen: Date.now(),
    });
    (transport as any).identityToTransport.set('remote', 'transport-peer');
    (transport as any).action = { send: async () => { throw new Error('simulated send failure'); } };
    (transport as any).enqueue('transport-peer', Buffer.from('frame'), 'realtime');
    await waitFor(() => !(transport as any).connections.has('transport-peer'), 1000, 'failed peer cleanup');
    assert.equal((transport as any).outboundQueues.has('transport-peer'), false);
    await assert.rejects(transport.awaitDrain('remote', 0, 100), /disconnected/);
  });

  it('keeps MQTT and promoted-upgrade sends in flight until their promises settle', async () => {
    for (const route of ['mqtt:', 'upgrade:']) {
      const transportPeerId = `${route}transport-peer`;
      const routeName = route.slice(0, -1);
      const transport = new MeshTransport({
        sessionId: `pending-${routeName}`, token: 'pending-route-token-that-is-long-enough',
        localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
      });
      let releaseSend: (() => void) | undefined;
      let sendStarted = false;
      const routeAction = {
        send: async () => {
          sendStarted = true;
          await new Promise<void>((resolve) => { releaseSend = resolve; });
        },
      };
      (transport as any).connections.set(transportPeerId, {
        transportPeerId,
        identity: { peerId: 'remote', displayName: 'Remote', joinOrder: 1 },
        purpose: 'runtime', connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      (transport as any).identityToTransport.set('remote', transportPeerId);
      (transport as any).action = { send: async () => undefined };
      if (route === 'mqtt:') (transport as any).mqttAction = routeAction;
      else (transport as any).upgradeAction = routeAction;

      (transport as any).enqueue(transportPeerId, Buffer.from('pending-frame'), 'realtime');
      await waitFor(() => sendStarted, 1000, `${route} send start`);
      const queue = (transport as any).outboundQueues.get(transportPeerId);
      assert.equal(queue.inFlightFrames, 1, route);
      assert.ok(queue.inFlightBytes > 0, route);
      let drained = false;
      const drain = transport.awaitDrain('remote', 0, 1000, 0).then(() => { drained = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false, `${route} awaitDrain must wait for send completion`);
      releaseSend?.();
      await drain;
      assert.equal(queue.inFlightFrames, 0, route);
      assert.equal(queue.inFlightBytes, 0, route);
    }
  });

  it('disconnects failed active MQTT and promoted-upgrade routes', async () => {
    for (const route of ['mqtt:', 'upgrade:']) {
      const transportPeerId = `${route}transport-peer`;
      const routeName = route.slice(0, -1);
      const transport = new MeshTransport({
        sessionId: `failed-${routeName}`, token: 'failed-route-token-that-is-long-enough',
        localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
      });
      const failures: Error[] = [];
      transport.on('connectionError', (_peer, error: Error) => failures.push(error));
      (transport as any).connections.set(transportPeerId, {
        transportPeerId,
        identity: { peerId: 'remote', displayName: 'Remote', joinOrder: 1 },
        purpose: 'runtime', connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      (transport as any).identityToTransport.set('remote', transportPeerId);
      (transport as any).action = { send: async () => undefined };
      const failedAction = { send: async () => { throw new Error(`failed ${route} send`); } };
      if (route === 'mqtt:') (transport as any).mqttAction = failedAction;
      else (transport as any).upgradeAction = failedAction;

      (transport as any).enqueue(transportPeerId, Buffer.from('failed-frame'), 'realtime');
      await waitFor(() => !(transport as any).connections.has(transportPeerId), 1000, `${route} failed cleanup`);
      assert.equal((transport as any).identityToTransport.has('remote'), false, route);
      assert.equal((transport as any).outboundQueues.has(transportPeerId), false, route);
      assert.equal(failures.length, 1, route);
      assert.match(failures[0]?.message ?? '', /failed .* send/);
    }
  });

  it('fails an unpromoted candidate send without retiring the working relay route', async () => {
    const transport = new MeshTransport({
      sessionId: 'failed-candidate', token: 'failed-candidate-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:candidate-raw';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const failures: Error[] = [];
    let disconnected = 0;
    transport.on('connectionError', (_peer, error: Error) => failures.push(error));
    transport.on('peerDisconnected', () => { disconnected += 1; });
    (transport as any).connections.set(activeTransportId, {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).action = { send: async () => undefined };
    (transport as any).upgradeAction = { send: async () => { throw new Error('candidate send failed'); } };
    const upgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      verifiedPings: 0, candidateRawId: 'candidate-raw', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', upgrade);

    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('candidate-probe'));
    await waitFor(() => !(transport as any).routeUpgrades.has('remote'), 1000, 'candidate failure state');
    assert.equal((transport as any).identityToTransport.get('remote'), activeTransportId);
    assert.equal((transport as any).connections.has(activeTransportId), true);
    assert.equal((transport as any).connections.has(candidateTransportId), false);
    assert.equal((transport as any).outboundQueues.has(candidateTransportId), false);
    assert.equal(failures.length, 0);
    assert.equal(disconnected, 0);
  });

  it('rejects a stale upgrade join after cancellation without retiring the relay route', () => {
    const transport = new MeshTransport({
      sessionId: 'late-upgrade-handshake', token: 'late-upgrade-handshake-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:late-candidate-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).identityToTransport.set(identity.peerId, activeTransportId);
    const upgrade = {
      peerId: identity.peerId, role: 'initiator', status: 'requesting', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0,
    };
    (transport as any).routeUpgrades.set(identity.peerId, upgrade);
    const admitted = (transport as any).assertPeerCanJoin(identity, candidateTransportId);
    (transport as any).pendingHandshakes.set(candidateTransportId, {
      version: 5,
      sessionId: 'late-upgrade-handshake',
      purpose: 'runtime',
      peer: admitted,
      nonce: newIdentityNonce(),
      admittedAt: Date.now(),
      upgradeGeneration: upgrade,
    });
    let candidateClosed = 0;
    (transport as any).upgradeRoom = {
      getPeers: () => ({
        'late-candidate-id': { close: () => { candidateClosed += 1; } },
      }),
      leave: async () => undefined,
    };
    // Keep the shared upgrade room alive exactly as a different promoted
    // route would while this attempt is cancelled.
    (transport as any).identityToTransport.set('other-peer', 'upgrade:promoted-other');

    transport.cancelRouteUpgrade(identity.peerId);
    assert.equal((transport as any).routeUpgrades.has(identity.peerId), false);
    (transport as any).onUpgradeCandidateJoin('late-candidate-id');

    assert.equal((transport as any).identityToTransport.get(identity.peerId), activeTransportId);
    assert.equal((transport as any).connections.get(activeTransportId), incumbentConnection);
    assert.equal((transport as any).connections.has(candidateTransportId), false);
    assert.equal((transport as any).pendingHandshakes.has(candidateTransportId), false);
    assert.equal(candidateClosed, 1);
  });

  it('keeps a fresh emergency relay route during late duplicate signalling', () => {
    const transport = new MeshTransport({
      sessionId: 'relay-owner-live', token: 'relay-owner-live-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const relayTransportId = 'relay:remote';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const connection = {
      transportPeerId: relayTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    let primaryRoomLookups = 0;
    (transport as any).connections.set(relayTransportId, connection);
    (transport as any).identityToTransport.set(identity.peerId, relayTransportId);
    (transport as any).relay = { connectedRelayCount: 1 };
    (transport as any).room = {
      getPeers: () => {
        primaryRoomLookups += 1;
        return {};
      },
    };

    assert.throws(
      () => (transport as any).assertPeerCanJoin(identity, 'late-direct-peer'),
      /already connected through another signalling family/i,
    );
    assert.equal((transport as any).identityToTransport.get(identity.peerId), relayTransportId);
    assert.equal((transport as any).connections.get(relayTransportId), connection);
    assert.equal(primaryRoomLookups, 0, 'relay liveness must not consult the primary Trystero room');
  });

  it('replaces a stale or locally unavailable relay route without closing a room peer', () => {
    for (const scenario of [
      { name: 'stale', connectedRelayCount: 1, lastSeen: Date.now() - DUPLICATE_HANDSHAKE_WINDOW_MS - 1 },
      { name: 'unavailable', connectedRelayCount: 0, lastSeen: Date.now() },
    ]) {
      const transport = new MeshTransport({
        sessionId: `relay-owner-${scenario.name}`,
        token: `relay-owner-${scenario.name}-token-that-is-long-enough`,
        localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
      });
      const relayTransportId = 'relay:remote';
      const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
      let primaryRoomLookups = 0;
      (transport as any).connections.set(relayTransportId, {
        transportPeerId: relayTransportId, identity, purpose: 'runtime',
        connectedAt: Date.now(), lastSeen: scenario.lastSeen, snapshotRequested: false,
      });
      (transport as any).identityToTransport.set(identity.peerId, relayTransportId);
      (transport as any).relay = { connectedRelayCount: scenario.connectedRelayCount };
      (transport as any).room = {
        getPeers: () => {
          primaryRoomLookups += 1;
          return {};
        },
      };

      assert.deepEqual((transport as any).assertPeerCanJoin(identity, 'replacement-direct-peer'), identity);
      assert.equal((transport as any).identityToTransport.has(identity.peerId), false, scenario.name);
      assert.equal((transport as any).connections.has(relayTransportId), false, scenario.name);
      assert.equal(primaryRoomLookups, 0, `${scenario.name} relay retirement must not touch a room peer`);
    }
  });

  it('ignores a retired queue rejection after the candidate transport id is reused', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-queue-reuse', token: 'candidate-reuse-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:reused-raw-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    let rejectOldSend: ((reason?: unknown) => void) | undefined;
    let oldSendStarted = false;
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).action = { send: async () => undefined };
    (transport as any).upgradeAction = {
      send: async () => {
        oldSendStarted = true;
        await new Promise<void>((_resolve, reject) => { rejectOldSend = reject; });
      },
    };
    const oldUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0, candidateRawId: 'reused-raw-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', oldUpgrade);
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('old-probe'));
    await waitFor(() => oldSendStarted, 1000, 'old candidate send start');
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('old-queued-probe'));
    const oldQueue = (transport as any).outboundQueues.get(candidateTransportId);

    transport.cancelRouteUpgrade('remote');
    assert.equal(oldQueue.realtimeFrames.length, 0);
    assert.equal(oldQueue.queuedBytes, 0);
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), true);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    const newPayloads: string[] = [];
    (transport as any).upgradeAction = {
      send: async (frame: ArrayBuffer) => { newPayloads.push(Buffer.from(frame).toString()); },
    };
    const newUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0, candidateRawId: 'reused-raw-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', newUpgrade);
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('new-probe'));
    const newQueue = (transport as any).outboundQueues.get(candidateTransportId);
    assert.notEqual(newQueue, oldQueue);

    rejectOldSend?.(new Error('late old send failure'));
    await waitFor(() => oldQueue.draining === false, 1000, 'retired queue settlement');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), false);
    assert.equal((transport as any).routeUpgrades.get('remote'), newUpgrade);
    assert.equal((transport as any).connections.has(candidateTransportId), true);
    assert.equal((transport as any).outboundQueues.get(candidateTransportId), newQueue);
    assert.equal((transport as any).identityToTransport.get('remote'), activeTransportId);
    assert.deepEqual(newPayloads, ['new-probe']);
  });

  it('does not resume retired queued frames after a successful old send settles', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-queue-resolve', token: 'candidate-resolve-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:resolved-raw-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    let resolveOldSend: (() => void) | undefined;
    let oldSendStarted = false;
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).action = { send: async () => undefined };
    (transport as any).upgradeAction = {
      send: async () => {
        oldSendStarted = true;
        await new Promise<void>((resolve) => { resolveOldSend = resolve; });
      },
    };
    const oldUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0, candidateRawId: 'resolved-raw-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', oldUpgrade);
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('old-probe'));
    await waitFor(() => oldSendStarted, 1000, 'old resolving candidate send start');
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('old-queued-probe'));
    const oldQueue = (transport as any).outboundQueues.get(candidateTransportId);

    transport.cancelRouteUpgrade('remote');
    assert.equal(oldQueue.realtimeFrames.length, 0);
    assert.equal(oldQueue.queuedBytes, 0);
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), true);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    const newPayloads: string[] = [];
    (transport as any).upgradeAction = {
      send: async (frame: ArrayBuffer) => { newPayloads.push(Buffer.from(frame).toString()); },
    };
    const newUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0, candidateRawId: 'resolved-raw-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', newUpgrade);
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('new-probe'));
    const newQueue = (transport as any).outboundQueues.get(candidateTransportId);

    resolveOldSend?.();
    await waitFor(() => oldQueue.draining === false, 1000, 'retired queue successful settlement');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), false);
    assert.equal((transport as any).routeUpgrades.get('remote'), newUpgrade);
    assert.equal((transport as any).outboundQueues.get(candidateTransportId), newQueue);
    assert.deepEqual(newPayloads, ['new-probe']);
  });

  it('counts retired in-flight candidate sends against the global queue limit', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-retired-budget', token: 'candidate-budget-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:retired-budget-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    let resolveOldSend: (() => void) | undefined;
    let oldSendStarted = false;
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).action = { send: async () => undefined };
    (transport as any).upgradeAction = {
      send: async () => {
        oldSendStarted = true;
        await new Promise<void>((resolve) => { resolveOldSend = resolve; });
      },
    };
    const upgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      verifiedPings: 0, candidateRawId: 'retired-budget-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', upgrade);
    (transport as any).enqueueCandidateFrame(candidateTransportId, Buffer.from('old-probe'));
    await waitFor(() => oldSendStarted, 1000, 'retired budget send start');
    const oldQueue = (transport as any).outboundQueues.get(candidateTransportId);
    const actualInFlightBytes = oldQueue.inFlightBytes;

    transport.cancelRouteUpgrade('remote');
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), true);
    oldQueue.inFlightBytes = 512 * 1024 * 1024;

    const freshTransportId = 'fresh-transport';
    const freshIdentity = { peerId: 'fresh-peer', displayName: 'Fresh', joinOrder: 2 };
    (transport as any).connections.set(freshTransportId, {
      transportPeerId: freshTransportId, identity: freshIdentity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set(freshIdentity.peerId, freshTransportId);
    assert.throws(
      () => (transport as any).enqueue(freshTransportId, Buffer.from('x'), 'realtime'),
      /512 MiB safety limit/,
    );

    oldQueue.inFlightBytes = actualInFlightBytes;
    resolveOldSend?.();
    await waitFor(() => oldQueue.draining === false, 1000, 'retired budget send settlement');
    assert.equal((transport as any).retiredOutboundQueues.has(oldQueue), false);
  });

  it('ignores a stale candidate ping after cancellation and a new upgrade generation', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-ping-reuse', token: 'candidate-ping-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:reused-ping-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    let resolveOldPing: ((latency: number) => void) | undefined;
    let oldPingStarted = false;
    const oldRoom = {
      ping: async () => {
        oldPingStarted = true;
        return new Promise<number>((resolve) => { resolveOldPing = resolve; });
      },
      getPeers: () => ({ 'reused-ping-id': { close: () => undefined } }),
      leave: async () => undefined,
    };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).upgradeRoom = oldRoom;
    (transport as any).upgradeAction = { send: async () => undefined };
    const oldUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now() - 10_000,
      connectedAt: Date.now() - 10_000, verifiedPings: 100,
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: true,
      candidateRawId: 'reused-ping-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', oldUpgrade);
    (transport as any).verifyCandidateTick(oldUpgrade);
    await waitFor(() => oldPingStarted, 1000, 'old candidate ping start');

    transport.cancelRouteUpgrade('remote');
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    const newRoom = {
      ping: async () => 1,
      getPeers: () => ({ 'reused-ping-id': { close: () => undefined } }),
      leave: async () => undefined,
    };
    (transport as any).upgradeRoom = newRoom;
    (transport as any).upgradeAction = { send: async () => undefined };
    const newUpgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now(),
      connectedAt: Date.now(), verifiedPings: 0,
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      candidateRawId: 'reused-ping-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', newUpgrade);

    resolveOldPing?.(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((transport as any).routeUpgrades.get('remote'), newUpgrade);
    assert.equal((transport as any).upgradeRoom, newRoom);
    assert.equal((transport as any).identityToTransport.get('remote'), activeTransportId);
    assert.equal((transport as any).connections.has(activeTransportId), true);
    assert.equal((transport as any).connections.has(candidateTransportId), true);
  });

  it('ignores a parallel candidate ping rejection after successful promotion', async () => {
    const transport = new MeshTransport({
      sessionId: 'parallel-candidate-ping', token: 'parallel-candidate-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:parallel-ping-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const pingSettlers: Array<{ resolve: (latency: number) => void; reject: (reason: unknown) => void }> = [];
    const room = {
      ping: async () => new Promise<number>((resolve, reject) => pingSettlers.push({ resolve, reject })),
      getPeers: () => ({ 'parallel-ping-id': { close: () => undefined } }),
      leave: async () => undefined,
    };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).latency.set('remote', { current: 100, ema: 100 });
    (transport as any).upgradeRoom = room;
    (transport as any).upgradeAction = { send: async () => undefined };
    const upgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now() - 10_000,
      connectedAt: Date.now() - 10_000, verifiedPings: 100,
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: true,
      candidateRawId: 'parallel-ping-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', upgrade);
    (transport as any).verifyCandidateTick(upgrade);
    (transport as any).verifyCandidateTick(upgrade);
    await waitFor(() => pingSettlers.length === 2, 1000, 'parallel candidate pings');

    pingSettlers[0]?.resolve(1);
    await waitFor(
      () => (transport as any).identityToTransport.get('remote') === candidateTransportId,
      1000,
      'candidate promotion',
    );
    pingSettlers[1]?.reject(new Error('late parallel ping failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal((transport as any).identityToTransport.get('remote'), candidateTransportId);
    assert.equal((transport as any).connections.has(candidateTransportId), true);
    assert.equal((transport as any).routeUpgrades.has('remote'), false);
  });

  it('requires a bidirectional candidate probe acknowledgement before promotion', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-probe-ack', token: 'candidate-probe-ack-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:probe-ack-id';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).latency.set('remote', { current: 100, ema: 100 });
    (transport as any).upgradeRoom = {
      ping: async () => 1,
      getPeers: () => ({ 'probe-ack-id': { close: () => undefined } }),
      leave: async () => undefined,
    };
    (transport as any).upgradeAction = { send: async () => undefined };
    const upgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now() - 10_000,
      connectedAt: Date.now() - 10_000, verifiedPings: 100,
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: false,
      probeMessageId: 'probe-message-id', candidateRawId: 'probe-ack-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', upgrade);

    (transport as any).verifyCandidateTick(upgrade);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((transport as any).identityToTransport.get('remote'), activeTransportId);

    upgrade.probeAcknowledged = true;
    (transport as any).verifyCandidateTick(upgrade);
    await waitFor(
      () => (transport as any).identityToTransport.get('remote') === candidateTransportId,
      1000,
      'probe-acknowledged candidate promotion',
    );
    assert.equal((transport as any).routeUpgrades.has('remote'), false);
  });

  it('does not promote a candidate after the incumbent connection is replaced', async () => {
    const transport = new MeshTransport({
      sessionId: 'candidate-incumbent-generation', token: 'candidate-incumbent-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const activeTransportId = 'relay:remote';
    const candidateTransportId = 'upgrade:incumbent-generation-id';
    const replacementTransportId = 'direct:replacement';
    const identity = { peerId: 'remote', displayName: 'Remote', joinOrder: 1 };
    const incumbentConnection = {
      transportPeerId: activeTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    };
    let pingCalls = 0;
    (transport as any).connections.set(activeTransportId, incumbentConnection);
    (transport as any).connections.set(candidateTransportId, {
      transportPeerId: candidateTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', activeTransportId);
    (transport as any).upgradeRoom = {
      ping: async () => { pingCalls += 1; return 1; },
      getPeers: () => ({ 'incumbent-generation-id': { close: () => undefined } }),
      leave: async () => undefined,
    };
    (transport as any).upgradeAction = { send: async () => undefined };
    const upgrade = {
      peerId: 'remote', role: 'initiator', status: 'verifying', startedAt: Date.now() - 10_000,
      connectedAt: Date.now() - 10_000, verifiedPings: 100,
      incumbentTransportId: activeTransportId, incumbentConnection, probeAcknowledged: true,
      candidateRawId: 'incumbent-generation-id', candidateTransportId,
    };
    (transport as any).routeUpgrades.set('remote', upgrade);
    (transport as any).connections.set(replacementTransportId, {
      transportPeerId: replacementTransportId, identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('remote', replacementTransportId);

    (transport as any).verifyCandidateTick(upgrade);
    assert.equal((transport as any).identityToTransport.get('remote'), replacementTransportId);
    assert.equal((transport as any).connections.has(replacementTransportId), true);
    assert.equal((transport as any).connections.has(candidateTransportId), false);
    assert.equal((transport as any).routeUpgrades.has('remote'), false);
    assert.equal(pingCalls, 0);
  });

  it('scopes packet deduplication to the admitted source and blocks forged control traffic', () => {
    const transport = new MeshTransport({
      sessionId: 'inbound-hardening', token: 'inbound-hardening-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const connection = (transportPeerId: string, peerId: string, purpose = 'runtime') => ({
      transportPeerId,
      identity: { peerId, displayName: peerId, joinOrder: 1 },
      purpose,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      snapshotRequested: false,
    });
    (transport as any).connections.set('transport-a', connection('transport-a', 'peer-a'));
    (transport as any).connections.set('transport-b', connection('transport-b', 'peer-b'));
    (transport as any).connections.set('transport-bootstrap', connection('transport-bootstrap', 'bootstrap-peer', 'bootstrap'));
    const delivered: Array<{ type: string; sourceId: string }> = [];
    const errors: Error[] = [];
    transport.on('message', (frame, sourceId) => delivered.push({ type: frame.type, sourceId }));
    transport.on('protocolError', (error: Error) => errors.push(error));
    const receive = (transportPeerId: string, type: string, sourceId: string, messageId: string, meta: Record<string, unknown> = {}) => {
      const bytes = encodeFrame(type, { ...meta, sourceId, messageId });
      const frame = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      (transport as any).handleAction(frame, transportPeerId);
    };

    receive('transport-a', 'duplicateProbe', 'peer-a', 'shared-id');
    receive('transport-b', 'duplicateProbe', 'peer-b', 'shared-id');
    receive('transport-a', 'duplicateProbe', 'peer-b', 'poison-id');
    receive('transport-b', 'duplicateProbe', 'peer-b', 'poison-id');
    receive('transport-b', 'peerDirectory', 'peer-b', 'directory-id', {
      peers: [{ peerId: 'ghost', displayName: 'Ghost', joinOrder: 2 }],
    });
    receive('transport-bootstrap', 'executeRequest', 'bootstrap-peer', 'bootstrap-command');

    assert.deepEqual(delivered, [
      { type: 'duplicateProbe', sourceId: 'peer-a' },
      { type: 'duplicateProbe', sourceId: 'peer-b' },
      { type: 'duplicateProbe', sourceId: 'peer-b' },
    ]);
    assert.equal((transport as any).directory.has('ghost'), false);
    assert.ok(errors.some((error) => /does not match admitted peer/i.test(error.message)));
    assert.ok(errors.some((error) => /Only the current host/i.test(error.message)));
    assert.ok(errors.some((error) => /not allowed.*bootstrap/i.test(error.message)));
    assert.equal((transport as any).connections.size, 0, 'protocol violators are disconnected instead of being allowed to flood logs');
  });

  it('drops a former host directory without severing failover reconciliation', () => {
    const transport = new MeshTransport({
      sessionId: 'stale-host-directory', token: 'stale-host-directory-token-that-is-long-enough',
      localPeer: { peerId: 'new-host', displayName: 'New Host', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 4, hostEpoch: 2, hostId: 'new-host' }), isHost: () => true,
    });
    (transport as any).connections.set('transport-old-host', {
      transportPeerId: 'transport-old-host',
      identity: { peerId: 'old-host', displayName: 'Old Host', joinOrder: 0 },
      purpose: 'runtime',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      snapshotRequested: false,
    });
    const errors: Error[] = [];
    transport.on('protocolError', (error: Error) => errors.push(error));
    const bytes = encodeFrame('peerDirectory', {
      sourceId: 'old-host',
      messageId: 'stale-directory',
      clock: { sessionEpoch: 4, hostEpoch: 1, hostId: 'old-host' },
      peers: [{ peerId: 'ghost', displayName: 'Ghost', joinOrder: 2 }],
    });
    (transport as any).handleAction(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'transport-old-host',
    );

    assert.equal((transport as any).directory.has('ghost'), false);
    assert.equal((transport as any).connections.has('transport-old-host'), true);
    assert.ok(errors.some((error) => /stale peer directory/i.test(error.message)));
  });

  it('projects peer identities and preserves pinned entries at the directory cap', () => {
    const transport = new MeshTransport({
      sessionId: 'peer-directory', token: 'peer-directory-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }), isHost: () => true,
    });
    const projectedKey = generateIdentityCredentials().publicKey;
    const parsed = (transport as any).parseHandshake({
      version: 5,
      sessionId: 'peer-directory',
      purpose: 'runtime',
      peer: {
        peerId: 'projected', displayName: 'Projected', joinOrder: 1,
        identityKey: projectedKey, unexpected: 'discarded',
      },
      nonce: newIdentityNonce(),
      unexpected: { nested: true },
    });
    assert.deepEqual(parsed.peer, {
      peerId: 'projected', displayName: 'Projected', joinOrder: 1, identityKey: projectedKey,
    });
    assert.throws(() => (transport as any).parseHandshake({
      version: 3,
      sessionId: 'peer-directory',
      purpose: 'runtime',
      peer: parsed.peer,
      nonce: newIdentityNonce(),
    }), /incompatible Pair Notebook session protocol/);

    for (let index = 0; index < 255; index += 1) {
      transport.updateDirectory([{
        peerId: `peer-${index}`,
        displayName: `Peer ${index}`,
        joinOrder: index + 1,
        unexpected: 'discarded',
      } as PeerIdentity]);
    }
    assert.equal((transport as any).directory.size, 256);
    assert.throws(() => transport.updateDirectory([{
      peerId: 'peer-255', displayName: 'Peer 255', joinOrder: 256,
    }]), /identity directory.*limit/i);
    assert.equal((transport as any).directory.has('peer-0'), true);
    assert.equal((transport as any).directory.has('peer-255'), false);
    assert.deepEqual(Object.keys((transport as any).directory.get('peer-254')).sort(), ['displayName', 'joinOrder', 'peerId']);

    (transport as any).connections.set('transport-live', {
      transportPeerId: 'transport-live',
      identity: { peerId: 'peer-254', displayName: 'Authenticated Name', joinOrder: 255 },
      purpose: 'runtime', connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    (transport as any).identityToTransport.set('peer-254', 'transport-live');
    transport.updateDirectory([{ peerId: 'peer-254', displayName: 'Forged Directory Name', joinOrder: 255 }]);
    assert.equal((transport as any).directory.get('peer-254').displayName, 'Authenticated Name');
  });
});

describe('host coordination', () => {
  it('allows graceful manual transfer in Host Only mode', () => {
    const coordinator = coordinatorFor('host-only', 'host-a');
    const next = coordinator.manualTransfer('peer-b');
    assert.equal(next.hostId, 'peer-b');
    assert.equal(next.hostEpoch, 4);
  });

  it('allows graceful manual transfer in Resilient mode', () => {
    const coordinator = coordinatorFor('resilient', 'host-a');
    assert.equal(coordinator.manualTransfer('peer-b').hostId, 'peer-b');
  });

  it('rejects manual transfer initiated by a participant', () => {
    const coordinator = coordinatorFor('resilient');
    assert.throws(() => coordinator.manualTransfer('peer-c'), /Only the current Session Host/);
    assert.equal(coordinator.clock.hostId, 'host-a');
    assert.equal(coordinator.clock.hostEpoch, 3);
  });

  it('closes Host Only after hard host loss', () => {
    const coordinator = coordinatorFor('host-only');
    coordinator.markDisconnected('host-a');
    coordinator.evaluate(Date.now() + 2000);
    assert.equal(coordinator.closed, true);
  });

  it('closes a resilient guest without electing a replacement after hard loss', () => {
    const coordinator = coordinatorFor('resilient');
    coordinator.markDisconnected('host-a');
    const next = coordinator.evaluate(Date.now() + 2000);
    assert.equal(next, undefined);
    assert.equal(coordinator.closed, true);
    assert.equal(coordinator.clock.hostId, 'host-a');
    assert.equal(coordinator.clock.hostEpoch, 3);
  });

  it('rejects stale host epochs', () => {
    const coordinator = coordinatorFor('resilient');
    assert.equal(coordinator.applyAnnouncement({ sessionEpoch: 10, hostEpoch: 2, hostId: 'old' }, 'old'), false);
    assert.equal(coordinator.clock.hostId, 'host-a');
  });

  it('rejects skipped and self-proclaimed host epochs', () => {
    const coordinator = coordinatorFor('resilient');
    assert.equal(coordinator.applyAnnouncement({ sessionEpoch: 10, hostEpoch: 6, hostId: 'peer-b' }, 'host-a'), false);
    assert.equal(coordinator.applyAnnouncement({ sessionEpoch: 10, hostEpoch: 4, hostId: 'peer-b' }, 'peer-b'), false);
    assert.equal(coordinator.clock.hostId, 'host-a');
    assert.equal(coordinator.clock.hostEpoch, 3);
    assert.equal(coordinator.applyAnnouncement({ sessionEpoch: 10, hostEpoch: 4, hostId: 'peer-b' }, 'host-a'), true);
  });

  it('keeps pinned host id and epoch unchanged throughout route recovery', () => {
    const coordinator = coordinatorFor('resilient');
    const before = { ...coordinator.clock };
    let hostChanges = 0;
    coordinator.on('hostChanged', () => { hostChanges += 1; });
    const host = coordinator.peers.get('host-a')!;
    host.online = false;
    host.connectionState = 'recovering';
    host.lastHeartbeat = 0;

    coordinator.evaluate(Date.now() + 20_000);
    coordinator.evaluate(Date.now() + 60_000);
    assert.equal(coordinator.closed, false);
    assert.deepEqual(coordinator.clock, before);
    assert.equal(hostChanges, 0, 'route recovery must never emit a host transfer');

    assert.equal(
      coordinator.applyAnnouncement(
        { sessionEpoch: before.sessionEpoch, hostEpoch: before.hostEpoch + 1, hostId: 'peer-c' },
        'peer-c',
      ),
      false,
      'a substitute peer cannot claim the pinned host identity',
    );
    assert.deepEqual(coordinator.clock, before);
  });

  it('still allows an explicit current-host transfer after adding the recovery guard', () => {
    const coordinator = coordinatorFor('resilient', 'host-a');
    const before = { ...coordinator.clock };
    const next = coordinator.manualTransfer('peer-b');
    assert.equal(next.hostId, 'peer-b');
    assert.equal(next.hostEpoch, before.hostEpoch + 1);
    assert.deepEqual(coordinator.clock, next);
  });
});

describe('filesystem persistence', () => {
  let root: string;
  let working: string;
  let backing: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-test-'));
    working = path.join(root, 'working');
    backing = path.join(root, 'backing');
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('persists current CRDT bytes to working and backing folders', async () => {
    const adapter = new StorageAdapter({ workingRoot: working, backingRoot: backing, debounceMs: 10, serialize: async () => Buffer.from('live') });
    adapter.schedule('src/a.py');
    await adapter.flush();
    assert.equal(await readFile(path.join(working, 'src/a.py'), 'utf8'), 'live');
    assert.equal(await readFile(path.join(backing, 'src/a.py'), 'utf8'), 'live');
    await adapter.stop(false);
  });

  it('durably updates the host backing folder before retrying a rejected editor write', async () => {
    const adapter = new StorageAdapter({
      workingRoot: working,
      backingRoot: backing,
      debounceMs: 10,
      serialize: async () => Buffer.from('canonical'),
      writeWorkingCopy: async () => { throw new Error('editor rejected update'); },
    });
    adapter.schedule('src/a.py');
    await assert.rejects(adapter.flush(), /editor rejected update/i);
    assert.equal(await readFile(path.join(backing, 'src/a.py'), 'utf8'), 'canonical');
    await adapter.stop(false);
  });

  it('creates, renames, and deletes project files/directories', async () => {
    const adapter = new StorageAdapter({ workingRoot: working, backingRoot: backing, debounceMs: 10, serialize: async () => Buffer.from('x') });
    await adapter.createDirectory('data/raw');
    await adapter.mirrorBinary('data/raw/image.bin', Buffer.from([1, 2, 3]));
    await adapter.rename('data/raw/image.bin', 'assets/image.bin');
    assert.equal((await stat(path.join(working, 'assets/image.bin'))).size, 3);
    assert.equal((await stat(path.join(backing, 'assets/image.bin'))).size, 3);
    await adapter.remove('assets');
    await assert.rejects(stat(path.join(working, 'assets/image.bin')));
    await adapter.stop(false);
  });

  it('rejects path traversal', () => {
    assert.throws(() => safeRelativePath('../../secrets.txt'));
    assert.throws(() => safeRelativePath('/absolute/secrets.txt'));
    assert.throws(() => safeRelativePath('\\\\server\\share\\secrets.txt'));
    assert.throws(() => safeRelativePath('safe\u202etxt.exe'));
    assert.throws(() => safeRelativePath(`unsafe\0name.py`));
    assert.throws(() => safeRelativePath('unsafe\nname.py'));
    assert.throws(() => safeRelativePath(`${'x'.repeat(256)}.py`));
    assert.throws(() => safeRelativePath('payload:stream.py'));
    assert.throws(() => safeRelativePath('CON.txt'));
    assert.throws(() => safeRelativePath('folder/trailing.'));
    assert.throws(() => safeRelativePath('folder/../alias.py'));
    assert.equal(safeRelativePath('..notes.py'), path.normalize('..notes.py'));
    assert.equal(safeRelativePath('src/a.py'), path.normalize('src/a.py'));
  });

  it('refuses to persist through a symbolic-link parent', async function () {
    const outside = path.join(root, 'outside');
    await Promise.all([
      mkdir(working, { recursive: true }),
      mkdir(backing, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    try {
      await symlink(outside, path.join(backing, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        this.skip();
        return;
      }
      throw error;
    }
    const adapter = new StorageAdapter({
      workingRoot: working,
      backingRoot: backing,
      debounceMs: 10,
      serialize: async () => Buffer.from('x'),
    });
    adapter.on('operationError', () => undefined);
    await assert.rejects(adapter.mirrorBinary('linked/escaped.bin', Buffer.from('blocked')), /symbolic link/i);
    await assert.rejects(stat(path.join(outside, 'escaped.bin')));
    await adapter.stop(false);
  });

  it('keeps empty directories and atomically moves a nested file in both roots', async () => {
    const adapter = new StorageAdapter({ workingRoot: working, backingRoot: backing, debounceMs: 10, serialize: async () => Buffer.from('x') });
    await adapter.createDirectory('empty/nested');
    await adapter.mirrorBinary('old/data.bin', Buffer.from('payload'));
    await adapter.rename('old', 'moved');
    assert.equal((await stat(path.join(working, 'empty/nested'))).isDirectory(), true);
    assert.equal(await readFile(path.join(working, 'moved/data.bin'), 'utf8'), 'payload');
    assert.equal(await readFile(path.join(backing, 'moved/data.bin'), 'utf8'), 'payload');
    await assert.rejects(stat(path.join(working, 'old/data.bin')));
    await adapter.stop(false);
  });
});

describe('per-notebook execution queues', () => {
  it('serializes one notebook while allowing another notebook to run independently', async () => {
    const queue = new PerNotebookExecutionQueue();
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const firstA = queue.enqueue('a.ipynb', async () => {
      events.push('a1:start');
      await gateA;
      events.push('a1:end');
    });
    const secondA = queue.enqueue('a.ipynb', async () => { events.push('a2'); });
    const firstB = queue.enqueue('b.ipynb', async () => { events.push('b1'); });
    await firstB;
    assert.deepEqual(events, ['a1:start', 'b1']);
    releaseA();
    await Promise.all([firstA, secondA]);
    assert.deepEqual(events, ['a1:start', 'b1', 'a1:end', 'a2']);
  });

  it('rejects an unbounded backlog per notebook', async () => {
    const queue = new PerNotebookExecutionQueue(1, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.enqueue('bounded.ipynb', async () => gate);
    await assert.rejects(
      queue.enqueue('bounded.ipynb', async () => undefined),
      /too many notebook executions/i,
    );
    release();
    await active;
    await assert.doesNotReject(queue.whenIdle('bounded.ipynb'));
  });
});

describe('compute launch and recent projects', () => {
  it('propagates the chosen interpreter and exact CUDA device to the bridge process', () => {
    const launch = kernelLaunchSpec('/envs/project/python', './media/jupyter_kernel_bridge.py', '/work/project', 3, {
      PATH: '/bin', CUDA_VISIBLE_DEVICES: 'old',
    });
    assert.equal(launch.command, '/envs/project/python');
    assert.equal(launch.cwd, '/work/project');
    assert.equal(launch.env.CUDA_VISIBLE_DEVICES, '3');
    assert.equal(launch.env.PAIR_NOTEBOOK_CWD, '/work/project');
    assert.match(launch.args[0] ?? '', /media[/\\]jupyter_kernel_bridge\.py$/);
  });

  it('deduplicates recent paths and removes inaccessible entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-recent-'));
    const available = path.join(root, 'available');
    const regularFile = path.join(root, 'not-a-folder.txt');
    await mkdir(available, { recursive: true });
    await writeFile(regularFile, 'not a project folder', 'utf8');
    try {
      const remembered = rememberRecentProject([
        { name: 'old duplicate', workingFolder: available, at: 1 },
        { name: 'missing', workingFolder: path.join(root, 'missing'), at: 2 },
      ], { name: 'current', workingFolder: `${available}${path.sep}`, at: 3 });
      assert.equal(remembered.filter((item) => path.resolve(item.workingFolder) === path.resolve(available)).length, 1);
      const accessible = await accessibleRecentProjects([
        ...remembered,
        { name: 'regular file', workingFolder: regularFile, at: 4 },
      ]);
      assert.deepEqual(accessible.map((item) => item.name), ['current']);
      assert.deepEqual(normalizeRecentProjects({ stale: true }), []);
      assert.deepEqual(normalizeRecentProjects([
        { name: ' valid ', workingFolder: available, at: 4 },
        { name: '', workingFolder: available, at: 5 },
        { name: 'unsafe', workingFolder: 'bad\npath', at: 6 },
      ]), [{ name: 'valid', workingFolder: available, at: 4 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates a bridge that emits an oversized protocol line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bridge-limit-'));
    const bridge = path.join(root, 'oversized-bridge.js');
    await writeFile(bridge, "process.stdout.write('x'.repeat(32 * 1024 * 1024 + 1)); setTimeout(() => {}, 30000);\n", 'utf8');
    const kernel = new PythonKernel(process.execPath, bridge, root, undefined);
    try {
      await assert.rejects(kernel.start(), /32 MiB safety limit/i);
    } finally {
      kernel.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not let a stopped bridge exit clear a replacement process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bridge-restart-race-'));
    const bridge = path.join(root, 'restartable-bridge.js');
    await writeFile(bridge, [
      "const readline = require('node:readline');",
      "process.stdout.write(JSON.stringify({type:'ready',pythonExecutable:process.execPath,kernelInfo:{}})+'\\n');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      " const message = JSON.parse(line);",
      " if (message.command === 'shutdown') setTimeout(() => process.exit(0), 150);",
      " if (message.command === 'execute') process.stdout.write(JSON.stringify({type:'complete',requestId:message.requestId,success:true,content:{status:'ok'}})+'\\n');",
      "});",
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');
    const kernel = new PythonKernel(process.execPath, bridge, root);
    let unexpectedExits = 0;
    kernel.on('exit', () => { unexpectedExits += 1; });
    try {
      await kernel.start();
      kernel.stop();
      await kernel.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(unexpectedExits, 0, 'the retired child is no longer the active bridge');
      assert.equal((await kernel.execute('replacement-execution', '1 + 1')).success, true);
    } finally {
      kernel.stop();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('protocol and notebook compatibility', () => {
  it('round-trips binary wire frames without JSON-encoding the payload', () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const decoded = decodeFrame(encodeFrame('update', { key: 'a.py' }, bytes));
    assert.equal(decoded.type, 'update');
    assert.equal(decoded.meta.key, 'a.py');
    assert.deepEqual(Buffer.from(decoded.payload), bytes);
  });

  it('rejects malformed or oversized wire frames before allocating their payload', () => {
    assert.throws(() => encodeFrame('bad type', {}), /frame type/i);
    assert.throws(
      () => encodeFrame('probe', { oversized: 'x'.repeat(MAX_WIRE_HEADER_BYTES) }),
      /header is too large/i,
    );
    assert.throws(
      () => decodeFrame({ byteLength: MAX_WIRE_FRAME_BYTES + 1 } as unknown as ArrayBuffer),
      /wire size limit/i,
    );
  });

  it('declares safe workspace defaults and no remote-compute deny switches', async () => {
    const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8')) as any;
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
    assert.equal(manifest.devDependencies['@types/vscode'], manifest.engines.vscode.replace(/^\^/, ''));
    assert.equal(manifest.contributes.configuration.properties['pairNotebook.allowRemoteCompute'], undefined);
    assert.equal(manifest.contributes.configuration.properties['pairNotebook.allowCpu'], undefined);
    assert.equal(manifest.contributes.configuration.properties['pairNotebook.allowGpu'], undefined);
    assert.equal(
      manifest.contributes.commands.some((command: { command: string }) => command.command === 'pairNotebook.allowRemoteCompute'),
      false,
    );
    assert.equal(manifest.contributes.configuration.properties['pairNotebook.pythonPath'].scope, 'machine');
    const proxySetting = manifest.contributes.configuration.properties['pairNotebook.proxyUrl'];
    const proxyPattern = new RegExp(proxySetting.pattern);
    assert.equal(proxySetting.scope, 'machine');
    assert.equal(proxyPattern.test('http://alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('ftp://alice:secret@proxy.local:21'), false);
    assert.equal(proxyPattern.test('//alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('ht^tp:/alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('opaque:/alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('opaque:/decoy@alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('//decoy@alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('invalid@alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('alice:/secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test(' http://alice:secret@proxy.local:3128'), false);
    assert.equal(proxyPattern.test('http://alice@proxy.local:3128'), true);
    assert.equal(proxyPattern.test('SOCKS5H://alice@[::1]:1080/'), true);
    assert.equal(proxyPattern.test('http://alice@host/' + 'a:'.repeat(50_000)), false);
    assert.ok(manifest.contributes.commands.some(
      (command: { command?: string }) => command.command === 'pairNotebook.setProxyPassword',
    ));
  });

  it('round-trips a compatible ipynb with stable cell IDs and outputs', () => {
    const raw = JSON.stringify({
      cells: [{ cell_type: 'code', id: 'stable', metadata: {}, source: ['print(1)\n'], execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    });
    const parsed = parseIpynb(raw);
    const restored = JSON.parse(Buffer.from(serializeIpynb(parsed)).toString('utf8')) as any;
    assert.equal(restored.cells[0].id, 'stable');
    assert.equal(restored.cells[0].source.join(''), 'print(1)\n');
    assert.equal(restored.cells[0].outputs[0].text.join(''), '1\n');
  });

  it('rejects malformed notebook roots and cell entries with actionable errors', () => {
    assert.throws(() => parseIpynb('null'), /root must be a JSON object/i);
    assert.throws(() => parseIpynb('[]'), /root must be a JSON object/i);
    assert.throws(
      () => parseIpynb(JSON.stringify({ cells: [null], metadata: {}, nbformat: 4, nbformat_minor: 5 })),
      /cell 1 must be a JSON object/i,
    );
  });

  it('repairs duplicate and invalid ipynb cell ids before creating CRDT state', () => {
    const parsed = parseIpynb(JSON.stringify({
      cells: [
        { cell_type: 'code', id: 'duplicate', metadata: {}, source: [], outputs: [] },
        { cell_type: 'code', id: 'duplicate', metadata: {}, source: [], outputs: [] },
        { cell_type: 'markdown', id: 'invalid id!', metadata: {}, source: [] },
      ],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }));
    const ids = parsed.cells.map((cell) => cell.id);
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)));
    const project = new CollaborativeProject();
    assert.doesNotThrow(() => project.ensureNotebook('repaired.ipynb', parsed));
    project.destroy();
  });

  it('round-trips HTML, JSON, raw image bytes, and execution count without flattening MIME data', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const raw = JSON.stringify({
      cells: [{
        cell_type: 'code', id: 'rich', metadata: {}, source: ['2 + 3'], execution_count: 7,
        outputs: [{
          output_type: 'execute_result', execution_count: 7, metadata: { pair: true },
          data: {
            'text/html': ['<b>PAIR</b>'],
            'application/json': { value: 5 },
            'image/png': png.toString('base64'),
          },
        }],
      }],
      metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5,
    });
    const parsed = parseIpynb(raw);
    assert.equal(parsed.cells[0]!.execution?.executionOrder, 7);
    const image = parsed.cells[0]!.outputs[0]?.items.find((item) => item.mime === 'image/png');
    assert.deepEqual(Buffer.from(image?.dataBase64 ?? '', 'base64'), png);
    const restored = JSON.parse(Buffer.from(serializeIpynb(parsed)).toString('utf8')) as any;
    assert.equal(restored.cells[0].execution_count, 7);
    assert.equal(restored.cells[0].outputs[0].data['text/html'].join(''), '<b>PAIR</b>');
    assert.deepEqual(restored.cells[0].outputs[0].data['application/json'], { value: 5 });
    assert.equal(restored.cells[0].outputs[0].data['image/png'], png.toString('base64'));
  });

  it('keeps canonical notebook fields authoritative over untrusted preserved extras', () => {
    const snapshot: NotebookSnapshot = {
      metadata: {
        pairNotebookNbformat: {
          nbformat: 4,
          nbformat_minor: 5,
          extra: { cells: [], metadata: { replaced: true }, nbformat: 1 },
        },
      },
      cells: [{
        id: 'safe-cell',
        kind: 2,
        language: 'python',
        source: 'print("safe")',
        metadata: {
          pairNotebookNbformat: {
            cellType: 'code',
            extra: { id: 'forged', cell_type: 'raw', source: ['forged'] },
          },
        },
        outputs: [{
          metadata: { outputType: 'error' },
          items: [{
            mime: 'application/vnd.code.notebook.error',
            dataBase64: Buffer.from(JSON.stringify({ name: 7, message: {}, stack: 9 })).toString('base64'),
          }],
        }],
      }],
    };
    const restored = JSON.parse(Buffer.from(serializeIpynb(snapshot)).toString('utf8')) as any;
    assert.equal(restored.nbformat, 4);
    assert.equal(restored.cells.length, 1);
    assert.equal(restored.cells[0].id, 'safe-cell');
    assert.equal(restored.cells[0].cell_type, 'code');
    assert.equal(restored.cells[0].source.join(''), 'print("safe")');
    assert.equal(restored.cells[0].outputs[0].ename, 'Error');
    assert.deepEqual(restored.cells[0].outputs[0].traceback, []);
  });

  it('rejects oversized notebook collections before constructing CRDT snapshots', () => {
    const cells = Array.from({ length: MAX_NOTEBOOK_CELLS + 1 }, (_value, index) => ({
      cell_type: 'code', id: `cell-${index}`, metadata: {}, source: [], outputs: [], execution_count: null,
    }));
    assert.throws(() => parseIpynb(JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 })), /cell limit/i);
    const outputs = Array.from({ length: MAX_CELL_OUTPUTS + 1 }, () => ({
      output_type: 'stream', name: 'stdout', text: ['x'],
    }));
    assert.throws(() => parseIpynb(JSON.stringify({
      cells: [{ cell_type: 'code', id: 'cell', metadata: {}, source: [], outputs }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    })), /output limit/i);
  });

  it('round-trips an authenticated invite', () => {
    const encoded = formatInvite({
      sessionId: 'session', projectId: 'project', projectName: 'Demo project', mode: 'resilient',
      token: 'abcdefghijklmnopqrstuvwxyz1234567890', sessionEpoch: 123, hostPeerId: 'host-id', hostDisplayName: 'Alice',
      hostIdentityKey: TEST_IDENTITY_PUBLIC_KEY,
    });
    const decoded = parseInvite(encoded);
    assert.equal(decoded.hostPeerId, 'host-id');
    assert.equal(decoded.hostDisplayName, 'Alice');
    assert.equal(decoded.hostIdentityKey, TEST_IDENTITY_PUBLIC_KEY);
    assert.equal(decoded.projectName, 'Demo project');
    assert.equal(decoded.mode, 'resilient');
  });

  it('rejects invite userinfo and fragments outside the signed room parameters', () => {
    const encoded = formatInvite({
      sessionId: 'session', projectId: 'project', projectName: 'Demo project', mode: 'resilient',
      token: 'abcdefghijklmnopqrstuvwxyz1234567890', sessionEpoch: 123, hostPeerId: 'host-id', hostDisplayName: 'Alice',
      hostIdentityKey: TEST_IDENTITY_PUBLIC_KEY,
    });
    assert.throws(() => parseInvite(encoded.replace('://', '://user@')), /address/i);
    assert.throws(() => parseInvite(`${encoded}#ignored`), /address/i);
  });

  it('does not expose a machine address or port in Trystero invites', () => {
    const encoded = formatInvite({
      sessionId: 'session', projectId: 'project', projectName: 'Demo project', mode: 'resilient',
      token: 'abcdefghijklmnopqrstuvwxyz1234567890', sessionEpoch: 123, hostPeerId: 'host-id', hostDisplayName: 'Host',
      hostIdentityKey: TEST_IDENTITY_PUBLIC_KEY,
    });
    assert.doesNotMatch(encoded, /127\.0\.0\.1|100\.64\.|host\.tailnet|:\d{2,5}/);
  });

  it('ships a syntactically valid real Jupyter bridge', async () => {
    const bridge = path.resolve(__dirname, '../../media/jupyter_kernel_bridge.py');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    await execFileAsync(python, ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")', bridge], { timeout: 5000 });
  });

  it('runs bridge correlation regression tests without Jupyter dependencies', async () => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const suite = path.resolve(__dirname, '../../test/jupyter_bridge_unit.py');
    const { stdout, stderr } = await execFileAsync(python, [suite], { timeout: 5000 });
    assert.match(`${stdout}${stderr}`, /OK/);
  });
});

describe('real transport and compute', () => {
  it('installs its bundled WebSocket polyfill on older VS Code Node runtimes', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    const roomFactory = createInMemoryTrysteroFactory();
    const transport = new MeshTransport({
      sessionId: 'websocket-polyfill',
      token: 'websocket-polyfill-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }),
      isHost: () => true,
      roomFactory,
    });
    try {
      Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true });
      await transport.start();
      assert.equal(typeof globalThis.WebSocket, 'function');
    } finally {
      await transport.stop();
      if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
      resetInMemoryTrystero();
    }
  });

  it('passes curated Nostr relays without advertising dead built-in TURN', async () => {
    const capturedConfigs: unknown[] = [];
    const inMemoryFactory = createInMemoryTrysteroFactory();
    const transport = new MeshTransport({
      sessionId: 'ice-fallback',
      token: 'ice-fallback-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }),
      isHost: () => true,
      roomFactory: (config, roomId, callbacks) => {
        capturedConfigs.push(config);
        return inMemoryFactory(config, roomId, callbacks);
      },
    });
    try {
      await transport.start();
      assert.equal(capturedConfigs.length, 1);
      const config = capturedConfigs[0] as {
        relayConfig?: { urls?: string[]; redundancy?: number };
        turnConfig?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
      };
      assert.deepEqual(config.relayConfig?.urls, TRYSTERO_RELAY_URLS);
      assert.ok((config.relayConfig?.redundancy ?? 0) >= 2);
      assert.equal(TRYSTERO_TURN_SERVERS.length, 0);
      assert.equal(config.turnConfig, undefined);
      const diagnostics = transport.networkDiagnostics() as {
        turnStatus?: string;
        turnEndpoints?: unknown[];
        udpAvailability?: { state?: string };
      };
      assert.equal(diagnostics.turnStatus, 'not-configured');
      assert.deepEqual(diagnostics.turnEndpoints, []);
      assert.equal(diagnostics.udpAvailability?.state, 'unknown');
    } finally {
      await transport.stop();
      resetInMemoryTrystero();
    }
  });

  it('sends an incremental binary update over two Trystero room peers', async () => {
    const roomFactory = createInMemoryTrysteroFactory();
    const token = 'test-token-that-is-long-enough-for-session';
    const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
    const hostPeer: PeerIdentity = { peerId: 'host', displayName: 'Host', joinOrder: 0 };
    const peer: PeerIdentity = { peerId: 'peer', displayName: 'Peer', joinOrder: 1 };
    const host = new MeshTransport({ sessionId: 'test', token, localPeer: hostPeer, hostClock: () => clock, isHost: () => true, roomFactory });
    const client = new MeshTransport({ sessionId: 'test', token, localPeer: peer, hostClock: () => clock, isHost: () => false, roomFactory });
    try {
      await host.start();
      await client.start();
      const received = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('transport timeout')), 5000);
        host.on('message', (frame) => {
          if (frame.type === 'projectUpdate') {
            clearTimeout(timer);
            resolve(Buffer.from(frame.payload));
          }
        });
      });
      await onceEvent(client, 'peerConnected');
      client.broadcast('projectUpdate', { key: 'a.py', kind: 'text' }, Buffer.from([9, 8, 7]));
      assert.deepEqual(await received, Buffer.from([9, 8, 7]));
    } finally {
      await Promise.all([host.stop(), client.stop()]);
      resetInMemoryTrystero();
    }
  });

  it('carries large execution output through the real MeshTransport payload path', async () => {
    const roomFactory = createInMemoryTrysteroFactory();
    const token = 'large-output-token-that-is-long-enough';
    const clock: HostClock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
    const host = new MeshTransport({
      sessionId: 'large-output-mesh', token,
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true, roomFactory,
    });
    const client = new MeshTransport({
      sessionId: 'large-output-mesh', token,
      localPeer: { peerId: 'peer', displayName: 'Peer', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false, roomFactory,
    });
    const payload = Buffer.alloc(5 * 1024 * 1024, 0x5a);
    try {
      await host.start();
      await client.start();
      const received = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('large execution payload timed out')), 10_000);
        host.on('message', (frame) => {
          if (frame.type !== 'executionEvent') return;
          clearTimeout(timer);
          resolve(Buffer.from(frame.payload));
        });
      });
      await onceEvent(client, 'peerConnected');
      client.sendTo('host', 'executionEvent', { requestId: 'large-output', eventSequence: 0 }, payload);
      assert.deepEqual(await received, payload);
    } finally {
      await Promise.all([host.stop(), client.stop()]);
      resetInMemoryTrystero();
    }
  });

  it('isolates password-protected rooms, deduplicates packets, and reconnects', async function () {
    this.timeout(15_000);
    const roomFactory = createInMemoryTrysteroFactory();
    const token = 'test-token-that-is-long-enough-for-session';
    const clock: HostClock = { sessionEpoch: 2, hostEpoch: 0, hostId: 'host' };
    const hostPeer: PeerIdentity = { peerId: 'host', displayName: 'Host', joinOrder: 0 };
    const peer: PeerIdentity = { peerId: 'peer-z', displayName: 'Peer', joinOrder: 1 };
    const strangerPeer: PeerIdentity = { peerId: 'stranger', displayName: 'Stranger', joinOrder: 2 };
    const host = new MeshTransport({
      sessionId: 'room-security', token, localPeer: hostPeer, hostClock: () => clock,
      isHost: () => true, roomFactory, logicalPeerRecoveryMs: 25,
    });
    const client = new MeshTransport({
      sessionId: 'room-security', token, localPeer: peer, hostClock: () => clock,
      isHost: () => false, roomFactory, logicalPeerRecoveryMs: 25,
    });
    const stranger = new MeshTransport({
      sessionId: 'room-security', token: 'different-password-that-is-long-enough-123', localPeer: strangerPeer,
      hostClock: () => clock, isHost: () => false, roomFactory,
    });
    try {
      await host.start();
      await client.start();
      await stranger.start();
      await onceEvent(client, 'peerConnected', 15_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(host.peerRuntime().some((entry) => entry.peerId === 'stranger'), false);

      let delivered = 0;
      host.on('message', (frame) => { if (frame.type === 'duplicateProbe') delivered += 1; });
      client.sendTo('host', 'duplicateProbe', { messageId: 'same-message' }, Buffer.from('one'));
      client.sendTo('host', 'duplicateProbe', { messageId: 'same-message' }, Buffer.from('one'));
      await waitFor(() => delivered === 1, 3000, 'deduplicated delivery');

      const disconnected = onceEvent(client, 'peerDisconnected', 10_000);
      await host.stop();
      await disconnected;
      const reconnected = onceEvent(client, 'peerConnected', 15_000);
      await host.start();
      await reconnected;
      const message = onceFrame(host, 'afterReconnect');
      client.sendTo('host', 'afterReconnect', {}, Buffer.from('restored'));
      assert.equal(Buffer.from((await message).payload).toString('utf8'), 'restored');
    } finally {
      await Promise.all([host.stop(), client.stop(), stranger.stop()]);
      resetInMemoryTrystero();
    }
  });

  it('executes stdout, rich output, stdin, interrupt, and restart through a real Jupyter kernel when the environment permits it', async function () {
    this.timeout(90_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-python-'));
    const bridge = path.resolve(__dirname, '../../media/jupyter_kernel_bridge.py');
    const python = process.env.PAIR_NOTEBOOK_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    let expectedPython = '';
    try {
      const probe = await execFileAsync(python, ['-c', 'import sys,jupyter_client,ipykernel; print(sys.executable)'], { timeout: 5000 });
      expectedPython = probe.stdout.trim();
    } catch (error) {
      console.warn(`[jupyter capability] BLOCKED: selected interpreter cannot import jupyter_client and ipykernel: ${String(error)}`);
      await rm(root, { recursive: true, force: true });
      this.skip();
      return;
    }
    const kernel = new PythonKernel(python, bridge, root, 3);
    const events: Array<{ requestId?: string; messageType?: string; content?: Record<string, any> }> = [];
    kernel.on('event', (event) => events.push(event));
    try {
      let ready;
      try {
        ready = await kernel.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Operation not permitted|Permission denied|\bEPERM\b|\bEACCES\b/i.test(message)) {
          console.warn(`[jupyter capability] BLOCKED: kernel subprocess started but ZeroMQ/socket setup was denied: ${message}`);
          this.skip();
          return;
        }
        throw error;
      }
      assert.equal(await realpath(ready.pythonExecutable), await realpath(expectedPython));
      const first = await kernel.execute('one', 'import os\nprint("PAIR_TEST")\nprint("CUDA=" + str(os.environ.get("CUDA_VISIBLE_DEVICES")))\n2 + 3');
      const second = await kernel.execute('two', 'from IPython.display import HTML\nHTML("<b>PAIR</b>")');
      const largeRich = await kernel.execute(
        'large-rich',
        'from IPython.display import display\ndisplay({"text/plain": "x" * (1024 * 1024 + 256)}, raw=True)',
      );
      assert.equal(first.success, true);
      assert.equal(second.success, true);
      assert.equal(largeRich.success, true);
      assert.ok(events.some((event) => event.requestId === 'one' && event.messageType === 'stream' && String(event.content?.text).includes('PAIR_TEST')));
      assert.ok(events.some((event) => event.requestId === 'one' && event.messageType === 'stream' && String(event.content?.text).includes('CUDA=3')));
      assert.ok(events.some((event) => event.requestId === 'one' && event.messageType === 'execute_result'
        && String((event.content?.data as Record<string, unknown> | undefined)?.['text/plain']).trim() === '5'));
      assert.ok(events.some((event) => event.requestId === 'two' && event.messageType === 'execute_result'
        && String((event.content?.data as Record<string, unknown> | undefined)?.['text/html']).includes('<b>PAIR</b>')));
      assert.ok(events.some((event) => event.requestId === 'large-rich' && event.messageType === 'display_data'
        && String((event.content?.data as Record<string, unknown> | undefined)?.['text/plain']).length > 1024 * 1024));

      const inputRequest = onceKernelEvent(kernel, (event) => event.type === 'inputRequest' && event.requestId === 'stdin');
      const stdinExecution = kernel.execute('stdin', 'name = input("Name: ")\nprint(name)');
      await inputRequest;
      kernel.inputReply('PAIR_INPUT');
      assert.equal((await stdinExecution).success, true);
      assert.ok(events.some((event) => event.requestId === 'stdin' && event.messageType === 'stream'
        && String(event.content?.text).includes('PAIR_INPUT')));

      const accepted = onceKernelEvent(kernel, (event) => event.type === 'accepted' && event.requestId === 'interrupt');
      const sleeping = kernel.execute('interrupt', 'import time\ntime.sleep(30)');
      await accepted;
      await kernel.interrupt();
      assert.equal((await sleeping).success, false);

      assert.equal((await kernel.execute('set-state', 'x = 123')).success, true);
      await kernel.restart();
      assert.equal((await kernel.execute('cleared-state', 'x')).success, false);
      assert.equal((await kernel.execute('after-restart', '2 + 3')).success, true);
    } finally {
      kernel.stop();
      // On Windows the kernel process still holds the working directory for a
      // moment after shutdown, so removal needs bounded retries instead of
      // failing the test with EBUSY.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

    }
  });
});

function pairedTextProjects(initial: string): [CollaborativeProject, CollaborativeProject] {
  const a = new CollaborativeProject();
  const b = new CollaborativeProject();
  a.ensureText('a.py', initial);
  b.applyRemoteUpdate('a.py', 'text', a.encodeUpdate('a.py'));
  return [a, b];
}

function pairedNotebookProjects(): [CollaborativeProject, CollaborativeProject] {
  const a = new CollaborativeProject();
  const b = new CollaborativeProject();
  a.ensureNotebook('article.ipynb', notebook);
  b.applyRemoteUpdate('article.ipynb', 'notebook', a.encodeUpdate('article.ipynb'));
  return [a, b];
}

function captureLocalUpdates(project: CollaborativeProject): Uint8Array[] {
  const updates: Uint8Array[] = [];
  project.on('update', (event: ProjectUpdate) => { if (event.origin !== REMOTE_ORIGIN) updates.push(event.update); });
  return updates;
}

function exchange(
  a: CollaborativeProject,
  b: CollaborativeProject,
  updatesA: Uint8Array[],
  updatesB: Uint8Array[],
  key: string,
  kind: 'text' | 'notebook',
): void {
  for (const update of updatesA) b.applyRemoteUpdate(key, kind, update);
  for (const update of updatesB) a.applyRemoteUpdate(key, kind, update);
}

function peerRuntime(peerId: string, joinOrder: number, online = true): PeerRuntime {
  return {
    peerId,
    displayName: peerId,
    joinOrder,
    latency: 1,
    latencyEma: 1,
    lastHeartbeat: Date.now(),
    missedHeartbeats: 0,
    route: 'Direct',
    online,
  };
}

function coordinatorFor(mode: 'host-only' | 'resilient', selfId = 'peer-b'): SessionCoordinator {
  const coordinator = new SessionCoordinator({
    selfId,
    mode,
    clock: { sessionEpoch: 10, hostEpoch: 3, hostId: 'host-a' },
    heartbeatTimeoutMs: 1000,
  });
  coordinator.upsertPeer(peerRuntime('host-a', 0));
  coordinator.upsertPeer(peerRuntime('peer-b', 1));
  coordinator.upsertPeer(peerRuntime('peer-c', 2));
  return coordinator;
}

function onceEvent(emitter: NodeJS.EventEmitter, event: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`event ${event} timeout`)), timeoutMs);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function onceFrame(emitter: NodeJS.EventEmitter, type: string): Promise<{ payload: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frame ${type} timeout`)), 5000);
    const listener = (frame: { type?: string; payload: Uint8Array }) => {
      if (frame.type !== type) return;
      clearTimeout(timer);
      emitter.off('message', listener);
      resolve(frame);
    };
    emitter.on('message', listener);
  });
}

function onceKernelEvent(
  kernel: PythonKernel,
  predicate: (event: JupyterKernelEvent) => boolean,
): Promise<JupyterKernelEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kernel.off('event', listener);
      reject(new Error('Jupyter event timeout'));
    }, 10_000);
    const listener = (event: JupyterKernelEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      kernel.off('event', listener);
      resolve(event);
    };
    kernel.on('event', listener);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}


describe('reconnectable Recent Sessions', () => {
  it('persists session and original host identity without storing reconnect secrets', () => {
    const hostKey = generateIdentityCredentials().publicKey;
    const descriptor: any = {
      sessionId: 'recent-session',
      projectId: 'project',
      projectName: 'Recent project',
      mode: 'resilient',
      role: 'peer',
      localPeer: { peerId: 'guest', displayName: 'Guest', joinOrder: 1 },
      hostPeerId: 'original-host',
      backingFolder: '',
      workingFolder: path.join(os.tmpdir(), 'pair-recent-session'),
      createdAt: 1,
      sessionEpoch: 42,
      hostEpoch: 7,
      computeExecutorId: 'original-host',
      pythonPath: 'python',
      knownPeers: [{
        peerId: 'original-host', displayName: 'Host', joinOrder: 0, identityKey: hostKey,
      }],
    };
    const reconnect = reconnectIdentityFromDescriptor(descriptor);
    assert.deepEqual(reconnect, {
      sessionId: 'recent-session',
      localPeerId: 'guest',
      hostPeerId: 'original-host',
      hostIdentityKey: hostKey,
      role: 'peer',
      sessionEpoch: 42,
      hostEpoch: 7,
    });

    const normalized = normalizeRecentProjects([{
      name: 'Recent project',
      workingFolder: descriptor.workingFolder,
      at: 123,
      reconnect,
      token: 'must-not-survive',
      identityPrivateKey: 'must-not-survive',
      transportPeerId: 'must-not-survive',
    }]);
    assert.equal(normalized.length, 1);
    assert.deepEqual(normalized[0]?.reconnect, reconnect);
    assert.equal('token' in (normalized[0] as any), false);
    assert.equal('identityPrivateKey' in (normalized[0] as any), false);
    assert.equal('transportPeerId' in (normalized[0] as any), false);
    assertRecentReconnectMatchesDescriptor(reconnect!, descriptor);

    const remembered = rememberRecentProject([], normalized[0]!);
    assert.equal(remembered[0]?.reconnect?.sessionId, 'recent-session');
    assert.equal(remembered[0]?.reconnect?.hostPeerId, 'original-host');
    assert.equal(remembered[0]?.reconnect?.hostEpoch, 7);
    const rememberedEntry = remembered[0]!;
    const leftProject = clearRecentReconnect(remembered, descriptor.workingFolder);
    assert.equal(leftProject.length, 1, 'explicit Leave keeps the Recent Project entry');
    assert.equal(leftProject[0]?.reconnect, undefined, 'explicit Leave removes reconnect semantics');
    assert.notEqual(leftProject[0], rememberedEntry, 'reconnect cleanup returns a new immutable Recent Project value');
    assert.deepEqual(rememberedEntry.reconnect, reconnect, 'reconnect cleanup never mutates the remembered source entry');
    assert.equal(forgetRecentProject(remembered, descriptor.workingFolder).length, 0);
  });

  it('rejects a Recent Session marker whose pinned host identity changed', () => {
    const original = generateIdentityCredentials().publicKey;
    const substitute = generateIdentityCredentials().publicKey;
    const descriptor: any = {
      sessionId: 'recent-substitute',
      role: 'peer',
      localPeer: { peerId: 'guest', displayName: 'Guest', joinOrder: 1 },
      hostPeerId: 'host',
      sessionEpoch: 9,
      hostEpoch: 3,
      knownPeers: [{ peerId: 'host', displayName: 'Host', joinOrder: 0, identityKey: substitute }],
    };
    assert.throws(() => assertRecentReconnectMatchesDescriptor({
      sessionId: 'recent-substitute',
      localPeerId: 'guest',
      hostPeerId: 'host',
      hostIdentityKey: original,
      role: 'peer',
      sessionEpoch: 9,
      hostEpoch: 3,
    }, descriptor), /pinned original host identity/i);
  });

  it('rejects a substitute key for an already pinned logical host inside MeshTransport', () => {
    const original = generateIdentityCredentials();
    const substitute = generateIdentityCredentials();
    const transport = new MeshTransport({
      sessionId: 'pinned-host-reconnect',
      token: 'pinned-host-reconnect-token-that-is-long-enough',
      localPeer: { peerId: 'guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }),
      isHost: () => false,
    });
    transport.updateDirectory([{
      peerId: 'host', displayName: 'Host', joinOrder: 0, identityKey: original.publicKey,
    }]);
    assert.throws(() => (transport as any).assertPeerCanJoin({
      peerId: 'host', displayName: 'Fake Host', joinOrder: 0, identityKey: substitute.publicKey,
    }, 'transport-host'), /different identity key/i);
  });
});
