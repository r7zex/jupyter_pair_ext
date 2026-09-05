import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { CollaborativeProject, ProjectUpdate, TextChange } from '../src/core/crdt';
import { REMOTE_ORIGIN } from '../src/core/types';

const vscodeBoundary = createVscodeBoundary();
const moduleWithLoader = Module as typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoader._load;
moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') return vscodeBoundary;
  return originalLoad.call(this, request, parent, isMain);
};
const syncModule = require.resolve('../src/vscode/sync');
delete require.cache[syncModule];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EditorSynchronizer } = require(syncModule) as { EditorSynchronizer: new (...args: any[]) => any };
moduleWithLoader._load = originalLoad;

describe('EditorSynchronizer multi-event echo stress', () => {
  for (const notebookCell of [false, true]) {
    it(`consumes a remote replacement split across multiple VS Code events in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: 'print(a',
        remoteChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 7, deleteCount: 0, insertText: ')' },
        ],
        eventChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 8, deleteCount: 0, insertText: ')' },
        ],
        intermediateTexts: ['#print(a', '#print(a)'],
        target: '#print(a)',
      });
    });

    it(`preserves typing after a multi-event remote echo exactly once in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: 'print(a',
        remoteChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 7, deleteCount: 0, insertText: '\n' },
        ],
        eventChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 8, deleteCount: 0, insertText: '\n' },
        ],
        intermediateTexts: ['#print(a', '#print(a\n'],
        target: '#print(a\n',
        localAfter: '!',
      });
    });

    it(`does not restore or join lines incorrectly when a remote newline deletion spans multiple events in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: '#x\nnext',
        remoteChanges: [
          { offset: 0, deleteCount: 0, insertText: '@' },
          { offset: 2, deleteCount: 1, insertText: '' },
        ],
        eventChanges: [
          { offset: 0, deleteCount: 0, insertText: '@' },
          { offset: 3, deleteCount: 1, insertText: '' },
        ],
        intermediateTexts: ['@#x\nnext', '@#xnext'],
        target: '@#xnext',
        localAfter: '!',
      });
    });
  }

  for (const notebookCell of [false, true]) {
    it(`accepts a successful remote echo even when the native document version jumps in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: 'abc',
        remoteChanges: [{ offset: 0, deleteCount: 0, insertText: 'R' }],
        eventChanges: [{ offset: 0, deleteCount: 0, insertText: 'R' }],
        intermediateTexts: ['Rabc'],
        target: 'Rabc',
        versionJump: 3,
      });
    });

    it(`preserves a local append when the successful remote target event is hidden in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: 'abc',
        remoteChanges: [{ offset: 0, deleteCount: 0, insertText: 'R' }],
        eventChanges: [],
        intermediateTexts: [],
        target: 'Rabc',
        hiddenLocalChange: { offset: 4, deleteCount: 0, insertText: '!' },
        expected: 'Rabc!',
        versionJump: 2,
      });
    });

    it(`preserves a hidden-target local newline insertion in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: 'onetwo',
        remoteChanges: [{ offset: 0, deleteCount: 0, insertText: '@' }],
        eventChanges: [],
        intermediateTexts: [],
        target: '@onetwo',
        hiddenLocalChange: { offset: 4, deleteCount: 0, insertText: '\n' },
        expected: '@one\ntwo',
        versionJump: 1,
      });
    });

    it(`preserves a hidden-target local newline deletion without rejected recovery in a ${notebookCell ? 'cell' : 'file'}`, async () => {
      await runScenario({
        notebookCell,
        initial: '#x\nnext',
        remoteChanges: [{ offset: 0, deleteCount: 0, insertText: '@' }],
        eventChanges: [],
        intermediateTexts: [],
        target: '@#x\nnext',
        hiddenLocalChange: { offset: 3, deleteCount: 1, insertText: '' },
        expected: '@#xnext',
        versionJump: 4,
      });
    });
  }

  it('survives repeated split-echo interleavings without duplicate CRDT publications', async () => {
    const inserts = [')', '\n', 'r'];
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const notebookCell = iteration % 2 === 0;
      const insert = inserts[iteration % inserts.length]!;
      const localAfter = iteration % 3 === 0 ? '!' : undefined;
      await runScenario({
        notebookCell,
        initial: 'print(a',
        remoteChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 7, deleteCount: 0, insertText: insert },
        ],
        eventChanges: [
          { offset: 0, deleteCount: 0, insertText: '#' },
          { offset: 8, deleteCount: 0, insertText: insert },
        ],
        intermediateTexts: ['#print(a', `#print(a${insert}`],
        target: `#print(a${insert}`,
        ...(localAfter !== undefined ? { localAfter } : {}),
      });
    }
  });
});

interface Scenario {
  notebookCell: boolean;
  initial: string;
  remoteChanges: TextChange[];
  eventChanges: TextChange[];
  intermediateTexts: string[];
  target: string;
  localAfter?: string;
  hiddenLocalChange?: TextChange;
  expected?: string;
  versionJump?: number;
}

async function runScenario(options: Scenario): Promise<void> {
  const root = path.resolve('/tmp/pair-editor-multi-event-stress');
  const notebook = fakeNotebook(root, [fakeCell(options.initial, 'a')]);
  const document = options.notebookCell
    ? notebook.cells[0].document
    : fakeTextDocument(path.join(root, 'notes.txt'), options.initial);
  if (options.notebookCell) vscodeBoundary.__reset(notebook);
  else vscodeBoundary.__resetText(document);

  const project = new CollaborativeProject();
  const peer = new CollaborativeProject();
  const synchronizer = new EditorSynchronizer(project, root, logger());
  const originalFire = vscodeBoundary.__fireTextChange;
  const localUpdates: ProjectUpdate[] = [];
  try {
    if (options.notebookCell) await synchronizer.whenNotebookReady(notebook);
    const key = options.notebookCell ? 'work.ipynb' : 'notes.txt';
    const kind = options.notebookCell ? 'notebook' : 'text';
    peer.applyRemoteUpdate(key, kind, project.encodeUpdate(key));
    if (options.notebookCell) peer.applyCellTextChanges(key, 'a', options.remoteChanges);
    else peer.applyTextChanges(key, options.remoteChanges);
    const remoteUpdate = peer.encodeUpdate(key);

    project.on('update', (event: ProjectUpdate) => {
      if (event.origin !== REMOTE_ORIGIN) localUpdates.push(event);
    });

    let split = false;
    vscodeBoundary.__fireTextChange = (changed: any, contentChanges: any[]) => {
      if (changed !== document || split) return originalFire(changed, contentChanges);
      split = true;
      if (options.hiddenLocalChange) {
        const local = options.hiddenLocalChange;
        if (!options.expected) throw new Error('hidden local change requires expected text');
        changed.text = options.expected;
        changed.version += options.versionJump ?? 0;
        originalFire(changed, [{
          rangeOffset: local.offset,
          rangeLength: local.deleteCount,
          text: local.insertText,
        }]);
        return;
      }
      for (let index = 0; index < options.eventChanges.length; index += 1) {
        changed.text = options.intermediateTexts[index]!;
        if (index === 0) changed.version += options.versionJump ?? 0;
        const change = options.eventChanges[index]!;
        originalFire(changed, [{
          rangeOffset: change.offset,
          rangeLength: change.deleteCount,
          text: change.insertText,
        }]);
      }
      if (options.localAfter !== undefined) {
        const offset = options.target.length;
        changed.text = `${options.target}${options.localAfter}`;
        originalFire(changed, [{ rangeOffset: offset, rangeLength: 0, text: options.localAfter }]);
      }
    };

    project.applyRemoteUpdate(
      key,
      kind,
      remoteUpdate,
      options.notebookCell ? { type: 'cellText', cellId: 'a' } : undefined,
    );
    await synchronizer.prepareWorkingCopy();

    const expected = options.expected ?? `${options.target}${options.localAfter ?? ''}`;
    const expectedLocalUpdates = options.localAfter !== undefined || options.hiddenLocalChange ? 1 : 0;
    const source = options.notebookCell ? project.cellSource(key, 'a').toString() : project.text(key).toString();
    const displayed = (synchronizer as any).textReplicas.get(document.uri.toString())?.source();
    assert.equal(document.getText(), expected, 'editor must retain one remote edit plus real local typing');
    assert.equal(source, expected, 'canonical CRDT must equal the editor');
    assert.equal(displayed, expected, 'displayed Yjs replica must share the same baseline');
    assert.equal(localUpdates.length, expectedLocalUpdates,
      'remote editor echo must never become a fresh local CRDT update');
    assert.equal(vscodeBoundary.__warnings.length, 0, 'valid editing must not trigger rejected-update recovery');
    assert.equal(vscodeBoundary.__warnings.some((warning: string) => warning.includes('Text change is outside')), false);

    for (const event of localUpdates) peer.applyRemoteUpdate(key, kind, event.update, event.scope);
    const peerSource = options.notebookCell ? peer.cellSource(key, 'a').toString() : peer.text(key).toString();
    assert.equal(peerSource, expected, 'the second CRDT peer must converge before the next keystroke');

    const beforeReplay = localUpdates.length;
    project.applyRemoteUpdate(
      key,
      kind,
      remoteUpdate,
      options.notebookCell ? { type: 'cellText', cellId: 'a' } : undefined,
    );
    await synchronizer.prepareWorkingCopy();
    assert.equal(document.getText(), expected, 'wire replay must remain idempotent');
    assert.equal(localUpdates.length, beforeReplay, 'wire replay must not publish editor text');
    assert.equal((synchronizer as any).textReplicas.get(document.uri.toString())?.source(), expected,
      'wire replay must not desynchronize the displayed replica');

    document.text = `${expected}Z`;
    originalFire(document, [{ rangeOffset: expected.length, rangeLength: 0, text: 'Z' }]);
    const followup = options.notebookCell ? project.cellSource(key, 'a').toString() : project.text(key).toString();
    assert.equal(followup, `${expected}Z`, 'the next ordinary keystroke must use the reconciled baseline');
    assert.equal((synchronizer as any).textReplicas.get(document.uri.toString())?.source(), `${expected}Z`);
    assert.equal(localUpdates.length, beforeReplay + 1, 'follow-up typing must publish exactly once');
    for (const event of localUpdates.slice(beforeReplay)) peer.applyRemoteUpdate(key, kind, event.update, event.scope);
    const peerFollowup = options.notebookCell ? peer.cellSource(key, 'a').toString() : peer.text(key).toString();
    assert.equal(peerFollowup, `${expected}Z`, 'both CRDT peers must converge after the follow-up keystroke');
    assert.equal(vscodeBoundary.__warnings.length, 0, 'no valid stress edit may trigger recovery');
  } finally {
    vscodeBoundary.__fireTextChange = originalFire;
    synchronizer.dispose();
    project.destroy();
    peer.destroy();
  }
}

function fakeNotebook(root: string, cells: any[]): any {
  const notebook = {
    uri: vscodeBoundary.Uri.file(path.join(root, 'work.ipynb')),
    cells,
    metadata: { language_info: { name: 'python' } },
    saveCount: 0,
    get cellCount() { return this.cells.length; },
    getCells(range?: { start: number; end: number }) {
      return range ? this.cells.slice(range.start, range.end) : this.cells;
    },
    cellAt(index: number) { return this.cells[index]; },
    async save() { this.saveCount += 1; return true; },
  };
  for (const cell of cells) cell.notebook = notebook;
  reindex(notebook);
  return notebook;
}

let cellHandle = 0;
function fakeCell(source: string, id?: string): any {
  const handle = cellHandle += 1;
  const document = {
    uri: new vscodeBoundary.Uri(`/cell/${handle}`, 'vscode-notebook-cell'),
    languageId: 'python',
    text: source,
    version: 1,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
  };
  return {
    index: 0,
    kind: 2,
    document,
    metadata: id ? { pairNotebookCellId: id } : {},
    outputs: [],
    executionSummary: undefined,
    notebook: undefined,
  };
}

function fakeTextDocument(absolutePath: string, source: string): any {
  return {
    uri: vscodeBoundary.Uri.file(absolutePath),
    text: source,
    version: 1,
    saveCount: 0,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
    async save() { this.saveCount += 1; return true; },
  };
}

function reindex(notebook: any): void {
  notebook.cells.forEach((cell: any, index: number) => {
    cell.index = index;
    cell.notebook = notebook;
  });
}

function createVscodeBoundary(): any {
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const on = (name: string) => (callback: (event: any) => void) => {
    (handlers[name] ??= []).push(callback);
    return { dispose: () => { handlers[name] = (handlers[name] ?? []).filter((item) => item !== callback); } };
  };
  class Uri {
    public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
    public toString(): string { return `${this.scheme}://${this.fsPath}`; }
    public static file(value: string): Uri { return new Uri(value); }
  }
  class Range {
    public constructor(public readonly start: number, public readonly end: number) {}
  }
  class NotebookRange extends Range {}
  class NotebookCellData {
    public metadata: Record<string, unknown> = {};
    public outputs: any[] = [];
    public executionSummary: unknown;
    public constructor(public readonly kind: number, public readonly value: string, public readonly languageId: string) {}
  }
  class NotebookCellOutputItem {
    public constructor(public readonly data: Uint8Array, public readonly mime: string) {}
  }
  class NotebookCellOutput {
    public constructor(public items: any[], public metadata?: Record<string, unknown>) {}
  }
  class WorkspaceEdit {
    public operations: any[] = [];
    public replace(uri: Uri, range: Range, text: string): void { this.operations.push({ type: 'text', uri, range, text }); }
    public set(uri: Uri, edits: any[]): void { this.operations.push({ type: 'notebook', uri, edits }); }
  }

  const boundary: any = {
    Uri,
    Range,
    NotebookRange,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    WorkspaceEdit,
    NotebookEdit: {
      replaceCells: (range: NotebookRange, cells: any[]) => ({ type: 'replaceCells', range, cells }),
      updateCellMetadata: (index: number, metadata: Record<string, unknown>) => ({ type: 'cellMetadata', index, metadata }),
      updateNotebookMetadata: (metadata: Record<string, unknown>) => ({ type: 'notebookMetadata', metadata }),
    },
    workspace: {
      notebookDocuments: [] as any[],
      textDocuments: [] as any[],
      onDidOpenTextDocument: on('openText'),
      onDidChangeTextDocument: on('changeText'),
      onDidCloseTextDocument: on('closeText'),
      onDidOpenNotebookDocument: on('openNotebook'),
      onDidChangeNotebookDocument: on('changeNotebook'),
      applyEdit: async (edit: WorkspaceEdit) => {
        const documents = [...boundary.workspace.textDocuments,
          ...boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells.map((cell: any) => cell.document))];
        const versions = new Map(documents.map((document: any) => [document, document.version]));
        await boundary.__beforeApplyEdit?.(edit);
        if (edit.operations.some((operation: any) => operation.type === 'text'
          && documents.some((document: any) => document.uri.toString() === operation.uri.toString()
            && document.version !== versions.get(document)))) return false;
        for (const operation of edit.operations) {
          if (operation.type === 'text') {
            const cell = boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells)
              .find((item: any) => item.document.uri.toString() === operation.uri.toString());
            const document = cell?.document ?? boundary.workspace.textDocuments
              .find((item: any) => item.uri.toString() === operation.uri.toString());
            if (!document) continue;
            document.text = `${document.text.slice(0, operation.range.start)}${operation.text}${document.text.slice(operation.range.end)}`;
            boundary.__fireTextChange(document, [{
              rangeOffset: operation.range.start,
              rangeLength: operation.range.end - operation.range.start,
              text: operation.text,
            }]);
            continue;
          }
          const notebook = boundary.workspace.notebookDocuments.find((item: any) => item.uri.toString() === operation.uri.toString());
          if (!notebook) continue;
          for (const notebookEdit of operation.edits) {
            if (notebookEdit.type === 'cellMetadata') notebook.cells[notebookEdit.index].metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'notebookMetadata') notebook.metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'replaceCells') {
              const cells = notebookEdit.cells.map((data: any) => {
                const cell = fakeCell(data.value, data.metadata?.pairNotebookCellId);
                cell.kind = data.kind;
                cell.document.languageId = data.languageId;
                cell.metadata = { ...(data.metadata ?? {}) };
                cell.outputs = data.outputs ?? [];
                cell.executionSummary = data.executionSummary;
                return cell;
              });
              notebook.cells.splice(notebookEdit.range.start, notebookEdit.range.end - notebookEdit.range.start, ...cells);
              reindex(notebook);
            }
          }
        }
        return true;
      },
    },
    window: {
      activeNotebookEditor: undefined as any,
      activeTextEditor: undefined as any,
      visibleNotebookEditors: [] as any[],
      visibleTextEditors: [] as any[],
      showWarningMessage: async (message: string) => { boundary.__warnings.push(message); return undefined; },
    },
    NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    __warnings: [] as string[],
    __beforeApplyEdit: undefined as undefined | ((edit: WorkspaceEdit) => Promise<void>),
    __fireTextChange: (document: any, contentChanges: any[]) => {
      document.version = (document.version ?? 0) + 1;
      for (const callback of handlers.changeText ?? []) callback({ document, contentChanges });
    },
    __reset: (notebook: any) => {
      boundary.workspace.notebookDocuments = [notebook];
      boundary.workspace.textDocuments = [];
      boundary.__warnings = [];
      boundary.__beforeApplyEdit = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
    },
    __resetText: (document: any) => {
      boundary.workspace.notebookDocuments = [];
      boundary.workspace.textDocuments = [document];
      boundary.__warnings = [];
      boundary.__beforeApplyEdit = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
    },
  };
  return boundary;
}

function logger(): any {
  return { appendLine: () => undefined };
}
