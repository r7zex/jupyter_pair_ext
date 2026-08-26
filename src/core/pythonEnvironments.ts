import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ENVIRONMENT_CANDIDATES = 64;
const ENVIRONMENT_PROBE_CONCURRENCY = 4;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

export interface PythonEnvironment {
  executable: string;
  version: string;
  environment: string;
  jupyterReady: boolean;
  torchVersion: string;
  cudaAvailable: boolean;
  source: string;
}

export async function discoverPythonEnvironments(workspaceRoot: string, configured: string): Promise<PythonEnvironment[]> {
  const candidates = new Map<string, string>();
  const add = (value: string | undefined, source: string) => {
    const normalized = value?.trim().replace(/^"|"$/g, '');
    if (!normalized || normalized.length > 4096 || /[\0\r\n]/.test(normalized)
      || candidates.size >= MAX_ENVIRONMENT_CANDIDATES) return;
    const key = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
    if (![...candidates.keys()].some((candidate) =>
      (process.platform === 'win32' ? candidate.toLocaleLowerCase('en-US') : candidate) === key)) {
      candidates.set(normalized, source);
    }
  };
  add(configured, 'Pair Notebook setting');
  const binary = process.platform === 'win32' ? 'python.exe' : 'python';
  for (const relative of [path.join('.venv', process.platform === 'win32' ? 'Scripts' : 'bin', binary), path.join('venv', process.platform === 'win32' ? 'Scripts' : 'bin', binary)]) {
    const candidate = path.join(workspaceRoot, relative);
    try {
      await access(candidate);
      add(candidate, 'Workspace environment');
    } catch { /* not present */ }
  }
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = process.platform === 'win32' ? ['python.exe'] : ['-a', 'python3', 'python'];
    const { stdout } = await execFileAsync(command, args, {
      timeout: 4000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    for (const value of stdout.split(/\r?\n/)) add(value, 'PATH');
  } catch { /* PATH discovery is best effort */ }
  try {
    const { stdout } = await execFileAsync('conda', ['env', 'list', '--json'], {
      timeout: 6000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    const data = JSON.parse(stdout) as { envs?: unknown };
    if (Array.isArray(data.envs)) {
      for (const environment of data.envs.slice(0, MAX_ENVIRONMENT_CANDIDATES)) {
        if (typeof environment === 'string' && environment.length <= 4096) {
          add(path.join(environment, process.platform === 'win32' ? 'python.exe' : 'bin/python'), 'Conda');
        }
      }
    }
  } catch { /* conda is optional */ }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('py', ['-0p'], {
        timeout: 4000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      });
      for (const line of stdout.split(/\r?\n/)) add(/\s([A-Za-z]:\\.*python\.exe)\s*$/.exec(line)?.[1], 'Python Launcher');
    } catch { /* launcher is optional */ }
  }
  const entries = [...candidates];
  const inspected: Array<PythonEnvironment | undefined> = new Array(entries.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(ENVIRONMENT_PROBE_CONCURRENCY, entries.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      if (!entry) return;
      const [executable, source] = entry;
      inspected[index] = await inspectEnvironment(executable, source);
    }
  }));
  return inspected.filter((value): value is PythonEnvironment => Boolean(value));
}

async function inspectEnvironment(executable: string, source: string): Promise<PythonEnvironment | undefined> {
  const script = [
    'import json,sys',
    'ready=True',
    'try:',
    ' import jupyter_client,ipykernel',
    'except Exception:',
    ' ready=False',
    'torch_version=""',
    'cuda=False',
    'try:',
    ' import torch',
    ' torch_version=str(torch.__version__)',
    ' cuda=bool(torch.cuda.is_available())',
    'except Exception:',
    ' pass',
    'print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"environment":sys.prefix,"jupyterReady":ready,"torchVersion":torch_version,"cudaAvailable":cuda}))',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync(executable, ['-c', script], {
      timeout: 7000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    return sanitizeEnvironment(JSON.parse(stdout.trim()), source);
  } catch {
    return undefined;
  }
}

function sanitizeEnvironment(value: unknown, source: string): PythonEnvironment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const executable = boundedString(raw.executable, 4096, false);
  const version = boundedString(raw.version, 128);
  const environment = boundedString(raw.environment, 4096, false);
  if (!executable || !version || !environment) return undefined;
  return {
    executable,
    version,
    environment,
    jupyterReady: raw.jupyterReady === true,
    torchVersion: boundedString(raw.torchVersion, 128) ?? '',
    cudaAvailable: raw.cudaAvailable === true,
    source,
  };
}

function boundedString(value: unknown, maxLength: number, trim = true): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) return undefined;
  const result = trim ? value.trim() : value;
  return result ? result : undefined;
}
