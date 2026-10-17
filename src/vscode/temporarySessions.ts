import { spawn } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type * as vscode from 'vscode';
import { atomicWriteFile } from '../core/atomicFile';
import type { SessionDescriptor } from '../core/types';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function guestRoot(context: vscode.ExtensionContext, descriptor: SessionDescriptor): string | undefined {
  if (!ID.test(descriptor.sessionId) || !ID.test(descriptor.localPeer.peerId)) return undefined;
  const root = path.join(context.globalStorageUri.fsPath, 'sessions', descriptor.sessionId, descriptor.localPeer.peerId);
  if (!samePath(descriptor.workingFolder, path.join(root, 'workspace'))) return undefined;
  if (descriptor.backingFolder && samePath(descriptor.backingFolder, descriptor.workingFolder)) return undefined;
  return root;
}

export function isTemporaryGuestWorkspace(context: vscode.ExtensionContext, descriptor: SessionDescriptor): boolean {
  return guestRoot(context, descriptor) !== undefined;
}

export async function claimGuestWorkspace(context: vscode.ExtensionContext, descriptor: SessionDescriptor): Promise<void> {
  const root = guestRoot(context, descriptor);
  if (root) await atomicWriteFile(path.join(root, '.pair-guest-lease.json'), JSON.stringify({ version: 1, pid: process.pid }));
}

export async function retireGuestWorkspace(context: vscode.ExtensionContext, descriptor: SessionDescriptor): Promise<void> {
  const root = guestRoot(context, descriptor);
  if (!root) return;
  await atomicWriteFile(path.join(root, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, sessionId: descriptor.sessionId, peerId: descriptor.localPeer.peerId }));
  spawnGuestCleanup(context, root);
}

function spawnGuestCleanup(context: vscode.ExtensionContext, root: string): void {
  const child = spawn(process.execPath, [path.join(context.extensionPath, 'media', 'cleanup-session.cjs'), context.globalStorageUri.fsPath, root], { cwd: os.tmpdir(), detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.on('error', () => undefined); // The next activation retries its persisted cleanup request.
  child.unref();
}

export async function sweepGuestWorkspaces(context: vscode.ExtensionContext, activeFolders: readonly string[]): Promise<string[]> {
  const retired: string[] = [];
  const base = path.join(context.globalStorageUri.fsPath, 'sessions');
  const sessions = await readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink() || !ID.test(session.name)) continue;
    for (const peer of await readdir(path.join(base, session.name), { withFileTypes: true })) {
      if (peer.isDirectory() && !peer.isSymbolicLink() && peer.name.endsWith('.deleting') && ID.test(peer.name.slice(0, -9))) {
        spawnGuestCleanup(context, path.join(base, session.name, peer.name.slice(0, -9)));
        retired.push(path.join(base, session.name, peer.name.slice(0, -9), 'workspace'));
        continue;
      }
      if (!peer.isDirectory() || peer.isSymbolicLink() || !ID.test(peer.name)) continue;
      const root = path.join(base, session.name, peer.name), folder = path.join(root, 'workspace');
      if (activeFolders.some(active => samePath(active, folder))) continue;
      try {
        const request = JSON.parse(await readFile(path.join(root, '.pair-guest-cleanup.json'), 'utf8')) as { version?: number; sessionId?: string; peerId?: string };
        if (request.version === 1 && request.sessionId === session.name && request.peerId === peer.name) {
          spawnGuestCleanup(context, root);
          retired.push(folder);
          continue;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try {
        const lease = JSON.parse(await readFile(path.join(root, '.pair-guest-lease.json'), 'utf8')) as { pid?: number };
        if (Number.isSafeInteger(lease.pid) && lease.pid! > 0) {
          try { process.kill(lease.pid!, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (process.platform !== 'win32') continue;
      }
      try {
        const marker = path.join(folder, '.pair-notebook-session.json');
        if (!(await lstat(marker)).isFile()) continue;
        const descriptor = JSON.parse(await readFile(marker, 'utf8')) as SessionDescriptor;
        if (descriptor.sessionId === session.name && descriptor.localPeer?.peerId === peer.name) {
          await retireGuestWorkspace(context, { ...descriptor, workingFolder: folder });
          retired.push(folder);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return retired;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
