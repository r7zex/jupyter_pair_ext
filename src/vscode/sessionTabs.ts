import path from 'node:path';

export interface PairTabUri {
  scheme: string;
  fsPath: string;
}

export interface PairTabLike {
  input: unknown;
}

export interface PairTabGroupsLike {
  all: readonly { tabs: readonly PairTabLike[] }[];
  close(tab: any, preserveFocus?: boolean): PromiseLike<boolean> | Promise<boolean> | boolean;
}

export interface PairTabCloseResult {
  matched: number;
  closed: number;
  failed: number;
  errors: string[];
}

/**
 * Closes only tabs whose file-backed URI is strictly contained by the isolated
 * Pair working root. It never closes a VS Code window and one tab failure never
 * aborts cleanup of the remaining Pair tabs.
 */
export async function closeIsolatedPairTabs(
  tabGroups: PairTabGroupsLike | undefined,
  workingFolder: string,
): Promise<PairTabCloseResult> {
  if (!tabGroups) return { matched: 0, closed: 0, failed: 0, errors: [] };
  const root = path.resolve(workingFolder);
  const tabs = tabGroups.all.flatMap((group) => [...group.tabs]).filter((tab) =>
    tabInputUris(tab.input).some((uri) => isWithinIsolatedPairRoot(root, uri)));
  let closed = 0;
  const errors: string[] = [];
  for (const tab of tabs) {
    try {
      const result = await tabGroups.close(tab, true);
      if (result === false) {
        errors.push('VS Code declined to close one isolated Pair tab.');
      } else {
        closed += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { matched: tabs.length, closed, failed: tabs.length - closed, errors };
}

export function tabInputUris(input: unknown): PairTabUri[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return [record.uri, record.original, record.modified]
    .filter((value): value is PairTabUri => Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as PairTabUri).scheme === 'string'
      && typeof (value as PairTabUri).fsPath === 'string');
}

export function isWithinIsolatedPairRoot(root: string, uri: PairTabUri): boolean {
  if (uri.scheme !== 'file') return false;
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(uri.fsPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
