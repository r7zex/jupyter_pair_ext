import { portablePathComparisonKey, safeRelativePath } from '../core/projectPath';

export interface SessionResources {
  storageMb: number;
  activeExecutions: number;
}

export const DEFAULT_SESSION_RESOURCES: Readonly<SessionResources> = { storageMb: 128, activeExecutions: 32 };

export function sessionResources(value: unknown): SessionResources {
  if (value === undefined) return { ...DEFAULT_SESSION_RESOURCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session resource limits.');
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.storageMb) || Number(raw.storageMb) < 1 || Number(raw.storageMb) > 65536
    || !Number.isSafeInteger(raw.activeExecutions) || Number(raw.activeExecutions) < 1 || Number(raw.activeExecutions) > 32) {
    throw new Error('Storage must be 1–65536 MiB and active executions must be 1–32.');
  }
  return { storageMb: Number(raw.storageMb), activeExecutions: Number(raw.activeExecutions) };
}

export function sessionProjectRoot(value: unknown): string {
  if (typeof value !== 'string' || !safeRelativePath(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..') || value.length > 240) {
    throw new Error('Choose a relative project folder without traversal or symbolic links.');
  }
  return value;
}

export function projectRootsOverlap(left: string, right: string): boolean {
  const a = portablePathComparisonKey(left);
  const b = portablePathComparisonKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function participantNameKey(name: string): string { return name.normalize('NFKC').trim().toLowerCase(); }
