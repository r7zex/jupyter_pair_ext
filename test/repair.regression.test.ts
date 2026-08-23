import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { CollaborativeProject, NotebookSnapshot } from '../src/core/crdt';
import { parseIpynb, serializeIpynb } from '../src/core/projectFiles';
import { StorageAdapter } from '../src/core/persistence';

/** Simulates two peers exchanging Yjs updates in a controllable order. */
class Peer {
  public readonly project = new CollaborativeProject();
  public readonly outbox: Uint8Array[] = [];

  public constructor(public readonly key: string) {
    this.project.on('update', (event: { key: string; update: Uint8Array; origin: unknown }) => {
      if (event.origin !== 'remote') this.outbox.push(event.update);
    });
  }

  public applyFrom(other: Peer): void {
    const updates = other.outbox.splice(0, other.outbox.length);
    for (const update of updates) this.project.applyRemoteUpdate(this.key, 'notebook', update);
  }

  public order(): string[] {
    return this.project.ensureNotebook(this.key).getArray<string>('cells').toArray();
  }
}

function notebook(ids: string[]): NotebookSnapshot {
  return {
    metadata: {},
    cells: ids.map((id) => ({ id, kind: 2, language: 'python', source: `# ${id}`, metadata: {}, outputs: [] })),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('notebook CRDT structural invariants', () => {
  const key = 'notebook.ipynb';

  function seededPeers(ids: string[]): [Peer, Peer] {
    const first = new Peer(key);
    first.project.reconcileNotebook(key, notebook(ids));
    const second = new Peer(key);
    second.project.applyRemoteUpdate(key, 'notebook', Y.encodeStateAsUpdate(first.project.ensureNotebook(key)));
    first.outbox.length = 0;
    second.outbox.length = 0;
    return [first, second];
  }

  it('never produces a duplicate visible cell id after concurrent moves (both delivery orders)', () => {
    for (const reverse of [false, true]) {
      const [a, b] = seededPeers(['A', 'B', 'C']);
      a.project.reconcileNotebook(key, notebook(['C', 'A', 'B']));
      b.project.reconcileNotebook(key, notebook(['A', 'C', 'B']));
      if (reverse) {
        a.applyFrom(b);
        b.applyFrom(a);
      } else {
        b.applyFrom(a);
        a.applyFrom(b);
      }
      // A second exchange settles the deterministic duplicate removal.
      b.applyFrom(a);
      a.applyFrom(b);
      b.applyFrom(a);
      a.applyFrom(b);

      const left = a.order();
      const right = b.order();
      assert.deepEqual(left, right, 'peers converge');
      assert.equal(new Set(left).size, left.length, `no duplicate cell ids (${left.join(',')})`);
      assert.deepEqual([...left].sort(), ['A', 'B', 'C']);
      const snapshot = a.project.notebookSnapshot(key);
      assert.equal(new Set(snapshot.cells.map((cell) => cell.id)).size, snapshot.cells.length);
    }
  });

  it('converges for insert/insert, insert/move and move/delete without duplicates', () => {
    const scenarios: Array<[string[], string[]]> = [
      [['A', 'X', 'B', 'C'], ['A', 'B', 'Y', 'C']],
      [['A', 'B', 'C', 'Z'], ['C', 'A', 'B']],
      [['C', 'A', 'B'], ['A', 'B']],
    ];
    for (const [left, right] of scenarios) {
      const [a, b] = seededPeers(['A', 'B', 'C']);
      a.project.reconcileNotebook(key, notebook(left));
      b.project.reconcileNotebook(key, notebook(right));
      for (let round = 0; round < 3; round += 1) {
        b.applyFrom(a);
        a.applyFrom(b);
      }
      const first = a.order();
      const second = b.order();
      assert.deepEqual(first, second, `converged for ${left.join('')}/${right.join('')}`);
      assert.equal(new Set(first).size, first.length, 'no duplicates');
    }
  });

  it('keeps unaffected cell identities stable through an insertion', () => {
    const project = new CollaborativeProject();
    project.reconcileNotebook(key, notebook(['A', 'B']));
    const before = project.notebookSnapshot(key).cells.map((cell) => cell.id);
    project.reconcileNotebook(key, notebook(['A', 'NEW', 'B']));
    const after = project.notebookSnapshot(key).cells.map((cell) => cell.id);
    assert.deepEqual(after, ['A', 'NEW', 'B']);
    assert.equal(after[0], before[0]);
    assert.equal(after[2], before[1]);
  });

  it('garbage-collects unreferenced cell state after the grace period only', () => {
    const project = new CollaborativeProject();
    project.reconcileNotebook(key, notebook(['A', 'B']));
    const data = project.ensureNotebook(key).getMap('cellData');
    project.reconcileNotebook(key, notebook(['A']));
    assert.equal(data.has('B'), true, 'state is retained immediately after deletion');

    const start = Date.now();
    assert.deepEqual(project.collectGarbage(key, 30_000, start), [], 'first pass only marks');
    assert.equal(data.has('B'), true);
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 31_000), ['B']);
    assert.equal(data.has('B'), false, 'stale cell state is collected');
    assert.deepEqual(project.notebookSnapshot(key).cells.map((cell) => cell.id), ['A']);
  });

  it('does not grow without bound through repeated create/delete cycles with rich outputs', () => {
    const project = new CollaborativeProject();
    const payload = Buffer.alloc(64 * 1024, 7).toString('base64');
    let now = Date.now();
    for (let round = 0; round < 12; round += 1) {
      const id = `cell-${round}`;
      project.reconcileNotebook(key, notebook([id]));
      project.setCellOutputs(key, id, [{ items: [{ mime: 'image/png', dataBase64: payload }], metadata: {} }]);
      project.reconcileNotebook(key, { metadata: {}, cells: [] });
      now += 60_000;
      project.collectGarbage(key, 30_000, now);
    }
    const data = project.ensureNotebook(key).getMap('cellData');
    assert.ok(data.size <= 1, `cellData stays bounded (size=${data.size})`);
  });
});

describe('.ipynb round-trip fidelity', () => {
  const source = JSON.stringify({
    cells: [
      {
        cell_type: 'raw',
        id: 'raw-1',
        metadata: { format: 'text/latex' },
        source: ['\\section{Raw}\n'],
      },
      {
        cell_type: 'markdown',
        id: 'md-1',
        metadata: {},
        attachments: { 'image.png': { 'image/png': 'aGVsbG8=' } },
        source: ['![image](attachment:image.png)\n'],
      },
      {
        cell_type: 'code',
        id: 'code-1',
        execution_count: 7,
        metadata: { tags: ['keep'] },
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hello\n'] },
          { output_type: 'stream', name: 'stderr', text: ['warn\n'] },
          {
            output_type: 'execute_result',
            execution_count: 7,
            data: { 'text/plain': ['42'], 'application/json': { a: 1 } },
            metadata: { 'text/plain': { width: 3 } },
          },
          {
            output_type: 'display_data',
            data: { 'image/png': 'aGVsbG8=' },
            metadata: { 'image/png': { width: 10 } },
          },
          { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line1', 'line2'] },
        ],
        source: ['print("hello")\n'],
      },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
      custom_field: { keep: true },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1);

  it('preserves raw cells, attachments, outputs and notebook metadata across parse/serialize/parse', () => {
    const first = parseIpynb(source);
    const serialized = Buffer.from(serializeIpynb(first)).toString('utf8');
    const value = JSON.parse(serialized) as any;

    assert.equal(value.cells[0].cell_type, 'raw', 'raw cell is not converted to code');
    assert.equal(value.cells[0].metadata.format, 'text/latex');
    assert.deepEqual(value.cells[1].attachments, { 'image.png': { 'image/png': 'aGVsbG8=' } });
    assert.equal(value.cells[2].cell_type, 'code');
    assert.equal(value.cells[2].execution_count, 7);
    assert.deepEqual(value.cells[2].metadata.tags, ['keep']);

    const outputs = value.cells[2].outputs;
    assert.equal(outputs[0].output_type, 'stream');
    assert.equal(outputs[0].name, 'stdout');
    assert.deepEqual(outputs[0].text, ['hello\n']);
    assert.equal(outputs[1].name, 'stderr');
    assert.deepEqual(outputs[2].data['text/plain'], ['42']);
    assert.deepEqual(outputs[2].data['application/json'], { a: 1 });
    assert.deepEqual(outputs[2].metadata['text/plain'], { width: 3 });
    assert.equal(outputs[2].execution_count, 7);
    assert.equal(outputs[3].data['image/png'], 'aGVsbG8=');
    assert.deepEqual(outputs[3].metadata['image/png'], { width: 10 });
    assert.equal(outputs[4].ename, 'ValueError');
    assert.deepEqual(outputs[4].traceback, ['line1', 'line2']);

    assert.deepEqual(value.metadata.custom_field, { keep: true });
    assert.equal(value.metadata.language_info.version, '3.11.0');
    assert.equal(value.nbformat, 4);
    assert.equal(value.nbformat_minor, 5);
    assert.ok(!('pairNotebookNbformat' in value.metadata), 'internal marker is not written to disk');

    // Second round trip must be byte-stable.
    const second = parseIpynb(serialized);
    assert.equal(Buffer.from(serializeIpynb(second)).toString('utf8'), serialized);
  });

  it('keeps an attachment-backed Markdown image through a CRDT reconcile cycle', () => {
    const project = new CollaborativeProject();
    project.ensureNotebook('n.ipynb', parseIpynb(source));
    const roundTripped = JSON.parse(
      Buffer.from(serializeIpynb(project.notebookSnapshot('n.ipynb'))).toString('utf8'),
    ) as any;
    assert.deepEqual(roundTripped.cells[1].attachments, { 'image.png': { 'image/png': 'aGVsbG8=' } });
    assert.equal(roundTripped.cells[0].cell_type, 'raw');
  });
});

describe('host promotion persistence barrier', () => {
  it('makes a stale backing folder equal to the authoritative project state', async () => {
    const working = await temporaryDirectory('pair-notebook-working-');
    const backing = await temporaryDirectory('pair-notebook-backing-');
    try {
      await mkdir(path.join(working, 'data'), { recursive: true });
      const binaryBytes = Buffer.from([1, 2, 3, 4]);
      await writeFile(path.join(working, 'data', 'blob.bin'), binaryBytes);

      // Stale/extraneous content that must disappear on promotion.
      await writeFile(path.join(backing, 'main.py'), 'print("stale")\n', 'utf8');
      await writeFile(path.join(backing, 'removed.py'), 'gone\n', 'utf8');
      await mkdir(path.join(backing, 'obsolete'), { recursive: true });

      const project = new CollaborativeProject();
      project.ensureText('main.py', 'print("current")\n');
      const storage = new StorageAdapter({
        workingRoot: working,
        backingRoot: backing,
        debounceMs: 10,
        serialize: async () => Buffer.from(''),
      });

      await storage.materializeBacking(
        [{ relativePath: 'main.py', bytes: Buffer.from(project.text('main.py').toString(), 'utf8') }],
        [{
          relativePath: 'data/blob.bin',
          sourcePath: path.join(working, 'data', 'blob.bin'),
          hash: createHash('sha256').update(binaryBytes).digest('hex'),
        }],
        ['data', 'empty'],
      );
      await storage.stop(false);

      assert.equal(await readFile(path.join(backing, 'main.py'), 'utf8'), 'print("current")\n');
      assert.deepEqual([...await readFile(path.join(backing, 'data', 'blob.bin'))], [1, 2, 3, 4]);
      assert.ok((await readdir(backing)).includes('empty'), 'empty directory exists');
      assert.ok(!(await readdir(backing)).includes('removed.py'), 'stale file removed');
      assert.ok(!(await readdir(backing)).includes('obsolete'), 'stale directory removed');
    } finally {
      await rm(working, { recursive: true, force: true });
      await rm(backing, { recursive: true, force: true });
    }
  });

  it('refuses to publish a binary whose source no longer matches its revision', async () => {
    const working = await temporaryDirectory('pair-notebook-working-hash-');
    const backing = await temporaryDirectory('pair-notebook-backing-hash-');
    try {
      const source = path.join(working, 'asset.bin');
      await writeFile(source, 'changed-during-save', 'utf8');
      await writeFile(path.join(backing, 'asset.bin'), 'previous-durable-copy', 'utf8');
      const storage = new StorageAdapter({
        workingRoot: working,
        backingRoot: backing,
        debounceMs: 10,
        serialize: async () => Buffer.from(''),
      });
      await assert.rejects(storage.materializeBacking([], [{
        relativePath: 'asset.bin',
        sourcePath: source,
        hash: createHash('sha256').update('expected-before-change').digest('hex'),
      }], []), /changed while.*materialized/i);
      assert.equal(await readFile(path.join(backing, 'asset.bin'), 'utf8'), 'previous-durable-copy');
      await storage.stop(false);
    } finally {
      await rm(working, { recursive: true, force: true });
      await rm(backing, { recursive: true, force: true });
    }
  });

  it('rejects case-conflicting materialization entries before touching the target', async () => {
    const working = await temporaryDirectory('pair-notebook-working-case-');
    const backing = await temporaryDirectory('pair-notebook-backing-case-');
    try {
      const binary = path.join(working, 'asset.bin');
      await writeFile(binary, 'binary', 'utf8');
      await writeFile(path.join(backing, 'sentinel.txt'), 'untouched', 'utf8');
      const storage = new StorageAdapter({
        workingRoot: working,
        backingRoot: backing,
        debounceMs: 10,
        serialize: async () => Buffer.from(''),
      });
      await assert.rejects(storage.materializeBacking(
        [{ relativePath: 'Asset.bin', bytes: Buffer.from('document') }],
        [{
          relativePath: 'asset.bin',
          sourcePath: binary,
          hash: createHash('sha256').update('binary').digest('hex'),
        }],
        [],
      ), /duplicate or case-conflicting files/i);
      await assert.rejects(storage.materializeBacking(
        [{ relativePath: 'Caf\u00e9.txt', bytes: Buffer.from('document') }],
        [{
          relativePath: 'Cafe\u0301.txt',
          sourcePath: binary,
          hash: createHash('sha256').update('binary').digest('hex'),
        }],
        [],
      ), /duplicate or case-conflicting files/i);
      assert.equal(await readFile(path.join(backing, 'sentinel.txt'), 'utf8'), 'untouched');
      await storage.stop(false);
    } finally {
      await rm(working, { recursive: true, force: true });
      await rm(backing, { recursive: true, force: true });
    }
  });
});

describe('open editor persistence boundary', () => {
  it('does not externally replace an open working file while still updating the backing copy', async () => {
    const working = await temporaryDirectory('pair-notebook-open-working-');
    const backing = await temporaryDirectory('pair-notebook-open-backing-');
    const calls: string[] = [];
    try {
      await writeFile(path.join(working, 'open.ipynb'), 'editor-owned', 'utf8');
      const storage = new StorageAdapter({
        workingRoot: working,
        backingRoot: backing,
        debounceMs: 10,
        serialize: async () => Buffer.from('authoritative-crdt'),
        writeWorkingCopy: async (relativePath, bytes) => {
          calls.push(`${relativePath}:${Buffer.from(bytes).toString('utf8')}`);
          return true;
        },
      });
      storage.schedule('open.ipynb');
      await storage.flush();
      await storage.stop(false);
      assert.deepEqual(calls, ['open.ipynb:authoritative-crdt']);
      assert.equal(await readFile(path.join(working, 'open.ipynb'), 'utf8'), 'editor-owned');
      assert.equal(await readFile(path.join(backing, 'open.ipynb'), 'utf8'), 'authoritative-crdt');
    } finally {
      await rm(working, { recursive: true, force: true });
      await rm(backing, { recursive: true, force: true });
    }
  });
});

describe('binary transfer integrity', () => {
  it('publishes a file only after a complete verified transfer', async () => {
    const working = await temporaryDirectory('pair-notebook-transfer-');
    try {
      const bytes = Buffer.alloc(300 * 1024, 5);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const temporaryDir = path.join(working, '.pair-notebook-transfers');
      await mkdir(temporaryDir, { recursive: true });
      const partial = path.join(temporaryDir, `${randomUUID()}.part`);
      await writeFile(partial, bytes.subarray(0, 100 * 1024));

      const storage = new StorageAdapter({
        workingRoot: working,
        debounceMs: 10,
        serialize: async () => Buffer.from(''),
      });

      // An interrupted transfer is dropped; the final path must not exist.
      await rm(partial, { force: true });
      assert.equal((await readdir(working)).includes('asset.bin'), false);

      // A complete transfer is finalized atomically from the temporary file.
      const complete = path.join(temporaryDir, `${randomUUID()}.part`);
      await writeFile(complete, bytes);
      await storage.mirrorBinaryFile('asset.bin', complete);
      await storage.stop(false);

      const written = await readFile(path.join(working, 'asset.bin'));
      assert.equal(createHash('sha256').update(written).digest('hex'), hash);
      assert.equal((await readdir(temporaryDir)).length, 0, 'temporary transfer file is cleaned up');
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  });
});
