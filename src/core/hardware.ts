import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_GPUS = 16;
let nvidiaAvailable: boolean | undefined;

export interface GpuInfo {
  index: number;
  vendor: string;
  model: string;
  vramMb: number;
  driver: string;
  cudaVersion: string;
  utilizationPercent: number;
  memoryUsedMb: number;
}

export interface PythonInfo {
  executable: string;
  version: string;
  torchInstalled: boolean;
  torchVersion: string;
  torchCudaAvailable: boolean;
  torchCudaVersion: string;
  cudaDeviceNames: string[];
}

export interface HardwareInfo {
  cpuModel: string;
  physicalCores?: number | undefined;
  logicalThreads: number;
  totalRamMb: number;
  availableRamMb: number;
  gpus: GpuInfo[];
  python: PythonInfo;
  discoveredAt: number;
}

export interface ResourceSample {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  gpus: Array<Pick<GpuInfo, 'index' | 'utilizationPercent' | 'memoryUsedMb' | 'vramMb'>>;
  sampledAt: number;
}

export interface CpuSnapshot {
  idle: number;
  total: number;
}

export async function discoverHardware(pythonPath: string): Promise<HardwareInfo> {
  const [gpus, python, physicalCores] = await Promise.all([
    discoverNvidia(),
    discoverPython(pythonPath),
    discoverPhysicalCores(),
  ]);
  return {
    cpuModel: boundedString(os.cpus()[0]?.model, 256) ?? 'Unknown CPU',
    physicalCores: boundedInteger(physicalCores, 1, 4096),
    logicalThreads: boundedInteger(os.cpus().length, 1, 4096) ?? 1,
    totalRamMb: boundedInteger(Math.round(os.totalmem() / 1024 / 1024), 0, 1_000_000_000) ?? 0,
    availableRamMb: boundedInteger(Math.round(os.freemem() / 1024 / 1024), 0, 1_000_000_000) ?? 0,
    gpus,
    python,
    discoveredAt: Date.now(),
  };
}

async function discoverPhysicalCores(): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
      ], { timeout: 5000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES });
      const value = Number(stdout.trim());
      return value > 0 ? value : undefined;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.physicalcpu'], {
        timeout: 3000, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      });
      const value = Number(stdout.trim());
      return value > 0 ? value : undefined;
    }
    const { stdout } = await execFileAsync('sh', ['-c', "awk '/physical id/{p=$4}/core id/{print p\":\"$4}' /proc/cpuinfo | sort -u | wc -l"], {
      timeout: 3000, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    const value = Number(stdout.trim());
    return value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function sampleResources(previous?: CpuSnapshot): Promise<{ sample: ResourceSample; cpu: CpuSnapshot }> {
  const current = cpuSnapshot();
  const totalDelta = previous ? current.total - previous.total : 0;
  const idleDelta = previous ? current.idle - previous.idle : 0;
  const cpuPercent = totalDelta > 0 ? Math.min(100, (1 - idleDelta / totalDelta) * 100) : 0;
  const gpus = await discoverNvidia(false);
  return {
    cpu: current,
    sample: {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      ramUsedMb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
      ramTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      gpus: gpus.map(({ index, utilizationPercent, memoryUsedMb, vramMb }) => ({
        index,
        utilizationPercent,
        memoryUsedMb,
        vramMb,
      })),
      sampledAt: Date.now(),
    },
  };
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

async function discoverNvidia(includeCudaVersion = true): Promise<GpuInfo[]> {
  if (!includeCudaVersion && nvidiaAvailable === false) return [];
  try {
    const query = [
      'index',
      'name',
      'memory.total',
      'driver_version',
      'utilization.gpu',
      'memory.used',
    ].join(',');
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [`--query-gpu=${query}`, '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
    );
    let cudaVersion = '';
    if (includeCudaVersion) {
      try {
        const result = await execFileAsync('nvidia-smi', [], {
          timeout: 4000, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        });
        cudaVersion = boundedString(/CUDA Version:\s*([\d.]+)/.exec(result.stdout)?.[1], 128) ?? '';
      } catch {
        // The query result is still useful if the banner call fails.
      }
    }
    nvidiaAvailable = true;
    return stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, MAX_GPUS)
      .map((line) => {
        const [index, model, vram, driver, utilization, used] = line.split(',').map((part) => part.trim());
        const parsed = {
          index: boundedInteger(Number(index), 0, 1024),
          vendor: 'NVIDIA',
          model: boundedString(model, 256),
          vramMb: boundedNumber(Number(vram), 0, 100_000_000),
          driver: boundedString(driver, 128) ?? '',
          cudaVersion,
          utilizationPercent: boundedNumber(Number(utilization), 0, 100) ?? 0,
          memoryUsedMb: boundedNumber(Number(used), 0, 100_000_000) ?? 0,
        };
        return parsed.index === undefined || !parsed.model || parsed.vramMb === undefined
          ? undefined
          : parsed as GpuInfo;
      })
      .filter((gpu): gpu is GpuInfo => Boolean(gpu));
  } catch {
    nvidiaAvailable = false;
    return [];
  }
}

async function discoverPython(pythonPath: string): Promise<PythonInfo> {
  const script = [
    'import json,sys',
    'd={"version":sys.version.split()[0],"torchInstalled":False,"torchVersion":"","torchCudaAvailable":False,"torchCudaVersion":"","cudaDeviceNames":[]}',
    'try:',
    ' import torch',
    ' d.update(torchInstalled=True,torchVersion=str(torch.__version__),torchCudaAvailable=bool(torch.cuda.is_available()),torchCudaVersion=str(torch.version.cuda or ""))',
    ' if torch.cuda.is_available(): d["cudaDeviceNames"]=[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]',
    'except Exception: pass',
    'print(json.dumps(d))',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    const value = sanitizePythonInfo(JSON.parse(stdout.trim()), pythonPath);
    if (value) return value;
    throw new Error('Python hardware probe returned an invalid response.');
  } catch {
    return {
      executable: pythonPath,
      version: 'Unavailable',
      torchInstalled: false,
      torchVersion: '',
      torchCudaAvailable: false,
      torchCudaVersion: '',
      cudaDeviceNames: [],
    };
  }
}

function sanitizePythonInfo(value: unknown, executable: string): PythonInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const safeExecutable = boundedString(executable, 4096, false);
  const version = boundedString(raw.version, 128);
  if (!safeExecutable || !version) return undefined;
  return {
    executable: safeExecutable,
    version,
    torchInstalled: raw.torchInstalled === true,
    torchVersion: boundedString(raw.torchVersion, 128) ?? '',
    torchCudaAvailable: raw.torchCudaAvailable === true,
    torchCudaVersion: boundedString(raw.torchCudaVersion, 128) ?? '',
    cudaDeviceNames: Array.isArray(raw.cudaDeviceNames)
      ? raw.cudaDeviceNames.slice(0, MAX_GPUS)
        .map((item) => boundedString(item, 256))
        .filter((item): item is string => Boolean(item))
      : [],
  };
}

function boundedString(value: unknown, maxLength: number, trim = true): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) return undefined;
  const result = trim ? value.trim() : value;
  return result ? result : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) ? boundedNumber(value, minimum, maximum) : undefined;
}
