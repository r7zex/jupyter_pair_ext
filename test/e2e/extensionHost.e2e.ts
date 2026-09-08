import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { CollaborativeProject, type ProjectUpdate } from '../../src/core/crdt';
import { LOCAL_EDITOR_ORIGIN, REMOTE_ORIGIN } from '../../src/core/types';
import { EditorSynchronizer } from '../../src/vscode/sync';

const EXTENSION_ID = 'pair-notebook.pair-notebook';
const PROJECT_COMMANDS = [
  'pairNotebook.startSession',
  'pairNotebook.joinSession',
  'pairNotebook.leaveSession',
  'pairNotebook.endSession',
  'pairNotebook.copyInvite',
  'pairNotebook.openPanel',
  'pairNotebook.transferHost',
  'pairNotebook.showDiagnostics',
  'pairNotebook.tryImproveConnection',
  'pairNotebook.setTurnPassword',
  'pairNotebook.setProxyPassword',
  'pairNotebook.selectBackingFolder',
  'pairNotebook.flush',
  'pairNotebook.selectAutosaveFolder',
  'pairNotebook.createAutosave',
  'pairNotebook.reconnect',
  'pairNotebook.changeCompute',
  'pairNotebook.refreshHardware',
  'pairNotebook.showComputeResources',
  'pairNotebook.selectPythonEnvironment',
  'pairNotebook.runActiveCell',
  'pairNotebook.restartKernel',
  'pairNotebook.openRecentProject',
  'pairNotebook.showAdvancedDiagnostics',
] as const;

suite('Pair Notebook — real VS Code Extension Host', () => {
  suiteSetup(async function () {
    this.timeout(15_000);
    assert.equal(process.env.PAIR_NOTEBOOK_E2E, '1', 'the suite must run through the isolated E2E launcher');
    assert.equal(vscode.workspace.isTrusted, true, 'the E2E workspace must be trusted so Pair Notebook can activate');
    assert.match(process.env.VSCODE_PID ?? '', /^[1-9]\d*$/, 'VS Code must expose its stable main-process PID');
    assert.ok(
      (process.env.VSCODE_IPC_HOOK ?? process.env.VSCODE_IPC_HOOK_CLI)?.trim(),
      'VS Code must expose its stable main-process IPC endpoint',
    );
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} must be loaded as the development extension`);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('activates the development extension and registers the complete command surface', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    assert.equal(extension.isActive, true);

    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of PROJECT_COMMANDS) {
      assert.ok(commands.has(command), `missing registered command: ${command}`);
    }
  });

  test('loads manifest configuration defaults through the real Configuration API', () => {
    const configuration = vscode.workspace.getConfiguration('pairNotebook');
    assert.equal(configuration.get('displayName'), '');
    assert.equal(configuration.get('pythonPath'), 'python');
    assert.equal(configuration.get('selectedCudaDevice'), 0);
    assert.equal(configuration.get('persistenceDebounceMs'), 750);
    assert.equal(configuration.get('logLevel'), 'info');
    assert.deepEqual(configuration.get('turnUrls'), []);
    assert.equal(configuration.get('turnUsername'), '');
    assert.equal(configuration.get('proxyUrl'), '');
  });

  test('opens and reveals the contributed Pair Notebook dashboard without activation errors', async function () {
    this.timeout(10_000);
    await vscode.commands.executeCommand('pairNotebook.openPanel');
    await delay(150);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension?.isActive);
  });

  test('publishes one real local TextDocument edit into canonical Yjs state immediately', async () => {
    const harness = await createTextHarness('alpha');
    try {
      let localUpdates = 0;
      const onUpdate = (event: ProjectUpdate): void => {
        if (event.key === harness.key && event.origin === LOCAL_EDITOR_ORIGIN) localUpdates += 1;
      };
      harness.project.on('update', onUpdate);
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(harness.document.uri, harness.document.positionAt(harness.document.getText().length), ' beta');
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        await waitFor(
          () => harness.project.text(harness.key).toString() === 'alpha beta',
          3_000,
          'local editor edit to reach canonical Yjs text',
        );
        assert.equal(harness.document.getText(), 'alpha beta');
        assert.ok(localUpdates >= 1, 'a genuine editor edit must author at least one local project update');
      } finally {
        harness.project.off('update', onUpdate);
      }
    } finally {
      await harness.dispose();
    }
  });

  test('preserves a native multi-range local WorkspaceEdit exactly once', async () => {
    const harness = await createTextHarness('print(a');
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(harness.document.uri, harness.document.positionAt(0), '#');
      edit.insert(harness.document.uri, harness.document.positionAt(harness.document.getText().length), ')');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitFor(
        () => harness.project.text(harness.key).toString() === '#print(a)',
        3_000,
        'multi-range local WorkspaceEdit to converge',
      );
      await delay(150);
      assert.equal(harness.document.getText(), '#print(a)');
      assert.equal(harness.project.text(harness.key).toString(), '#print(a)');
    } finally {
      await harness.dispose();
    }
  });

  test('does not republish a VS Code-minimized remote replacement as duplicate local text', async () => {
    const harness = await createTextHarness('print(a');
    try {
      let nonRemoteUpdates = 0;
      const onUpdate = (event: ProjectUpdate): void => {
        if (event.key === harness.key && event.origin !== REMOTE_ORIGIN) nonRemoteUpdates += 1;
      };
      harness.project.on('update', onUpdate);
      try {
        harness.project.replaceText(harness.key, '#print(a)', REMOTE_ORIGIN);
        await waitFor(() => harness.document.getText() === '#print(a)', 3_000, 'remote projection into VS Code');
        await delay(250);
        assert.equal(harness.document.getText(), '#print(a)');
        assert.equal(harness.project.text(harness.key).toString(), '#print(a)');
        assert.equal(nonRemoteUpdates, 0, 'projection echoes must never become fresh local CRDT operations');
      } finally {
        harness.project.off('update', onUpdate);
      }
    } finally {
      await harness.dispose();
    }
  });

  test('does not duplicate a remote newline when VS Code reshapes the projection event', async () => {
    const harness = await createTextHarness('print(a');
    try {
      let nonRemoteUpdates = 0;
      const onUpdate = (event: ProjectUpdate): void => {
        if (event.key === harness.key && event.origin !== REMOTE_ORIGIN) nonRemoteUpdates += 1;
      };
      harness.project.on('update', onUpdate);
      try {
        harness.project.replaceText(harness.key, '#print(a\n', REMOTE_ORIGIN);
        await waitFor(() => normalizeEol(harness.document.getText()) === '#print(a\n', 3_000, 'remote newline projection into VS Code');
        await delay(250);
        assert.equal(harness.project.text(harness.key).toString(), '#print(a\n');
        assert.equal(nonRemoteUpdates, 0, 'a remote newline projection must not create a local newline echo');
      } finally {
        harness.project.off('update', onUpdate);
      }
    } finally {
      await harness.dispose();
    }
  });

  test.skip('KNOWN #19: keeps genuine local typing during the 100 ms post-projection quarantine', async () => {
    // Real VS Code E2E on Windows, Linux, macOS, and minimum VS Code 1.95.0
    // confirmed that suppressProjectionTail currently treats this genuine edit
    // as a delayed projection tail. Keep the exact regression visible until
    // https://github.com/r7zex/jupyter_pair_ext/issues/19 is fixed in src/**.
    const harness = await createTextHarness('alpha');
    try {
      harness.project.replaceText(harness.key, '#alpha', REMOTE_ORIGIN);
      await waitFor(() => harness.document.getText() === '#alpha', 3_000, 'remote prefix projection');
      const edit = new vscode.WorkspaceEdit();
      edit.insert(harness.document.uri, harness.document.positionAt(harness.document.getText().length), '!');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitFor(() => harness.project.text(harness.key).toString() === '#alpha!', 3_000, 'immediate local edit');
    } finally {
      await harness.dispose();
    }
  });

  test('keeps immediate local typing on a different line during projection quarantine', async () => {
  const harness = await createTextHarness('remote = 0\nlocal = 0');
  try {
    harness.project.applyTextChanges(harness.key, [{ offset: 9, deleteCount: 1, insertText: '1' }], REMOTE_ORIGIN);
    await waitFor(
      () => (harness.synchronizer as any).projectionQuarantines.has(harness.document.uri.toString()),
      3_000,
      'post-projection guard to arm before different-line file edit',
    );
    assert.equal(normalizeEol(harness.document.getText()), 'remote = 1\nlocal = 0');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(harness.document.uri, harness.document.lineAt(1).range.end, ' + 1');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor(() => harness.project.text(harness.key).toString() === 'remote = 1\nlocal = 0 + 1', 3_000,
      'different-line local edit during quarantine');
    assert.equal(harness.document.getText(), 'remote = 1\nlocal = 0 + 1');
  } finally { await harness.dispose(); }
});

  test('authors genuine local typing after the projection-tail quarantine has expired', async () => {
    const harness = await createTextHarness('alpha');
    try {
      harness.project.replaceText(harness.key, '#alpha', REMOTE_ORIGIN);
      await waitFor(() => harness.document.getText() === '#alpha', 3_000, 'remote prefix projection');
      await delay(150);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(harness.document.uri, harness.document.positionAt(harness.document.getText().length), '!');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitFor(
        () => harness.project.text(harness.key).toString() === '#alpha!',
        3_000,
        'post-quarantine typing to remain authored',
      );
      assert.equal(harness.document.getText(), '#alpha!');
    } finally {
      await harness.dispose();
    }
  });

  test('serializes a burst of remote canonical replacements and renders only the newest state', async function () {
    this.timeout(10_000);
    const harness = await createTextHarness('state-0');
    try {
      for (let index = 1; index <= 25; index += 1) {
        harness.project.replaceText(harness.key, `state-${index}`, REMOTE_ORIGIN);
      }
      await waitFor(() => harness.document.getText() === 'state-25', 7_000, 'remote projection burst to drain');
      await delay(200);
      assert.equal(harness.document.getText(), 'state-25');
      assert.equal(harness.project.text(harness.key).toString(), 'state-25');
    } finally {
      await harness.dispose();
    }
  });

  test('keeps a large real TextDocument byte-for-byte aligned with canonical state', async function () {
    this.timeout(10_000);
    const initial = `${'0123456789abcdef'.repeat(4_096)}\nend`;
    const target = `# header\n${initial}\n# footer`;
    const harness = await createTextHarness(initial);
    try {
      harness.project.replaceText(harness.key, target, REMOTE_ORIGIN);
      await waitFor(() => harness.document.getText() === target, 7_000, 'large remote text projection');
      assert.equal(harness.document.getText(), target);
      assert.equal(harness.project.text(harness.key).toString(), target);
    } finally {
      await harness.dispose();
    }
  });

  test('never binds a sensitive .ssh file opened by the real VS Code editor', async () => {
    const harness = await createTextHarness('PRIVATE KEY MATERIAL', '.ssh/private-key.txt', false);
    try {
      await delay(150);
      assert.equal(harness.project.keys().length, 0);
    } finally {
      await harness.dispose();
    }
  });
});

interface TextHarness {
  readonly root: string;
  readonly key: string;
  readonly document: vscode.TextDocument;
  readonly project: CollaborativeProject;
  readonly synchronizer: EditorSynchronizer;
  readonly log: vscode.OutputChannel;
  dispose(): Promise<void>;
}

async function createTextHarness(
  initial: string,
  relativePath = 'notes.txt',
  seedProject = true,
): Promise<TextHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-editor-e2e-'));
  const key = relativePath.replaceAll('\\', '/');
  const absolutePath = path.join(root, ...key.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, initial, 'utf8');

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const project = new CollaborativeProject();
  if (seedProject) project.ensureText(key, initial);
  const log = vscode.window.createOutputChannel(`Pair Notebook E2E ${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const synchronizer = new EditorSynchronizer(project, root, log);
  await delay(50);

  return {
    root,
    key,
    document,
    project,
    synchronizer,
    log,
    dispose: async () => {
      synchronizer.dispose();
      project.destroy();
      log.dispose();
      if (!document.isClosed) {
        try {
          await document.save();
        } catch {
          // Cleanup is best-effort; assertions have already completed.
        }
        if (!document.isClosed) {
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const effectiveTimeoutMs = process.platform === 'win32' ? Math.max(timeoutMs, 10_000) : timeoutMs;
  const deadline = Date.now() + effectiveTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}.${detail}`);
}

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
