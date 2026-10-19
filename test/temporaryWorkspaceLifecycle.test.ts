import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { claimGuestWorkspace, preserveGuestBuffers, sweepGuestWorkspaces } from '../src/vscode/temporarySessions';

const { removeGuest } = createRequire(__filename)(path.resolve(__dirname, '../../media/cleanup-session.cjs'));
const records = async (file: string): Promise<any[]> => gunzipSync(await readFile(file)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
async function archiveFile(base: string): Promise<string> {
  const directory = path.join(base, 'recovery', 'temporary-sessions');
  return path.join(directory, (await readdir(directory)).find(name => name.endsWith('.jsonl.gz'))!);
}
async function waitRemoved(directory: string): Promise<void> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try { await access(directory); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Temporary working copy was not removed.');
}

describe('temporary workspace lifecycle and recovery', () => {
  let fixture: string;
  let base: string;
  let target: string;
  let context: any;
  let descriptor: any;
  beforeEach(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-session-lifecycle-'));
    base = path.join(fixture, 'pair-notebook.pair-notebook');
    target = path.join(base, 'sessions', 'session', 'peer');
    descriptor = { sessionId: 'session', localPeer: { peerId: 'peer' }, role: 'host', workingFolder: path.join(target, 'workspace') };
    context = { extensionPath: path.resolve(__dirname, '../..'), globalStorageUri: { fsPath: base } };
    await mkdir(descriptor.workingFolder, { recursive: true });
    await writeFile(path.join(descriptor.workingFolder, 'unchanged.py'), 'print(1)');
  });
  afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

  it('archives markerless legacy copies before reclaiming them', async () => {
    assert.deepEqual(await sweepGuestWorkspaces(context, []), [descriptor.workingFolder]);
    await waitRemoved(target);
    const archive = await records(await archiveFile(base));
    assert.equal(Buffer.from(archive[1].content, 'base64').toString(), 'print(1)');
    assert.equal(archive[1].path, 'workspace/unchanged.py');
  });

  it('retains open documents and live leases during the orphan sweep', async () => {
    assert.deepEqual(await sweepGuestWorkspaces(context, [path.join(descriptor.workingFolder, 'unchanged.py')]), []);
    await claimGuestWorkspace(context, descriptor);
    assert.deepEqual(await sweepGuestWorkspaces(context, []), []);
    await access(target);
  });

  it('keeps changed files, dirty buffers and journals without archiving the clean project', async () => {
    await claimGuestWorkspace(context, descriptor);
    await writeFile(path.join(descriptor.workingFolder, 'changed.py'), 'saved local change');
    await writeFile(path.join(target, 'journal'), 'unsent operations');
    await preserveGuestBuffers(context, descriptor, [{ relativePath: 'changed.py', bytes: Buffer.from('unsaved local change') }]);
    await writeFile(path.join(target, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, sessionId: 'session', peerId: 'peer' }));
    assert.equal(await removeGuest(base, target), true);
    const archive = await records(await archiveFile(base));
    assert.deepEqual(archive.slice(1).map(record => record.path).sort(), ['buffers/changed.py', 'journal', 'workspace/changed.py']);
    assert.equal(Buffer.from(archive.find(record => record.path === 'buffers/changed.py').content, 'base64').toString(), 'unsaved local change');
  });

  it('reclaims a clean copy without producing a project recovery archive', async () => {
    await claimGuestWorkspace(context, descriptor);
    await writeFile(path.join(target, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, sessionId: 'session', peerId: 'peer' }));
    assert.equal(await removeGuest(base, target), true);
    await assert.rejects(readdir(path.join(base, 'recovery')), /ENOENT/);
  });

  it('cleans an editor-owned copy after its process exits without deactivate', async () => {
    const module = path.resolve(__dirname, '../src/vscode/temporarySessions.js');
    const source = 'const input=JSON.parse(process.argv[2]);require(process.argv[1]).claimGuestWorkspace(input.context,input.descriptor).then(()=>process.exit(0),()=>process.exit(1));';
    const child = spawn(process.execPath, ['-e', source, module, JSON.stringify({ context, descriptor })], { windowsHide: true, stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    await waitRemoved(target);
  });
});
