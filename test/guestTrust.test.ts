import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
const tree = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const declaration = (name: string) => tree.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name)!.getText(tree);

describe('guest Workspace Trust handoff', () => {
  it('opens only an empty staged workspace before the trust prompt, without fetching host files', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-trust-handoff-'));
    try {
      const folder = path.join(fixture, 'workspace');
      let opened = false;
      const context = vm.createContext({
        requireTrustedWorkspaceForSessionStart: async () => true,
        applyMeshNetworkConfiguration: async () => undefined,
        vscode: { window: { showInputBox: async () => 'invite' }, ConfigurationTarget: { Global: 1 },
          workspace: { getConfiguration: () => ({ update: async () => undefined, get: (_key: string, fallback: unknown) => fallback }) } },
        parseInvite: () => ({ sessionId: 'session', projectId: 'project', projectName: 'Project', token: 'token', hostPeerId: 'host', hostDisplayName: 'Host', hostIdentityKey: 'key', sessionEpoch: 1 }),
        promptDisplayName: async () => 'Guest', displayName: () => 'Guest',
        newId: () => 'guest', generateIdentityCredentials: () => ({ publicKey: 'key', privateKey: 'private' }),
        sessionWorkingFolder: () => folder, mkdir, rm,
        saveDescriptor: async (_context: unknown, descriptor: { joinPending: boolean; temporaryGuest: boolean }) => {
          assert.equal(descriptor.joinPending, true); assert.equal(descriptor.temporaryGuest, true);
          await writeFile(path.join(folder, '.pair-notebook-session.json'), JSON.stringify(descriptor));
        },
        openSessionWorkingFolder: async () => {
          assert.deepEqual(await readdir(folder), ['.pair-notebook-session.json']); opened = true;
        },
        downloadProjectSnapshot: () => { throw new Error('Host files fetched before Workspace Trust'); },
      });
      const code = `let runtime, persistentController, workspaceSessionRestore, invitedRelayUrl; ${declaration('joinSession')} globalThis.join = joinSession;`;
      vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
      await context.join({}); assert.equal(opened, true);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
  it('blocks network download while the staged folder is still untrusted', async () => {
    let downloads = 0;
    const context = vm.createContext({ vscode: { workspace: { isTrusted: false } },
      downloadProjectSnapshot: () => { downloads++; } });
    vm.runInContext(ts.transpileModule(`${declaration('receiveTrustedGuestSnapshot')} globalThis.receive = receiveTrustedGuestSnapshot;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    await assert.rejects(context.receive({}, {}), /Trust the empty session folder/);
    assert.equal(downloads, 0);
  });
});
