import assert from 'node:assert/strict';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import Module from 'node:module';

describe('presence decoration lifecycle', () => {
  it('disposes a stale line decoration when terminal awareness disappears', () => {
    const disposable = () => ({ dispose: () => undefined });
    let disposedDecorations = 0;
    const applied: Array<{ options: unknown[] }> = [];

    class VscodeEventEmitter<T = void> {
      private readonly emitter = new NodeEventEmitter();
      public readonly event = (listener: (value: T) => void) => {
        this.emitter.on('event', listener);
        return { dispose: () => this.emitter.off('event', listener) };
      };
      public fire(value?: T): void { this.emitter.emit('event', value); }
      public dispose(): void { this.emitter.removeAllListeners(); }
    }

    class Range {
      public constructor(public readonly start: unknown, public readonly end: unknown) {}
    }

    const uri = {
      scheme: 'file',
      fsPath: '/tmp/pair-presence/main.py',
      toString: () => 'file:///tmp/pair-presence/main.py',
    };
    const editor = {
      document: {
        uri,
        lineCount: 1,
        lineAt: () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }),
      },
      setDecorations: (_type: unknown, options: unknown[]) => { applied.push({ options }); },
    };

    const fakeVscode: any = {
      EventEmitter: VscodeEventEmitter,
      Range,
      OverviewRulerLane: { Right: 4 },
      DecorationRangeBehavior: { OpenOpen: 0 },
      NotebookCellStatusBarAlignment: { Left: 1 },
      NotebookCellStatusBarItem: class {},
      window: {
        visibleTextEditors: [editor],
        onDidChangeVisibleTextEditors: () => disposable(),
        onDidChangeTextEditorVisibleRanges: () => disposable(),
        createTextEditorDecorationType: () => ({
          dispose: () => { disposedDecorations += 1; },
        }),
      },
      workspace: {
        notebookDocuments: [],
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidChangeTextDocument: () => disposable(),
        onDidChangeNotebookDocument: () => disposable(),
        onDidChangeConfiguration: () => disposable(),
      },
      notebooks: {
        registerNotebookCellStatusBarItemProvider: () => disposable(),
      },
    };

    const moduleWithLoader = Module as typeof Module & {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const originalLoad = moduleWithLoader._load;
    moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') return fakeVscode;
      return originalLoad.call(this, request, parent, isMain);
    };

    let PresenceRenderer: new (runtime: any, context: any) => any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ PresenceRenderer } = require('../src/vscode/presence') as { PresenceRenderer: new (runtime: any, context: any) => any });
    } finally {
      moduleWithLoader._load = originalLoad;
    }

    const runtime: any = new NodeEventEmitter();
    runtime.descriptor = {
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      workingFolder: '/tmp/pair-presence',
    };
    let awareness: any[] = [{
      peer: { peerId: 'peer-a', displayName: 'Alice', joinOrder: 1 },
      activeFile: 'main.py',
      activeLine: 0,
      shareCursor: true,
      cursorColor: '#123456',
      kernelStatus: 'Offline',
    }];
    runtime.snapshot = () => ({ awareness });
    runtime.notebookCellId = () => undefined;

    const context = {
      workspaceState: {
        get: (_key: string, fallback: unknown) => fallback,
        update: async () => undefined,
      },
    };

    const renderer = new PresenceRenderer(runtime, context);
    assert.equal((renderer as any).decorations.size, 1);
    assert.ok(applied.some((entry) => entry.options.length === 1), 'remote line decoration was rendered');

    awareness = [];
    runtime.emit('presence');

    assert.equal((renderer as any).decorations.size, 0, 'stale peer decoration is removed');
    assert.equal(disposedDecorations, 1, 'stale decoration type is disposed exactly once');
    renderer.dispose();
    assert.equal(disposedDecorations, 1, 'dispose remains idempotent after terminal cleanup');
  });
});
