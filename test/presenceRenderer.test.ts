import assert from 'node:assert/strict';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import Module from 'node:module';
import * as Y from 'yjs';
import { resolveSharedCursorPosition } from '../src/core/cursorPosition';

interface FakeDecorationType {
  options: Record<string, unknown>;
  disposed: boolean;
  dispose: () => void;
}

interface AppliedDecoration {
  type: FakeDecorationType;
  options: any[];
}

function fileUri(relative: string): any {
  const fsPath = `/tmp/pair-presence/${relative}`;
  return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
}

function cellUri(name: string): any {
  return { scheme: 'vscode-notebook-cell', fsPath: '', toString: () => `vscode-notebook-cell://${name}` };
}

function documentFor(uri: any, text: string): any {
  const lines = text.split('\n');
  return {
    uri,
    lineCount: lines.length,
    lineAt: (line: number) => {
      if (!Number.isInteger(line) || line < 0 || line >= lines.length) throw new RangeError(`invalid line ${line}`);
      const lineText = lines[line];
      if (lineText === undefined) throw new RangeError(`invalid line ${line}`);
      return { range: { start: { line, character: 0 }, end: { line, character: lineText.length } } };
    },
    positionAt: (offset: number) => {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new RangeError(`invalid offset ${offset}`);
      let consumed = 0;
      for (let line = 0; line < lines.length; line += 1) {
        const lineText = lines[line];
        if (lineText === undefined) throw new RangeError(`invalid line ${line}`);
        const end = consumed + lineText.length;
        if (offset <= end) return { line, character: offset - consumed };
        consumed = end + 1;
      }
      const last = lines[lines.length - 1];
      if (last === undefined) throw new RangeError('document has no lines');
      return { line: lines.length - 1, character: last.length };
    },
  };
}

function remote(peerId: string, displayName: string, extra: Record<string, unknown>): any {
  return {
    peer: { peerId, displayName, joinOrder: peerId === 'alice' ? 1 : 2 },
    shareCursor: true,
    cursorColor: peerId === 'alice' ? '#123456' : '#654321',
    kernelStatus: 'Offline',
    ...extra,
  };
}

function harness(initialAwareness: any[] = []): any {
  let awareness = initialAwareness;
  const applied: AppliedDecoration[] = [];
  const createdTypes: FakeDecorationType[] = [];
  const notebookListeners: Array<() => void> = [];
  const legacyResolved = new Map<string, { anchor: number; active: number } | undefined>();

  class EventEmitter<T = void> {
    private readonly emitter = new NodeEventEmitter();
    public readonly event = (listener: (value: T) => void) => {
      this.emitter.on('event', listener);
      return { dispose: () => this.emitter.off('event', listener) };
    };
    public fire(value?: T): void { this.emitter.emit('event', value); }
    public dispose(): void { this.emitter.removeAllListeners(); }
  }
  class Range { public constructor(public readonly start: any, public readonly end: any) {} }
  class NotebookCellStatusBarItem {
    public tooltip: string | undefined;
    public priority: number | undefined;
    public color: string | undefined;
    public constructor(public readonly text: string, public readonly alignment: number) {}
  }
  const disposable = () => ({ dispose: () => undefined });
  const vscode: any = {
    EventEmitter,
    Range,
    OverviewRulerLane: { Right: 4 },
    DecorationRangeBehavior: { OpenOpen: 0 },
    NotebookCellStatusBarAlignment: { Left: 1 },
    NotebookCellStatusBarItem,
    window: {
      visibleTextEditors: [] as any[],
      onDidChangeVisibleTextEditors: () => disposable(),
      onDidChangeTextEditorVisibleRanges: () => disposable(),
      createTextEditorDecorationType: (options: Record<string, unknown>) => {
        const type: FakeDecorationType = {
          options,
          disposed: false,
          dispose: () => { type.disposed = true; },
        };
        createdTypes.push(type);
        return type;
      },
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
    },
    workspace: {
      notebookDocuments: [] as any[],
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      onDidChangeTextDocument: () => disposable(),
      onDidChangeConfiguration: () => disposable(),
      onDidChangeNotebookDocument: (listener: () => void) => {
        notebookListeners.push(listener);
        return disposable();
      },
    },
    notebooks: { registerNotebookCellStatusBarItemProvider: () => disposable() },
  };

  const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const presencePath = require.resolve('../src/vscode/presence');
  delete require.cache[presencePath];
  loader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  let PresenceRenderer: new (runtime: any, context: any) => any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ PresenceRenderer } = require('../src/vscode/presence') as { PresenceRenderer: new (runtime: any, context: any) => any });
  } finally {
    loader._load = originalLoad;
  }

  const runtime: any = new NodeEventEmitter();
  runtime.descriptor = {
    localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
    workingFolder: '/tmp/pair-presence',
  };
  runtime.snapshot = () => ({ awareness });
  runtime.notebookCellId = (cell: any) => cell.__stableId;
  runtime.resolvePresenceCursor = (state: any) => legacyResolved.get(state.peer.peerId);
  const context = { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } };

  const textEditor = (relative: string, text: string) => {
    const editor = {
      document: documentFor(fileUri(relative), text),
      setDecorations: (type: FakeDecorationType, options: any[]) => applied.push({ type, options }),
    };
    vscode.window.visibleTextEditors.push(editor);
    return editor;
  };
  const notebook = (relative: string, specs: Array<{ id: string; text: string }>) => {
    const cells: any[] = [];
    const value: any = { uri: fileUri(relative), getCells: () => cells };
    for (const spec of specs) {
      cells.push({
        notebook: value,
        document: documentFor(cellUri(`${relative}/${spec.id}`), spec.text),
        __stableId: spec.id,
        metadata: {},
      });
    }
    vscode.workspace.notebookDocuments.push(value);
    return { notebook: value, cells };
  };
  const showCellEditor = (cell: any) => {
    const editor = {
      document: cell.document,
      setDecorations: (type: FakeDecorationType, options: any[]) => applied.push({ type, options }),
    };
    vscode.window.visibleTextEditors.push(editor);
    return editor;
  };
  const lastRendered = () => applied.filter((entry) => entry.options.length > 0).at(-1);

  return {
    PresenceRenderer, vscode, runtime, context, applied, createdTypes, legacyResolved,
    textEditor, notebook, showCellEditor, lastRendered,
    setAwareness: (next: any[]) => { awareness = next; },
    fireNotebookChange: () => notebookListeners.forEach((listener) => listener()),
  };
}

describe('presence renderer line-only and legacy safety', () => {
  it('rejects oversized legacy absolute offsets instead of clamping them into the document', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abc');
    assert.equal(resolveSharedCursorPosition(text, { anchor: 99, active: 99 }), undefined);
  });

  it('highlights the entire active line and never decorates an exact column or selection range', () => {
    const h = harness([remote('alice', 'Alice', {
      activeFile: 'main.py', activeLine: 1, cursor: { anchor: 1, active: 8 },
    })]);
    h.textEditor('main.py', 'zero\none here\ntwo');
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    const rendered = h.lastRendered();
    assert.ok(rendered);
    assert.equal(rendered.type.options.isWholeLine, true);
    assert.deepEqual(rendered.options[0].range.start, { line: 1, character: 0 });
    assert.deepEqual(rendered.options[0].range.end, { line: 1, character: 8 });
    assert.equal(rendered.options[0].renderOptions?.before, undefined);
    assert.match(rendered.options[0].renderOptions.after.contentText, /Alice/);
    renderer.dispose();
  });

  it('shows participant name/color in notebook status using stable id and moves it between stable cells', () => {
    const h = harness([remote('alice', 'Alice', {
      activeFile: 'book.ipynb', activeNotebookCellId: 'cell-a', activeLine: 0,
    })]);
    const { cells } = h.notebook('book.ipynb', [
      { id: 'cell-a', text: 'a = 1' }, { id: 'cell-b', text: 'b = 2' },
    ]);
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    let items = renderer.provideCellStatusBarItems(cells[0]);
    assert.equal(items.length, 1);
    assert.match(items[0].text, /Alice/);
    assert.equal(renderer.provideCellStatusBarItems(cells[1]).length, 0);

    h.setAwareness([remote('alice', 'Alice', {
      activeFile: 'book.ipynb', activeNotebookCellId: 'cell-b', activeLine: 0,
    })]);
    h.runtime.emit('presence');
    assert.equal(renderer.provideCellStatusBarItems(cells[0]).length, 0);
    items = renderer.provideCellStatusBarItems(cells[1]);
    assert.equal(items.length, 1);
    renderer.dispose();
  });

  it('deleted or invalid stable cells never render a fabricated first line and stay cleared until new presence', () => {
    const h = harness([remote('alice', 'Alice', {
      activeFile: 'book.ipynb', activeNotebookCellId: 'cell-a', activeLine: 0,
    })]);
    const { notebook, cells } = h.notebook('book.ipynb', [{ id: 'cell-a', text: 'a = 1' }]);
    h.showCellEditor(cells[0]);
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    let statusChanges = 0;
    const d = renderer.onDidChangeCellStatusBarItems(() => { statusChanges += 1; });
    assert.ok(h.lastRendered());

    cells.splice(0, 1);
    h.fireNotebookChange();
    assert.ok(h.applied.some((entry: AppliedDecoration) => entry.options.length === 0));
    assert.ok(statusChanges > 0);

    const ghost = {
      notebook,
      document: documentFor(cellUri('book.ipynb/cell-a'), 'ghost'),
      __stableId: 'cell-a', metadata: {},
    };
    cells.push(ghost);
    h.fireNotebookChange();
    assert.equal(renderer.provideCellStatusBarItems(ghost).length, 0, 'stale invalid presence stays suppressed');
    h.runtime.emit('presence');
    assert.equal(renderer.provideCellStatusBarItems(ghost).length, 1, 'new peer presence may revalidate the cell');
    d.dispose();
    renderer.dispose();

    const h2 = harness([remote('alice', 'Alice', {
      activeFile: 'book.ipynb', activeNotebookCellId: 'missing', activeLine: 0,
    })]);
    const existing = h2.notebook('book.ipynb', [{ id: 'cell-b', text: 'b = 2' }]).cells[0];
    h2.showCellEditor(existing);
    const renderer2 = new h2.PresenceRenderer(h2.runtime, h2.context);
    assert.equal(h2.lastRendered(), undefined);
    assert.equal(renderer2.provideCellStatusBarItems(existing).length, 0);
    renderer2.dispose();
  });

  it('rejects negative, non-integer and out-of-range semantic lines instead of clamping them', () => {
    for (const line of [-1, 1.5, 99]) {
      const h = harness([remote('alice', 'Alice', { activeFile: 'main.py', activeLine: line })]);
      h.textEditor('main.py', 'zero\none');
      const renderer = new h.PresenceRenderer(h.runtime, h.context);
      assert.equal(h.lastRendered(), undefined, `line ${line} must not render`);
      renderer.dispose();
    }
  });

  it('renders a valid legacy cursor as line-only and invalid legacy cursor as nothing', () => {
    const valid = remote('alice', 'Alice', { activeFile: 'main.py', cursor: { anchor: 5, active: 5 } });
    const h = harness([valid]);
    h.legacyResolved.set('alice', { anchor: 5, active: 5 });
    h.textEditor('main.py', 'zero\none here');
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    const rendered = h.lastRendered();
    assert.ok(rendered);
    assert.deepEqual(rendered.options[0].range.start, { line: 1, character: 0 });
    assert.deepEqual(rendered.options[0].range.end, { line: 1, character: 8 });
    renderer.dispose();

    const invalid = remote('alice', 'Alice', { activeFile: 'main.py', cursor: { anchor: 999, active: 999 } });
    const h2 = harness([invalid]);
    h2.legacyResolved.set('alice', undefined);
    h2.textEditor('main.py', 'zero\none');
    const renderer2 = new h2.PresenceRenderer(h2.runtime, h2.context);
    assert.equal(h2.lastRendered(), undefined);
    renderer2.dispose();
  });

  it('peer blur and disconnect clear decorations/status immediately without a throttle', () => {
    const h = harness([remote('alice', 'Alice', {
      activeFile: 'book.ipynb', activeNotebookCellId: 'cell-a', activeLine: 0,
    })]);
    const { cells } = h.notebook('book.ipynb', [{ id: 'cell-a', text: 'x = 1' }]);
    h.showCellEditor(cells[0]);
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    assert.equal(renderer.provideCellStatusBarItems(cells[0]).length, 1);

    h.setAwareness([remote('alice', 'Alice', {})]);
    h.runtime.emit('presence');
    assert.equal(renderer.provideCellStatusBarItems(cells[0]).length, 0);
    h.setAwareness([]);
    h.runtime.emit('presence');
    assert.equal((renderer as any).decorations.size, 0);
    renderer.dispose();
  });

  it('renders multiple collaborators deterministically and never leaks decoration types', () => {
    const bob = remote('bob', 'Bob', { activeFile: 'main.py', activeLine: 0 });
    const alice = remote('alice', 'Alice', { activeFile: 'main.py', activeLine: 0 });
    const h = harness([bob, alice]);
    h.textEditor('main.py', 'shared');
    const renderer = new h.PresenceRenderer(h.runtime, h.context);
    const names = h.applied
      .filter((entry: AppliedDecoration) => entry.options.length > 0)
      .map((entry: AppliedDecoration) => entry.options[0].renderOptions.after.contentText.trim());
    assert.deepEqual(names, ['Alice', 'Bob']);
    assert.equal((renderer as any).decorations.size, 2);

    h.setAwareness([bob]);
    h.runtime.emit('presence');
    assert.equal((renderer as any).decorations.size, 1);
    assert.ok(h.createdTypes.some((type: FakeDecorationType) => type.disposed));
    for (let index = 0; index < 20; index += 1) h.runtime.emit('presence');
    assert.equal((renderer as any).decorations.size, 1);
    renderer.dispose();
  });
});
