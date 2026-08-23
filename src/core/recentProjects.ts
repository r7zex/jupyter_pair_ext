import { stat } from 'node:fs/promises';
import { filesystemPathComparisonKey } from './projectPath';

export interface RecentProject {
  name: string;
  workingFolder: string;
  at: number;
}

export function normalizeRecentProjects(value: unknown, limit = 20): RecentProject[] {
  if (!Array.isArray(value) || !Number.isInteger(limit) || limit < 0) return [];
  const result: RecentProject[] = [];
  for (const item of value.slice(0, limit * 4 || 0)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 256
      || typeof raw.workingFolder !== 'string' || !raw.workingFolder.trim() || raw.workingFolder.length > 4096
      || /[\0\r\n]/.test(raw.workingFolder)
      || !Number.isSafeInteger(raw.at) || Number(raw.at) < 0) continue;
    result.push({ name: raw.name.trim(), workingFolder: raw.workingFolder, at: Number(raw.at) });
    if (result.length >= limit) break;
  }
  return result;
}

export function rememberRecentProject(
  recent: readonly RecentProject[],
  project: RecentProject,
  limit = 5,
): RecentProject[] {
  const wanted = canonicalPath(project.workingFolder);
  return [project, ...recent.filter((item) => canonicalPath(item.workingFolder) !== wanted)].slice(0, limit);
}

export async function accessibleRecentProjects(recent: readonly RecentProject[]): Promise<RecentProject[]> {
  const checks = await Promise.all(recent.map(async (item) => {
    try {
      return (await stat(item.workingFolder)).isDirectory() ? item : undefined;
    } catch {
      return undefined;
    }
  }));
  const unique = new Map<string, RecentProject>();
  for (const item of checks) {
    if (!item) continue;
    const key = canonicalPath(item.workingFolder);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function canonicalPath(value: string): string {
  return filesystemPathComparisonKey(value);
}
