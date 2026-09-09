import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedRegularFile } from './sessionControl';
import { PEER_ID_PATTERN } from './types';

const MAX_OWNER_BYTES = 16 * 1024;

export type ProcessLiveness = 'alive' | 'dead' | 'uncertain';

export interface RuntimeOwnerRecordV1 {
  version: 1;
  pid: number;
  ownerNonce: string;
  launchId: string;
  acquiredAt: number;
}

export interface RuntimeOwnerOptions {
  pid?: number | undefined;
  now?: (() => number) | undefined;
  probeProcess?: ((pid: number) => ProcessLiveness) | undefined;
}

export class RuntimeOwnerLease {
  private released = false;

  public constructor(
    public readonly path: string,
    public readonly record: RuntimeOwnerRecordV1,
  ) {}

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let current: RuntimeOwnerRecordV1;
    try {
      current = await readRuntimeOwner(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (current.ownerNonce !== this.record.ownerNonce
      || current.pid !== this.record.pid
      || current.launchId !== this.record.launchId) {
      throw new Error('Runtime ownership changed; refusing to release another process owner.');
    }
    await rm(this.path, { force: false });
  }
}

export async function acquireRuntimeOwner(
  ownerPath: string,
  launchId: string,
  options: RuntimeOwnerOptions = {},
): Promise<RuntimeOwnerLease> {
  if (!PEER_ID_PATTERN.test(launchId)) throw new Error('Runtime owner launch identity is invalid.');
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Runtime owner process identity is invalid.');
  const probe = options.probeProcess ?? probeProcessLiveness;
  const record: RuntimeOwnerRecordV1 = {
    version: 1,
    pid,
    ownerNonce: randomUUID(),
    launchId,
    acquiredAt: (options.now ?? Date.now)(),
  };
  await mkdir(path.dirname(ownerPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await createOwnerFile(ownerPath, record);
      return new RuntimeOwnerLease(ownerPath, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readRuntimeOwner(ownerPath).catch((error: unknown) => {
      throw new Error('Existing runtime ownership record is invalid; refusing automatic takeover.', { cause: error });
    });
    const liveness = probe(existing.pid);
    if (liveness !== 'dead') {
      throw new Error(liveness === 'alive'
        ? `Session identity is already owned by live process ${existing.pid}.`
        : `Could not prove whether process ${existing.pid} still owns this session identity.`);
    }
    await retireDeadOwner(ownerPath, existing);
  }
  throw new Error('Runtime ownership changed while acquiring the session identity.');
}

export function probeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'uncertain';
  }
}

export async function readRuntimeOwner(ownerPath: string): Promise<RuntimeOwnerRecordV1> {
  const bytes = await readBoundedRegularFile(ownerPath, MAX_OWNER_BYTES);
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<RuntimeOwnerRecordV1>;
  if (parsed.version !== 1
    || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1
    || typeof parsed.ownerNonce !== 'string' || !PEER_ID_PATTERN.test(parsed.ownerNonce)
    || typeof parsed.launchId !== 'string' || !PEER_ID_PATTERN.test(parsed.launchId)
    || !Number.isSafeInteger(parsed.acquiredAt) || Number(parsed.acquiredAt) < 0) {
    throw new Error('Runtime ownership record has an unsupported schema.');
  }
  return {
    version: 1,
    pid: Number(parsed.pid),
    ownerNonce: parsed.ownerNonce,
    launchId: parsed.launchId,
    acquiredAt: Number(parsed.acquiredAt),
  };
}

async function createOwnerFile(ownerPath: string, record: RuntimeOwnerRecordV1): Promise<void> {
  const handle = await open(ownerPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function retireDeadOwner(ownerPath: string, expected: RuntimeOwnerRecordV1): Promise<void> {
  const current = await readRuntimeOwner(ownerPath);
  if (current.pid !== expected.pid
    || current.ownerNonce !== expected.ownerNonce
    || current.launchId !== expected.launchId) {
    throw new Error('Runtime ownership changed while checking the previous owner.');
  }
  const retired = `${ownerPath}.dead-${randomUUID()}`;
  await rename(ownerPath, retired);
  await rm(retired, { force: true });
}
