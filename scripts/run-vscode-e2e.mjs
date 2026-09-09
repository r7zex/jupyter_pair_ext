import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trustScenario = process.env.PAIR_NOTEBOOK_E2E_TRUST === '1' || process.argv.includes('--trust');
const extensionTestsPath = path.join(
  projectRoot,
  'out',
  'test',
  'e2e',
  'suite',
  'index.js',
);
// VS Code creates IPC sockets below --user-data-dir. macOS limits UNIX socket
// paths to roughly 104 bytes, while os.tmpdir() on hosted runners lives under
// a long /var/folders/... prefix. Keep the E2E root deliberately short there.
const tempBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
const tempRoot = await mkdtemp(path.join(tempBase, 'pn-e2e-'));
const workspaceDir = path.join(tempRoot, 'workspace');
const userDataDir = path.join(tempRoot, 'user-data');
const extensionsDir = path.join(tempRoot, 'extensions');
const trustHandoffPath = path.join(tempRoot, 'trust-handoff.json');
const timeoutMs = Number.parseInt(process.env.PAIR_NOTEBOOK_E2E_TIMEOUT_MS ?? '180000', 10);

await Promise.all([
  mkdir(workspaceDir, { recursive: true }),
  mkdir(userDataDir, { recursive: true }),
  mkdir(extensionsDir, { recursive: true }),
]);
await writeFile(path.join(workspaceDir, 'README.txt'), 'Pair Notebook VS Code Extension Host E2E workspace.\n', 'utf8');
await mkdir(path.join(userDataDir, 'User'), { recursive: true });
await writeFile(path.join(userDataDir, 'User', 'settings.json'), `${JSON.stringify({
  'security.workspace.trust.enabled': true,
  'security.workspace.trust.startupPrompt': trustScenario ? 'always' : 'never',
})}\n`, 'utf8');
await assertReadable(extensionTestsPath, 'Compile the project before running E2E tests.');

const inheritedEnv = {
  ...process.env,
  PAIR_NOTEBOOK_E2E: '1',
  PAIR_NOTEBOOK_E2E_TRUST: trustScenario ? '1' : '0',
  PAIR_NOTEBOOK_E2E_WORKSPACE: workspaceDir,
};

try {
  if (trustScenario) {
    await runWorkspaceTrustHandoff();
  } else {
    await runVSCodeE2E(createLaunchArgs(workspaceDir, ['--disable-workspace-trust']), inheritedEnv);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

function createLaunchArgs(workspace, additionalArgs = []) {
  return [
    workspace,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    '--disable-gpu',
    '--new-window',
    ...additionalArgs,
  ];
}

async function runVSCodeE2E(args, environment) {
  const driver = process.env.PAIR_NOTEBOOK_E2E_DRIVER?.trim().toLowerCase();
  if (driver === 'test-electron') await runWithTestElectron(args, environment);
  else await runWithInstalledVSCode(args, environment);
}

async function runWorkspaceTrustHandoff() {
  const debugPort = await reserveTcpPort();
  const environment = {
    ...inheritedEnv,
    PAIR_NOTEBOOK_E2E_TRUST_STAGE: 'external-handoff',
    PAIR_NOTEBOOK_E2E_TRUST_HANDOFF: trustHandoffPath,
  };
  const args = createLaunchArgs(workspaceDir, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
  ]);
  const driver = process.env.PAIR_NOTEBOOK_E2E_DRIVER?.trim().toLowerCase();
  if (driver === 'test-electron') {
    const testElectron = await loadTestElectron();
    const version = process.env.PAIR_NOTEBOOK_E2E_VSCODE_VERSION?.trim() || 'stable';
    const executable = await testElectron.downloadAndUnzipVSCode({
      version,
      cachePath: path.join(tempRoot, 'vscode-runtime'),
      extensionDevelopmentPath: projectRoot,
    });
    await driveWorkspaceTrustHandoff(executable, [
      ...args,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--no-cached-data',
      `--extensionDevelopmentPath=${projectRoot}`,
    ], environment, debugPort);
    return;
  }
  const executable = await resolveVSCodeExecutable();
  await driveWorkspaceTrustHandoff(executable, [
    ...args,
    `--extensionDevelopmentPath=${projectRoot}`,
  ], environment, debugPort);
}

async function driveWorkspaceTrustHandoff(executable, args, environment, debugPort) {
  const child = spawn(executable, args, {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitForWorkspaceTrustButton(debugPort, true, timeoutMs, 'source Workspace Trust button');
    await waitForPairNotebookActivity(debugPort, timeoutMs);
    const handoff = await waitForJsonFile(trustHandoffPath, timeoutMs, 'durable pending Start handoff');
    const descriptor = handoff?.descriptor;
    if (!descriptor || typeof descriptor.workingFolder !== 'string') {
      throw new Error('Workspace Trust E2E handoff has no valid working-folder descriptor.');
    }
    await waitForWorkspaceTrustButton(debugPort, false, timeoutMs, 'isolated workspace Restricted Mode');
    if (await isReadable(handoff.ownerPath)) {
      throw new Error('Pending runtime ownership began before the isolated workspace was trusted.');
    }
    const pendingControl = await readJsonFile(handoff.controlPath, 'pending launch control');
    if (pendingControl.state !== 'pending') throw new Error(`Expected pending control, got ${pendingControl.state}.`);
    assertLaunchIdentity(pendingControl, descriptor);
    await assertSingleParticipantRoot(handoff.controlRoot, descriptor.localPeer.peerId);

    await waitForWorkspaceTrustButton(debugPort, true, timeoutMs, 'isolated workspace Trust button');
    const owner = await waitForJsonFile(handoff.ownerPath, timeoutMs, 'automatic pending-launch ownership');
    if (owner.launchId !== pendingControl.launchId) {
      throw new Error('Automatic resume did not retain the original launch identity.');
    }
    const resumedControl = await readJsonFile(handoff.controlPath, 'resumed launch control');
    assertLaunchIdentity(resumedControl, descriptor);
    const resumedMarker = await readJsonFile(
      path.join(descriptor.workingFolder, '.pair-notebook-session.json'),
      'resumed session marker',
    );
    assertLaunchIdentity(resumedMarker, descriptor);
    await assertSingleParticipantRoot(handoff.controlRoot, descriptor.localPeer.peerId);
    const sourceContents = await readFile(path.join(workspaceDir, 'README.txt'), 'utf8');
    if (sourceContents !== 'Pair Notebook VS Code Extension Host E2E workspace.\n') {
      throw new Error('The original source workspace changed across the Trust handoff.');
    }
    process.stdout.write('Workspace Trust E2E passed: one Start identity resumed after openFolder and real Trust.\n');
  } finally {
    child.kill();
    await Promise.race([exited, delay(5_000)]);
  }
}

async function reserveTcpPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error('Could not reserve a local DevTools port for Workspace Trust E2E.'));
      });
    });
  });
}

async function waitForWorkspaceTrustButton(port, click, timeout, label) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) throw new Error(`DevTools target discovery returned HTTP ${response.status}.`);
      const targets = await response.json();
      for (const target of targets) {
        if (!target.webSocketDebuggerUrl || target.type !== 'page') continue;
        if (await workspaceTrustButtonAction(target.webSocketDebuggerUrl, click)) return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Workspace Trust E2E did not reach ${label}.${detail}`);
}

async function workspaceTrustButtonAction(webSocketUrl, click) {
  const expression = `(() => {
    const buttons = [...document.querySelectorAll('.monaco-button, button')];
    const button = buttons.find((candidate) => !candidate.disabled && candidate.offsetParent !== null
      && /trust (the )?authors|^trust( folder)?$|довер/i.test(
        candidate.textContent || candidate.getAttribute('aria-label') || '',
      ));
    if (!button) return false;
    if (${click ? 'true' : 'false'}) button.click();
    return true;
  })()`;
  return await evaluateCdpBoolean(webSocketUrl, expression);
}

async function waitForPairNotebookActivity(port, timeout) {
  const expression = `(() => {
    const reload = [...document.querySelectorAll('.monaco-button, button')].find((candidate) =>
      candidate.offsetParent !== null && /reload and enable extensions|перезагруз/i.test(candidate.textContent || '')
    );
    if (reload) {
      reload.click();
      return false;
    }
    const items = [...document.querySelectorAll('.activitybar .action-label')];
    const item = items.find((candidate) => {
      const label = [candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.textContent]
        .filter(Boolean).join(' ');
      return /Pair Notebook/i.test(label) && candidate.offsetParent !== null;
    });
    if (!item) return false;
    item.click();
    return true;
  })()`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = response.ok ? await response.json() : [];
      for (const target of targets) {
        if (target.type === 'page' && target.webSocketDebuggerUrl
          && await evaluateCdpBoolean(target.webSocketDebuggerUrl, expression)) return;
      }
    } catch {
      // The workbench target is still starting or reloading.
    }
    await delay(100);
  }
  throw new Error('Workspace Trust E2E could not activate the Pair Notebook view in the trusted source.');
}

async function evaluateCdpBoolean(webSocketUrl, expression) {
  return await new Promise((resolve) => {
    const socket = new globalThis.WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 1_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message.result?.result?.value === true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForJsonFile(target, timeout, label) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readJsonFile(target, label);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

async function readJsonFile(target, label) {
  const value = JSON.parse(await readFile(target, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value;
}

function assertLaunchIdentity(actual, expected) {
  const peerId = actual.peerId ?? actual.localPeer?.peerId;
  if (actual.sessionId !== expected.sessionId
    || actual.projectId !== expected.projectId
    || peerId !== expected.localPeer.peerId) {
    throw new Error('Workspace Trust E2E observed a changed session/project/peer identity.');
  }
  if (actual.workingFolderRealPath
    && pathComparisonKey(actual.workingFolderRealPath) !== pathComparisonKey(expected.workingFolder)) {
    throw new Error('Workspace Trust E2E observed a changed physical working folder.');
  }
  if (actual.localPeer?.identityKey && actual.localPeer.identityKey !== expected.localPeer.identityKey) {
    throw new Error('Workspace Trust E2E observed a changed public identity key.');
  }
}

async function assertSingleParticipantRoot(controlRoot, peerId) {
  const entries = await readdir(path.dirname(controlRoot));
  if (entries.length !== 1 || entries[0] !== peerId) {
    throw new Error(`Workspace Trust E2E created duplicate participant controls: ${entries.join(', ')}`);
  }
}

function pathComparisonKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadTestElectron() {
  const explicitModule = process.env.PAIR_NOTEBOOK_E2E_TEST_ELECTRON_PATH?.trim();
  const moduleSpecifier = explicitModule
    ? pathToFileURL(path.resolve(projectRoot, explicitModule)).href
    : '@vscode/test-electron';
  try {
    return await import(moduleSpecifier);
  } catch (error) {
    throw new Error(
      'PAIR_NOTEBOOK_E2E_DRIVER=test-electron requires @vscode/test-electron. '
      + 'Install it outside the production dependency tree or set PAIR_NOTEBOOK_E2E_TEST_ELECTRON_PATH.',
      { cause: error },
    );
  }
}

async function runWithTestElectron(args, environment) {
  const testElectron = await loadTestElectron();
  const version = process.env.PAIR_NOTEBOOK_E2E_VSCODE_VERSION?.trim() || 'stable';
  const timer = createTimeout(timeoutMs, `VS Code E2E exceeded ${timeoutMs} ms.`);
  try {
    await Promise.race([
      testElectron.runTests({
        version,
        extensionDevelopmentPath: projectRoot,
        extensionTestsPath,
        launchArgs: args,
        extensionTestsEnv: environment,
      }),
      timer.promise,
    ]);
  } finally {
    timer.cancel();
  }
}

async function runWithInstalledVSCode(args, environment) {
  const executable = await resolveVSCodeExecutable();
  const fullArgs = [
    ...args,
    `--extensionDevelopmentPath=${projectRoot}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];

  await runVSCodeExecutable(executable, fullArgs, environment);
}

async function runVSCodeExecutable(executable, fullArgs, environment) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, fullArgs, {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit',
      windowsHide: false,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`VS Code E2E exceeded ${timeoutMs} ms and was terminated.`));
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`VS Code E2E failed (exit=${String(code)}, signal=${String(signal)}).`));
    });
  });
}

async function resolveVSCodeExecutable() {
  const explicit = process.env.PAIR_NOTEBOOK_VSCODE_PATH?.trim();
  if (explicit) {
    await assertReadable(explicit, 'PAIR_NOTEBOOK_VSCODE_PATH does not point to a readable VS Code executable.');
    return explicit;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      path.join(os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Code'),
      path.join(os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
    );
  } else {
    candidates.push('/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code');
  }

  for (const candidate of candidates) {
    if (await isReadable(candidate)) return candidate;
  }

  const locator = process.platform === 'win32'
    ? spawnSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('which', ['code'], { encoding: 'utf8' });
  if (locator.status === 0) {
    const located = locator.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
    for (const commandPath of located) {
      if (process.platform === 'win32' && path.basename(path.dirname(commandPath)).toLowerCase() === 'bin') {
        const siblingExecutable = path.join(path.dirname(path.dirname(commandPath)), 'Code.exe');
        if (await isReadable(siblingExecutable)) return siblingExecutable;
      }
      if (process.platform !== 'win32' || path.extname(commandPath).toLowerCase() === '.exe') {
        if (await isReadable(commandPath)) return commandPath;
      }
    }
  }

  throw new Error(
    'Could not find VS Code. Set PAIR_NOTEBOOK_VSCODE_PATH to Code.exe/Code, '
    + 'or run in CI with PAIR_NOTEBOOK_E2E_DRIVER=test-electron.',
  );
}

function createTimeout(ms, message) {
  let handle;
  const promise = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

async function assertReadable(filePath, suffix) {
  if (!await isReadable(filePath)) throw new Error(`${filePath} is not readable. ${suffix}`);
}

async function isReadable(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
