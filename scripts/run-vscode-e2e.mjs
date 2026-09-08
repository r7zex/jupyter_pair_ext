import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionTestsPath = path.join(projectRoot, 'out', 'test', 'e2e', 'suite', 'index.js');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-vscode-e2e-'));
const workspaceDir = path.join(tempRoot, 'workspace');
const userDataDir = path.join(tempRoot, 'user-data');
const extensionsDir = path.join(tempRoot, 'extensions');
const timeoutMs = Number.parseInt(process.env.PAIR_NOTEBOOK_E2E_TIMEOUT_MS ?? '180000', 10);

await Promise.all([
  mkdir(workspaceDir, { recursive: true }),
  mkdir(userDataDir, { recursive: true }),
  mkdir(extensionsDir, { recursive: true }),
]);
await writeFile(path.join(workspaceDir, 'README.txt'), 'Pair Notebook VS Code Extension Host E2E workspace.\n', 'utf8');
await assertReadable(extensionTestsPath, 'Compile the project before running E2E tests.');

const inheritedEnv = {
  ...process.env,
  PAIR_NOTEBOOK_E2E: '1',
  PAIR_NOTEBOOK_E2E_WORKSPACE: workspaceDir,
};

const launchArgs = [
  workspaceDir,
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${extensionsDir}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-updates',
  '--disable-gpu',
  '--new-window',
];

try {
  const driver = process.env.PAIR_NOTEBOOK_E2E_DRIVER?.trim().toLowerCase();
  if (driver === 'test-electron') {
    await runWithTestElectron(launchArgs);
  } else {
    await runWithInstalledVSCode(launchArgs);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function runWithTestElectron(args) {
  let testElectron;
  try {
    testElectron = await import('@vscode/test-electron');
  } catch (error) {
    throw new Error(
      'PAIR_NOTEBOOK_E2E_DRIVER=test-electron requires @vscode/test-electron. '
      + 'CI installs it ephemerally without changing production dependencies.',
      { cause: error },
    );
  }

  const version = process.env.PAIR_NOTEBOOK_E2E_VSCODE_VERSION?.trim() || 'stable';
  const timer = createTimeout(timeoutMs, `VS Code E2E exceeded ${timeoutMs} ms.`);
  try {
    await Promise.race([
      testElectron.runTests({
        version,
        extensionDevelopmentPath: projectRoot,
        extensionTestsPath,
        launchArgs: args,
        extensionTestsEnv: inheritedEnv,
      }),
      timer.promise,
    ]);
  } finally {
    timer.cancel();
  }
}

async function runWithInstalledVSCode(args) {
  const executable = await resolveVSCodeExecutable();
  const fullArgs = [
    ...args,
    `--extensionDevelopmentPath=${projectRoot}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(executable, fullArgs, {
      cwd: projectRoot,
      env: inheritedEnv,
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
    const located = locator.stdout.split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
    if (located && await isReadable(located)) return located;
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
