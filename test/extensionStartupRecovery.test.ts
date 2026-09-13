import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { awaitFailedStartupCleanup, SessionStartCancelledError } from '../src/core/startupRecovery';

// Execute the real extension failure handler and command gate with deferred
// VS Code UI promises. Importing the extension would activate unrelated APIs.
const source = readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
const tree = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const functions = tree.statements.filter(ts.isFunctionDeclaration);
const find = (name: string) => functions.find((node) => node.name?.text === name)!;
const restore = find('restoreWorkspaceSession');
const startupTry = restore.body!.statements.find((node) => ts.isTryStatement(node)
  && node.tryBlock.getText(tree).includes('new SessionRuntime')) as ts.TryStatement;
const start = find('startSession');
const gateEnd = start.body!.statements.findIndex((node) => node.getText(tree).includes('await applyMeshNetworkConfiguration'));
const gate = start.body!.statements.slice(0, gateEnd).map((node) => node.getText(tree)).join('\n');
const helpers = ['startWorkspaceSessionRestore', 'showLocalRouteFailedMessage'].map((name) => find(name).getText(tree)).join('\n');

describe('extension retry after startup failure', () => {
  for (const hungCleanup of [false, true]) {
    it(`releases the real Start gate with ${hungCleanup ? 'cleanup' : 'warning'} still pending`, async () => {
      let dismiss!: () => void;
      let finishCleanup!: () => void;
      let warnings = 0;
      const warning = new Promise<void>((resolve) => { dismiss = resolve; });
      const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
      const context = vm.createContext({
        output: { appendLine() {} }, descriptor: {},
        formatError: (error: Error) => error.message,
        SessionTerminatedError: class extends Error {}, SessionStartCancelledError,
        awaitFailedStartupCleanup: (task: Promise<unknown>) => awaitFailedStartupCleanup(task, 20),
        requireTrustedWorkspaceForSessionStart: async () => true,
        vscode: { window: {
          showWarningMessage: () => { warnings += 1; return warning; },
          showErrorMessage: () => Promise.resolve(),
        } },
        fakeRuntime: { terminalLifecycle: () => ({ reason: 'local-route-failed' }),
          networkDiagnostics: () => ({}), leave: () => hungCleanup ? cleanup : Promise.resolve() },
      });
      const code = `
        let runtime = fakeRuntime, lifecycleReadyRuntime, workspaceSessionRestore;
        async function restoreWorkspaceSession(context) {
          const startupRuntime = runtime;
          try { throw new Error('injected transport failure'); } ${startupTry.catchClause!.getText(tree)}
        }
        ${helpers}
        async function tryStartAgain() { ${gate} return 'allowed'; }
        globalThis.begin = () => startWorkspaceSessionRestore({});
        globalThis.retry = tryStartAgain;
        globalThis.installNewRuntime = () => { runtime = { id: 'next-attempt' }; };
        globalThis.currentRuntime = () => runtime;
      `;
      vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
      await context.begin();
      assert.equal(warnings, 1);
      assert.equal(await context.retry(), 'allowed');
      context.installNewRuntime();
      finishCleanup();
      dismiss();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(context.currentRuntime().id, 'next-attempt');
    });
  }
});
