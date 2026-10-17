import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';

describe('dashboard webview startup', () => {
  it('registers its message receiver before loading HTML and always ships a visible fallback', async () => {
    const executed: string[] = [];
    const errors: string[] = [];
    let clipboard = "";
    const fakeVscode = {
      env: { clipboard: { writeText: async (value: string) => { clipboard = value; } } },
      commands: {
        executeCommand: async (command: string) => {
          executed.push(command);
        },
      },
      window: {
        showInformationMessage: async () => undefined,
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
      globalState: { get: () => [{
        name: 'Shared analysis',
        sessionId: 'dashboard-session',
        hostDisplayName: 'Alice',
        workingFolder: 'C:\\pair\\shared-analysis',
        at: Date.now() - 2 * 3_600_000,
        leftAt: Date.now() - 2 * 3_600_000,
      }] },
    });

    provider.resolveWebviewView({ webview, show: () => undefined });

    assert.match(assignedHtml, /Start self-host session/);
    assert.match(assignedHtml, /--pair-accent:\s*#ffe66d/);
    assert.match(assignedHtml, /button:not\(\.secondary\), a\.fallback-button\s*\{[^}]*var\(--pair-accent\)/);
    assert.match(assignedHtml, /Connect to server/);
    assert.match(assignedHtml, /command:pairNotebook\.startSession/);
    assert.match(assignedHtml, /command:pairNotebook\.configureVpsSessions">Saved connections/);
    assert.match(assignedHtml, /Create server project/);
    assert.match(assignedHtml, /Connect to server/);
    assert.doesNotMatch(assignedHtml, /command:pairNotebook\.connectVpsCompute/);
    assert.match(assignedHtml, /webviewReady/);
    assert.match(assignedHtml, /Content-Security-Policy/);
    assert.match(assignedHtml, /Session:/);
    assert.match(assignedHtml, /Host:/);
    assert.match(assignedHtml, /Left/);
    assert.match(assignedHtml, /Отменённый выбор папки можно открыть снова/);
    assert.match(assignedHtml, /Choose new host folder/);
    assert.match(assignedHtml, /Transfer host','TO ANOTHER PARTICIPANT/);
    assert.match(assignedHtml, /End session','WITHOUT A NEW FOLDER/);
    assert.match(assignedHtml, /p\.online \|\| p\.connectionState === 'recovering'/, 'connected and recovering participants remain visible');
    assert.match(assignedHtml, /const recovering = p\.connectionState === 'recovering'/);
    assert.match(assignedHtml, /Reconnecting/);
    assert.match(assignedHtml, /indicator = recovering \? '🟡' : '🟢'/, 'recovering is not rendered with the green online indicator');
    assert.match(assignedHtml, /const latency = recovering \|\| p\.latency < 0 \? '—' : p\.latency\+' ms'/, 'recovering hides stale latency');
    assert.doesNotMatch(assignedHtml, /action\('transfer'[^\n]+disabled:!state\.isHost\|\|paused/);
    assert.doesNotMatch(assignedHtml, /action\('end'[^\n]+disabled:paused/);
    assert.doesNotMatch(assignedHtml, new RegExp(['Tail', 'scale'].join(''), 'i'));
    assert.deepEqual(webview.options.localResourceRoots, []);
    assert.deepEqual(webview.options.enableCommandUris, [
      'pairNotebook.startSession', 'pairNotebook.joinSession', 'pairNotebook.createVpsSession', 'pairNotebook.joinVpsSession', 'pairNotebook.configureVpsSessions',
    ]);
    assert.equal(posted.length, 1, 'a complete landing state is posted after HTML assignment');
    const landing = posted[0] as { patch?: { recent?: Array<Record<string, unknown>> } };
    assert.equal(landing.patch?.recent?.[0]?.hostName, 'Alice');
    assert.equal(landing.patch?.recent?.[0]?.relativeExit, '2 часа назад');
    assert.match(String(landing.patch?.recent?.[0]?.exitDate), /^\d{2}\/\d{2}\/\d{2}$/);

    receive?.({ command: 'webviewReady' });
    receive?.(null);
    receive?.({ command: '__proto__' });
    receive?.({ command: 'constructor' });
    receive?.({ command: 'toString' });
    receive?.({ command: 'connectVpsCompute' });
    receive?.({ command: 'join' });
    receive?.({ command: 'vps' });
    receive?.({ command: 'webviewError', detail: 'synthetic failure' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 2, 'the ready handshake requests a fresh state in case the first post raced');
    assert.deepEqual(executed, ['pairNotebook.joinSession', 'pairNotebook.configureVpsSessions']);
    assert.deepEqual(errors, ['Pair Notebook panel error: synthetic failure']);
    const persistent = { id: 'server-project', name: '<Private project>', state: 'running', ownerId: 'owner', memberId: 'owner', allowMemberSwitch: false,
      members: [{ id: 'owner', name: 'Alice', role: 'owner', online: true }], devices: [{ id: 'vps', name: 'VPS CPU', cpu: 'CPU model', python: 'Python 3', online: true, gpus: [] }], target: { deviceId: 'vps' }, generation: 1, consents: [], revision: 0 };
    provider.setPersistentSession(persistent, 'https://relay.example');
    const elements = new Map<string, { innerHTML: string; onclick?: () => void }>();
    const getElementById = (id: string) => { let element = elements.get(id); if (!element) { element = { innerHTML: '' }; elements.set(id, element); } return element; };
    const renderCommands: unknown[] = [];
    let renderMessage: ((event: unknown) => void) | undefined;
    vm.runInNewContext(assignedHtml.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!, {
      document: { getElementById, activeElement: {} },
      window: { addEventListener: (_type: string, callback: (event: unknown) => void) => { renderMessage = callback; } },
      acquireVsCodeApi: () => ({ postMessage: (message: unknown) => renderCommands.push(message) }),
    });
    renderMessage?.({ data: posted.at(-1) });
    assert.match(getElementById('content').innerHTML, /&lt;Private project&gt;/);
    assert.doesNotMatch(getElementById('content').innerHTML, /pair-vps:|ID:|\/opt\/|persistentConnection/);
    assert.match(getElementById('content').innerHTML, /section-connection/);
    assert.match(getElementById('content').innerHTML, /Alice \(you\)/);
    assert.match(getElementById('content').innerHTML, /SESSION HOST/);
    assert.match(getElementById('content').innerHTML, /NETWORK/);
    assert.match(getElementById('content').innerHTML, /QUICK ACTIONS/);
    assert.doesNotMatch(getElementById('content').innerHTML, /id="status"|id="statusTitle"/);
    assert.match(getElementById('content').innerHTML, /Show password/);
    assert.doesNotMatch(getElementById('content').innerHTML, /id="copyVpsPassword"/);
    assert.match(getElementById('content').innerHTML, /Leave session/);
    getElementById('togglePassword').onclick?.();
    assert.deepEqual(JSON.parse(JSON.stringify(renderCommands.at(-1))), { command: 'revealVpsPassword' });
    renderMessage?.({ data: { type: 'sessionPassword', endpoint: 'https://relay.example', sessionId: 'server-project', memberId: 'owner', value: '<private-password>' } });
    assert.match(getElementById('content').innerHTML, /Hide password/);
    assert.match(getElementById('content').innerHTML, /&lt;private-password&gt;/);
    assert.match(getElementById('content').innerHTML, /id="copyVpsPassword"/);
    assert.match(getElementById('content').innerHTML, /aria-label="Copy password"/);
    provider.sessionPassword = async () => '<private-password>';
    receive?.({ command: 'copyVpsPassword' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clipboard, '<private-password>');
    assert.doesNotMatch(getElementById('content').innerHTML, />Copy<|C\.\.\./);
    getElementById('togglePassword').onclick?.();
    assert.doesNotMatch(getElementById('content').innerHTML, /private-password|id="copyVpsPassword"/);
    provider.setPersistentSession({ ...persistent, target: { deviceId: 'guest-gpu', gpuUuid: 'GPU-other' }, activeKernel: { notebook: 'Private/research.ipynb', scope: 'private', deviceId: 'vps', canRestart: true } }, 'https://relay.example');
    renderMessage?.({ data: posted.at(-1) });
    assert.match(getElementById('content').innerHTML, /Private kernel/);
    assert.match(getElementById('content').innerHTML, /Restart private kernel/);
    assert.match(getElementById('content').innerHTML, /Private\/research.ipynb/);
    assert.match(getElementById('content').innerHTML, /VPS CPU/);
    assert.doesNotMatch(getElementById('content').innerHTML, />GPU<|guest-gpu/);
    provider.setPersistentSession(undefined);
    assert.equal((posted.at(-1) as { patch: { live: boolean } }).patch.live, false);
    provider.dispose();
  });
});
