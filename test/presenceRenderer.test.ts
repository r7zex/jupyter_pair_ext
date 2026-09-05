import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

interface DecorationRecord {
  options: Record<string, unknown>;
  disposed: boolean;
  dispose: () => void;
}

function uri(relative: string): any {
  const fsPath = `/tmp/pair-presence/${relative}`;
  return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
}

function documentFor(target: any, source: string): any {
  const lines = source.split('\n');
  return {
    uri: target,
    lineCount: lines.length,
    lineAt: (line: number) => ({ range: { start: { line, character: 0 }, end: { line, character: lines[line]!.length } } }),
    positionAt: (offset: number) => {
      let index = Math.max(0, Math.min(source.length, offset));
      for (let line = 0; line < lines.length; line += 1) {
        const length = lines[line]!.length;
        if (index <= length) return { line, character: index };
        index -= length + 1;
      }
      return { line: lines.length - 1, character: lines.at(-1)!.length };
    },
  };
}

function createHarness(states: any[], offsets: Record<string, number | undefined>) {
  const applied: Array<{ type: DecorationRecord; options: any[] }> = [];
  const types: DecorationRecord[] = [];
  const disposable = () => ({ dispose: () => undefined });
  const fakeVscode: any = {
    Range: class { public constructor(public readonly start: any, public readonly end: any) {} },
    OverviewRulerLane: { Right: 4 },
    DecorationRangeBehavior: { OpenOpen: 0 },
    window: {
      visibleTextEditors: [] as any[],
      onDidChangeVisibleTextEditors: disposable,
      createTextEditorDecorationType: (options: Record<string, unknown>) => {
        const type: DecorationRecord = { options, disposed: false, dispose: () => { type.disposed = true; } };
        types.push(type);
        return type;
      },
    },
    workspace: {
      notebookDocuments: [] as any[],
      onDidChangeTextDocument: disposable,
      onDidChangeNotebookDocument: disposable,
    },
  };
  const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const presencePath = require.resolve('../src/vscode/presence');
  delete require.cache[presencePath];
  loader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return fakeVscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  let PresenceRenderer: new (runtime: any) => any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ PresenceRenderer } = require('../src/vscode/presence'));
  } finally {
    loader._load = originalLoad;
  }
  const runtime: any = new EventEmitter();
  runtime.descriptor = { localPeer: { peerId: 'host' }, workingFolder: '/tmp/pair-presence' };
  runtime.snapshot = () => ({ awareness: states });
  runtime.notebookCellId = () => undefined;
  runtime.resolvePresenceLineOffset = (state: any) => offsets[state.peer.peerId];
  const editor = (relative: string, source: string) => {
    const value = {
      document: documentFor(uri(relative), source),
      setDecorations: (type: DecorationRecord, options: any[]) => applied.push({ type, options }),
    };
    fakeVscode.window.visibleTextEditors.push(value);
    return value;
  };
  return { PresenceRenderer, runtime, editor, applied, types };
}

function remote(peerId: string, activeLine: number, activeLineAnchor?: string): any {
  return {
    peer: { peerId, displayName: peerId, joinOrder: 1 },
    activeFile: 'work.py',
    activeLine,
    activeLineAnchor,
    shareCursor: true,
  };
}

describe('presence renderer selected-line mode', () => {
  it('renders only a whole-line highlight with no cursor label or character range', () => {
    const h = createHarness([remote('guest', 1)], {});
    h.editor('work.py', 'zero\none here\ntwo');
    const renderer = new h.PresenceRenderer(h.runtime);
    const rendered = h.applied.find((entry) => entry.options.length);
    assert.ok(rendered);
    assert.equal(rendered.type.options.isWholeLine, true);
    assert.deepEqual(rendered.options[0].range.start, { line: 1, character: 0 });
    assert.deepEqual(rendered.options[0].range.end, { line: 1, character: 8 });
    assert.equal(rendered.options[0].renderOptions, undefined);
    renderer.dispose();
  });

  it('uses a relative line anchor after new lines are inserted before the selected line', () => {
    const state = remote('guest', 1, 'relative-anchor');
    const h = createHarness([state], { guest: 12 });
    h.editor('work.py', 'new\nzero\nselected\ntwo');
    const renderer = new h.PresenceRenderer(h.runtime);
    const rendered = h.applied.find((entry) => entry.options.length);
    assert.ok(rendered);
    assert.deepEqual(rendered.options[0].range.start, { line: 2, character: 0 });
    renderer.dispose();
  });
});
