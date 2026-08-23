import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export function temporarySibling(target: string): string {
  return `${target}.pair-notebook-${randomUUID()}.tmp`;
}

export async function atomicWriteFile(target: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = temporarySibling(target);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishTemporaryFile(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function publishTemporaryFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
    await syncParentDirectory(target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
  }

  try {
    if ((await lstat(target)).isDirectory()) {
      throw new Error(`Cannot atomically replace a directory with a file: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const backup = `${target}.pair-notebook-${randomUUID()}-backup.tmp`;
  let hasBackup = false;
  try {
    await rename(target, backup);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (hasBackup) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  if (hasBackup) await rm(backup, { force: true });
  await syncParentDirectory(target);
}

/** Flushes a completed temporary copy before it is atomically published. */
export async function syncFileContents(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDirectory(target: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.dirname(target), 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not permit opening/syncing directories.
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EBADF', 'EISDIR', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
