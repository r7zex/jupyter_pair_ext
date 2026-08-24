import { CellSnapshot } from './crdt';
import { newId } from './types';

/**
 * Keeps a notebook cell ID attached to the cell object while VS Code is
 * applying edits.  Numerical indexes are intentionally not used here: an
 * insertion changes indexes but does not change the identity of existing
 * NotebookCell objects.
 */
export class StableCellIdRegistry<T extends object> {
  private readonly ids = new WeakMap<T, string>();

  public constructor(private readonly createId: () => string = newId) {}

  public seed(cell: T, explicitId: string | undefined, initialId: string | undefined): string {
    const id = validCellId(explicitId) ?? this.ids.get(cell) ?? validCellId(initialId) ?? this.createId();
    this.ids.set(cell, id);
    return id;
  }

  public idFor(cell: T, explicitId?: string): string {
    const id = validCellId(explicitId) ?? this.ids.get(cell) ?? this.createId();
    this.ids.set(cell, id);
    return id;
  }

  public knownId(cell: T, explicitId?: string): string | undefined {
    const id = validCellId(explicitId) ?? this.ids.get(cell);
    if (id) this.ids.set(cell, id);
    return id;
  }

  /** Replaces a duplicated/corrupted editor identity with a fresh valid id. */
  public renew(cell: T): string {
    const id = this.createId();
    if (!validCellId(id)) throw new Error('Notebook cell id generator returned an invalid id.');
    this.ids.set(cell, id);
    return id;
  }
}

export interface UnidentifiedNotebookCell {
  kind: number;
  language: string;
  source: string;
}

/** Matches only unambiguous initial cells by their own content/shape, never by index. */
export function matchInitialCellIds(
  current: readonly UnidentifiedNotebookCell[],
  target: readonly CellSnapshot[],
): Array<string | undefined> {
  const currentBuckets = new Map<string, number[]>();
  const targetBuckets = new Map<string, CellSnapshot[]>();
  current.forEach((cell, index) => {
    const key = initialFingerprint(cell);
    const bucket = currentBuckets.get(key) ?? [];
    bucket.push(index);
    currentBuckets.set(key, bucket);
  });
  for (const cell of target) {
    const key = initialFingerprint(cell);
    const bucket = targetBuckets.get(key) ?? [];
    bucket.push(cell);
    targetBuckets.set(key, bucket);
  }
  const result: Array<string | undefined> = new Array(current.length).fill(undefined);
  for (const [fingerprint, indexes] of currentBuckets) {
    const targets = targetBuckets.get(fingerprint);
    if (indexes.length !== 1 || targets?.length !== 1) continue;
    const sourceIndex = indexes[0];
    const matched = targets[0];
    if (sourceIndex === undefined || !matched) continue;
    result[sourceIndex] = matched.id;
  }
  return result;
}

function initialFingerprint(cell: UnidentifiedNotebookCell): string {
  return JSON.stringify([cell.kind, cell.language, cell.source]);
}

export interface NotebookStructureCell {
  id: string;
  kind: number;
  language: string;
}

export interface NotebookSplice {
  start: number;
  deleteCount: number;
  cells: CellSnapshot[];
}

/** Returns the smallest single replaceCells splice that preserves equal ends. */
export function minimalNotebookSplice(
  current: readonly NotebookStructureCell[],
  target: readonly CellSnapshot[],
): NotebookSplice | undefined {
  let start = 0;
  while (start < current.length && start < target.length) {
    const currentCell = current[start];
    const targetCell = target[start];
    if (!currentCell || !targetCell || !sameStructure(currentCell, targetCell)) break;
    start += 1;
  }
  if (start === current.length && start === target.length) return undefined;

  let currentEnd = current.length;
  let targetEnd = target.length;
  while (currentEnd > start && targetEnd > start) {
    const currentCell = current[currentEnd - 1];
    const targetCell = target[targetEnd - 1];
    if (!currentCell || !targetCell || !sameStructure(currentCell, targetCell)) break;
    currentEnd -= 1;
    targetEnd -= 1;
  }
  return {
    start,
    deleteCount: currentEnd - start,
    cells: target.slice(start, targetEnd),
  };
}

export function metadataCellId(metadata: Record<string, unknown>): string | undefined {
  return validCellId(metadata.pairNotebookCellId);
}

function sameStructure(a: NotebookStructureCell, b: NotebookStructureCell): boolean {
  return a.id === b.id && a.kind === b.kind && a.language === b.language;
}

function validCellId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
