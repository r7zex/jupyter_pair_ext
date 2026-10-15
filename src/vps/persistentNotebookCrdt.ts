import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';

export interface SharedCell { id: string; cell_type: string; source: string; metadata: Record<string, unknown> }
export interface SharedNotebook { cells: SharedCell[]; metadata: Record<string, unknown> }
export interface NotebookSyncReply { epoch: string; update: string; revision: number; textProtocol?: 'yjs-intents-v1'; identity?: string; acknowledgedSequence?: number; cells: SharedCell[]; metadata: Record<string, unknown> }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const MAX_REPLICA_BYTES = 64 * 1024 * 1024;
export function sharedNotebook(doc: Y.Doc): SharedNotebook {
  const order = doc.getArray<string>('order').toArray(); const cells = doc.getMap<Y.Map<unknown>>('cells');
  if (order.length > 10000 || cells.size > 20000 || order.some((id) => !validId(id))) throw new Error('Invalid CRDT cell order.');
  const result: SharedCell[] = [];
  for (const id of new Set(order)) {
    const cell = cells.get(id); const text = cell?.get('source'); const kind = cell?.get('cell_type'); const metadata = cell?.get('metadata');
    if (!(cell instanceof Y.Map) || !(text instanceof Y.Text) || !['code', 'markdown', 'raw'].includes(String(kind)) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid CRDT cell.');
    result.push({ id, cell_type: kind as string, source: text.toString(), metadata: metadata as Record<string, unknown> });
  }
  const metadata = doc.getMap<unknown>('notebook').get('metadata') ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid CRDT metadata.');
  return { cells: result, metadata: metadata as Record<string, unknown> };
}
export function editSharedNotebook(doc: Y.Doc, notebook: SharedNotebook): void {
  doc.transact(() => {
    const order = doc.getArray<string>('order'); const cells = doc.getMap<Y.Map<unknown>>('cells');
    const next = notebook.cells.map((cell) => cell.id);
    if (new Set(next).size !== next.length || next.some((id) => !validId(id))) throw new Error('Cell IDs must be unique.');
    // Preserve common order ranges so concurrent edits to other cells commute.
    const old = order.toArray(); let prefix = 0; let suffix = 0;
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++;
    while (suffix < Math.min(old.length, next.length) - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    if (old.length - prefix - suffix) order.delete(prefix, old.length - prefix - suffix);
    if (next.length - prefix - suffix) order.insert(prefix, next.slice(prefix, next.length - suffix));
    for (const input of notebook.cells) {
      let cell = cells.get(input.id);
      if (!cell) { cell = new Y.Map(); cells.set(input.id, cell); cell.set('source', new Y.Text()); }
      if (cell.get('cell_type') !== input.cell_type) cell.set('cell_type', input.cell_type);
      if (JSON.stringify(cell.get('metadata')) !== JSON.stringify(input.metadata)) cell.set('metadata', input.metadata);
      const text = cell.get('source') as Y.Text; const previous = text.toString();
      let start = 0; let end = 0;
      while (start < Math.min(previous.length, input.source.length) && previous[start] === input.source[start]) start++;
      while (end < Math.min(previous.length, input.source.length) - start && previous[previous.length - 1 - end] === input.source[input.source.length - 1 - end]) end++;
      if (previous.length - start - end) text.delete(start, previous.length - start - end);
      if (input.source.length - start - end) text.insert(start, input.source.slice(start, input.source.length - end));
    }
    const metadata = { ...notebook.metadata }; delete metadata.pair_crdt;
    if (JSON.stringify(doc.getMap('notebook').get('metadata')) !== JSON.stringify(metadata)) doc.getMap('notebook').set('metadata', metadata);
  });
}
export function loadNotebookCrdt(content: string): { doc: Y.Doc; epoch: string; template: Record<string, any> } {
  const template = JSON.parse(Buffer.from(content, 'base64').toString('utf8')) as Record<string, any>;
  if (!Array.isArray(template.cells) || template.cells.length > 10000) throw new Error('Invalid notebook.');
  const doc = new Y.Doc(); const state = template.metadata?.pair_crdt;
  const epoch = typeof state?.epoch === 'string' && validId(state.epoch) ? state.epoch : randomUUID();
  if (state) {
    if (typeof state.update !== 'string' || Buffer.byteLength(state.update) > MAX_REPLICA_BYTES) throw new Error('Invalid stored CRDT.');
    Y.applyUpdate(doc, Buffer.from(state.update, 'base64')); sharedNotebook(doc);
  } else {
    // Older notebooks have no cell IDs. Assign them in the template too, so
    // attachment/vendor fields can still be matched during the first save.
    template.cells = template.cells.map((cell: any) => ({ ...cell, id: validId(cell.id) ? cell.id : randomUUID() }));
    editSharedNotebook(doc, { metadata: template.metadata ?? {}, cells: template.cells.map((cell: any) => ({ id: cell.id, cell_type: cell.cell_type, source: Array.isArray(cell.source) ? cell.source.join('') : cell.source, metadata: cell.metadata ?? {} })) });
  }
  return { doc, epoch, template };
}
export function saveNotebookCrdt(doc: Y.Doc, epoch: string, template: Record<string, any>): string {
  const state = sharedNotebook(doc); const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  if (Buffer.byteLength(update) > MAX_REPLICA_BYTES) throw new Error('Notebook replica exceeds its bounded storage budget.');
  const old = new Map<string, any>(template.cells.map((cell: any) => [cell.id, cell]));
  return Buffer.from(JSON.stringify({ ...template, nbformat: 4, nbformat_minor: 5, metadata: { ...state.metadata, pair_crdt: { epoch, update, ...(template.metadata?.pair_crdt?.intents ? { intents: template.metadata.pair_crdt.intents } : {}) } }, cells: state.cells.map((cell) => {
    const before = old.get(cell.id);
    const result = { ...before, ...cell, ...(cell.cell_type === 'code' ? { outputs: before?.cell_type === 'code' ? before.outputs ?? [] : [], execution_count: before?.cell_type === 'code' ? before.execution_count ?? null : null } : {}) };
    if (cell.cell_type !== 'code') { delete result.outputs; delete result.execution_count; }
    if (cell.cell_type !== 'markdown') delete result.attachments;
    return result;
  }) })).toString('base64');
}
