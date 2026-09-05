import * as Y from 'yjs';

const budgets = new WeakMap<Y.Doc, { cells: Map<string, number>; bytes: number }>();

export function storedValueBytes(value: unknown): number {
  if (value instanceof Y.Text) return Buffer.byteLength(value.toString(), 'utf8');
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 16;
}

export function storedCellBytes(cell: Y.Map<unknown> | Record<string, unknown>): number {
  const entries = cell instanceof Y.Map ? cell.entries() : Object.entries(cell);
  let bytes = 256; // Cell/order identities and Yjs container overhead.
  for (const [field, value] of entries) bytes += Buffer.byteLength(field, 'utf8') + storedValueBytes(value) + 16;
  return bytes;
}

/** Includes retained, unreferenced cells; deleting a cell cannot hide its bytes. */
export function notebookStoredBytes(doc: Y.Doc): number {
  let budget = budgets.get(doc);
  const data = doc.getMap<Y.Map<unknown>>('cellData');
  if (!budget) {
    budget = { cells: new Map(), bytes: 0 };
    const current = budget;
    const refresh = (ids: Iterable<string>) => {
      for (const id of ids) {
        const previous = current.cells.get(id) ?? 0;
        const cell = data.get(id);
        const next = cell ? storedCellBytes(cell) : 0;
        current.bytes += next - previous;
        if (cell) current.cells.set(id, next); else current.cells.delete(id);
      }
    };
    refresh(data.keys());
    data.observeDeep((events) => {
      const ids = new Set<string>();
      for (const event of events) {
        if (event.target === data) for (const id of event.changes.keys.keys()) ids.add(id);
        else if (typeof event.path[0] === 'string') ids.add(event.path[0]);
      }
      refresh(ids);
    });
    budgets.set(doc, budget);
  }
  return budget.bytes + storedValueBytes(doc.getMap('notebook').get('metadata'));
}

export function assertNotebookGrowth(doc: Y.Doc, growth: number, limit: number): void {
  if (notebookStoredBytes(doc) + growth > limit) throw new Error(`Notebook exceeds the ${limit}-byte collaborative-state limit.`);
}
