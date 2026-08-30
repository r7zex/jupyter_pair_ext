import assert from 'node:assert/strict';
import Module from 'node:module';

describe('dashboard webview startup', () => {
  it('registers its message receiver before loading HTML and always ships a visible fallback', async () => {
    const executed: string[] = [];
    const errors: string[] = [];
    const fakeVscode = {
      commands: {
        executeCommand: async (command: string) => {
          executed.push(command);
        },
      },
      window: {
        showErrorMessage: async (message: string) => {
          errors.push(message);
        },
      },
      workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
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

    let DashboardProvider: new (context: any) => any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ DashboardProvider } = require('../src/vscode/dashboard') as { DashboardProvider: new (context: any) => any });
    } finally {
      moduleWithLoader._load = originalLoad;
    }

    let receive: ((message: unknown) => void) | undefined;
    let assignedHtml = '';
    const posted: unknown[] = [];
    const webview: any = {
      cspSource: 'vscode-webview://pair-notebook',
      options: {},
      onDidReceiveMessage(callback: typeof receive) {
        receive = callback;
        return { dispose: () => undefined };
      },
      postMessage: async (message: unknown) => {
        posted.push(message);
        return true;
      },
    };
    Object.defineProperty(webview, 'html', {
      set(value: string) {
        assert.ok(receive, 'the extension-side receiver must exist before webview JavaScript can run');
        assignedHtml = value;
      },
    });
    const provider = new DashboardProvider({
      globalState: { get: () => ({ corrupt: true }) },
    });

    provider.resolveWebviewView({ webview, show: () => undefined });

    assert.match(assignedHtml, /Начать сессию/);
    assert.match(assignedHtml, /Подключиться/);
    assert.match(assignedHtml, /command:pairNotebook\.startSession/);
    assert.match(assignedHtml, /webviewReady/);
    assert.match(assignedHtml, /Content-Security-Policy/);
    assert.match(assignedHtml, /Отменённый выбор папки можно открыть снова/);
    assert.match(assignedHtml, /Настроить папку нового хоста/);
    assert.match(assignedHtml, /Передать хоста','ДРУГОМУ УЧАСТНИКУ/);
    assert.match(assignedHtml, /Завершить сессию','БЕЗ НОВОЙ ПАПКИ/);
    assert.doesNotMatch(assignedHtml, /action\('transfer'[^\n]+disabled:!state\.isHost\|\|paused/);
    assert.doesNotMatch(assignedHtml, /action\('end'[^\n]+disabled:paused/);
    assert.doesNotMatch(assignedHtml, new RegExp(['Tail', 'scale'].join(''), 'i'));
    assert.deepEqual(webview.options.localResourceRoots, []);
    assert.deepEqual(webview.options.enableCommandUris, ['pairNotebook.startSession', 'pairNotebook.joinSession']);
    assert.equal(posted.length, 1, 'a complete landing state is posted after HTML assignment');

    receive?.({ command: 'webviewReady' });
    receive?.(null);
    receive?.({ command: '__proto__' });
    receive?.({ command: 'join' });
    receive?.({ command: 'webviewError', detail: 'synthetic failure' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 2, 'the ready handshake requests a fresh state in case the first post raced');
    assert.deepEqual(executed, ['pairNotebook.joinSession']);
    assert.deepEqual(errors, ['Pair Notebook panel error: synthetic failure']);
    provider.dispose();
  });
});
