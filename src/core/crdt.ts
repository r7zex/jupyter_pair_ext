import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { relativePathsNested } from './projectPath';
import { LOCAL_EDITOR_ORIGIN, REMOTE_ORIGIN, newId } from './types';

export type DocumentKind = 'text' | 'notebook';

export interface TextChange {
  offset: number;
  deleteCount: number;
  insertText: string;
}

export interface CellTextState {
  source: string;
  revision: string;
}

export interface OutputItemSnapshot {
  mime: string;
  dataBase64: string;
}

export interface OutputSnapshot {
  items: OutputItemSnapshot[];
  metadata?: Record<string, unknown> | undefined;
}

export interface CellExecutionSnapshot {
  executionOrder?: number | undefined;
  success?: boolean | undefined;
  timing?: { startTime: number; endTime: number } | undefined;
}

export interface CellSnapshot {
  id: string;
  kind: number;
  language: string;
  source: string;
  metadata: Record<string, unknown>;
  outputs: OutputSnapshot[];
  execution?: CellExecutionSnapshot | undefined;
}

export interface NotebookSnapshot {
  metadata: Record<string, unknown>;
  cells: CellSnapshot[];
}

export const MAX_NOTEBOOK_CELLS = 10_000;
export const MAX_CELL_OUTPUTS = 1_024;
export const MAX_OUTPUT_ITEMS_PER_CELL = 4_096;
export const MAX_CELL_OUTPUT_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_NOTEBOOK_METADATA_JSON_BYTES = 1024 * 1024;
export const MAX_NOTEBOOK_STATE_BYTES = 48 * 1024 * 1024;
export const MAX_CELL_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_CHANGES_PER_EVENT = 100_000;
const MAX_CELL_ID_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 128;

interface ProjectDocument {
  key: string;
  kind: DocumentKind;
  doc: Y.Doc;
}

export type NotebookUpdateScope =
  | { type: 'structure' }
  | { type: 'cellText'; cellId: string }
  | { type: 'cellOutputs'; cellId: string }
  | { type: 'cellMetadata'; cellId: string }
  | { type: 'cellExecution'; cellId: string }
  | { type: 'notebookMetadata' };

export interface ProjectUpdate {
  key: string;
  kind: DocumentKind;
  update: Uint8Array;
  origin: unknown;
  /**
   * Notebook mutations carry a semantic scope. It is optional only for
   * state-vector/bootstrap reconciliation where one Yjs update can contain
   * several historical scopes.
   */
  scope?: NotebookUpdateScope | undefined;
}

export function normalizeNotebookUpdateScope(value: unknown): NotebookUpdateScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { type?: unknown; cellId?: unknown };
  switch (raw.type) {
    case 'structure':
      return { type: 'structure' };
    case 'notebookMetadata':
      return { type: 'notebookMetadata' };
    case 'cellText':
    case 'cellOutputs':
    case 'cellMetadata':
    case 'cellExecution':
      return isValidCellId(raw.cellId) ? { type: raw.type, cellId: raw.cellId } : undefined;
    default:
      return undefined;
  }
}

/**
 * Answers whether permanently dropping unreferenced cell state is safe *right
 * now*.  Deleting a cell payload is irreversible for a peer that is currently
 * absent: when it returns and re-references the cell, the Y.Text living inside
 * the removed Y.Map value is already gone.  The runtime therefore only allows
 * collection while every known session participant is present and synchronized.
 */
export type GarbageCollectionGuard = (now: number) => boolean;

export class CollaborativeProject extends EventEmitter {
  private readonly documents = new Map<string, ProjectDocument>();
  private readonly normalizing = new Set<Y.Doc>();
  private readonly unreferencedSince = new Map<string, Map<string, number>>();
  /** Ids whose payload this peer already collected, per document key. */
  private readonly collectedIds = new Map<string, Set<string>>();
  private applyingRemoteScope: ProjectUpdate['scope'];
  /**
   * Optional runtime veto for garbage collection.  Unset (library/test usage)
   * means "collection is allowed", which keeps `collectGarbage` a pure function
   * of the arguments it is given.
   */
  public collectionGuard: GarbageCollectionGuard | undefined;


  public keys(): string[] {
    return [...this.documents.keys()];
  }

  public has(key: string): boolean {
    return this.documents.has(key);
  }

  public kindOf(key: string): DocumentKind | undefined {
    return this.documents.get(key)?.kind;
  }

  public renameDocument(from: string, to: string): void {
    if (from === to) return;
    if (relativePathsNested(from, to)) {
      throw new Error('A collaborative document cannot be renamed into or over its own ancestor.');
    }
    const affected = [...this.documents.entries()].filter(([key]) => key === from || key.startsWith(`${from}/`));
    for (const [oldKey, entry] of affected) {
      const newKey = oldKey === from ? to : `${to}${oldKey.slice(from.length)}`;
      const replaced = this.documents.get(newKey);
      if (replaced && replaced !== entry) {
        this.documents.delete(newKey);
        this.unreferencedSince.delete(newKey);
        this.collectedIds.delete(newKey);
        this.emit('documentDeleted', newKey, replaced.kind, replaced.doc);
        replaced.doc.destroy();
      }
      this.documents.delete(oldKey);
      entry.key = newKey;
      this.documents.set(newKey, entry);
      const unreferenced = this.unreferencedSince.get(oldKey);
      if (unreferenced) {
        this.unreferencedSince.delete(oldKey);
        this.unreferencedSince.set(newKey, unreferenced);
      }
      const collected = this.collectedIds.get(oldKey);
      if (collected) {
        this.collectedIds.delete(oldKey);
        this.collectedIds.set(newKey, collected);
      }
      this.emit('documentRenamed', oldKey, newKey, entry.kind);
    }
  }

  public deleteDocument(key: string): void {
    for (const [current, entry] of [...this.documents]) {
      if (current !== key && !current.startsWith(`${key}/`)) continue;
      this.documents.delete(current);
      this.unreferencedSince.delete(current);
      this.collectedIds.delete(current);
      this.emit('documentDeleted', current, entry.kind, entry.doc);
      entry.doc.destroy();
    }
  }

  public ensureText(key: string, initial = '', origin: unknown = LOCAL_EDITOR_ORIGIN): Y.Text {
    const existing = this.documents.get(key);
    if (existing) {
      if (existing.kind !== 'text') throw new Error(`${key} is already registered as a notebook`);
      return existing.doc.getText('content');
    }
    if (typeof initial !== 'string' || Buffer.byteLength(initial, 'utf8') > MAX_TEXT_DOCUMENT_BYTES) {
      throw new Error(`${key} exceeds the collaborative text-size limit.`);
    }
    const entry = this.createDocument(key, 'text');
    const text = entry.doc.getText('content');
    if (initial) entry.doc.transact(() => text.insert(0, initial), origin);
    return text;
  }

  public ensureNotebook(
    key: string,
    initial?: NotebookSnapshot,
    origin: unknown = LOCAL_EDITOR_ORIGIN,
  ): Y.Doc {
    const existing = this.documents.get(key);
    if (existing) {
      if (existing.kind !== 'notebook') throw new Error(`${key} is already registered as text`);
      return existing.doc;
    }
    const entry = this.createDocument(key, 'notebook');
    if (initial) this.reconcileNotebook(key, initial, origin);
    return entry.doc;
  }

  private createDocument(key: string, kind: DocumentKind): ProjectDocument {
    const doc = new Y.Doc();
    const entry = { key, kind, doc };
    this.documents.set(key, entry);
    if (kind === 'notebook') {
      // Concurrent notebook moves are expressed as delete+insert on the shared
      // order array.  Two concurrent moves of the same logical cell therefore
      // converge to a state where the cell id is present more than once.  The
      // duplicate removal below is a deterministic function of the *converged*
      // Yjs state (keep the first occurrence, delete every later one), so every
      // peer independently produces the same deletions and the deletions
      // themselves commute.  The Yjs state stays consistent - duplicates are
      // not merely hidden from the UI snapshot.
      const order = doc.getArray<string>('cells');
      order.observe(() => this.normalizeOrder(entry));
    }
    doc.on('update', (update: Uint8Array, origin: unknown) => {

      const scoped = scopedOrigin(origin);
      this.emit('update', {
        key: entry.key,
        kind,
        update,
        origin: scoped.origin,
        scope: origin === REMOTE_ORIGIN ? this.applyingRemoteScope : scoped.scope,
      } satisfies ProjectUpdate);
    });
    this.emit('documentAdded', key, kind);
    return entry;
  }

  public applyTextChanges(key: string, changes: readonly TextChange[], origin = LOCAL_EDITOR_ORIGIN): void {
    const text = this.ensureText(key);
    const ordered = validatedTextChanges(changes, text.toString(), MAX_TEXT_DOCUMENT_BYTES, key);
    text.doc?.transact(() => {
      for (const change of ordered) {
        if (change.offset < 0 || change.offset + change.deleteCount > text.length) {
          throw new Error(`Text change is outside ${key}`);
        }
        if (change.deleteCount) text.delete(change.offset, change.deleteCount);
        if (change.insertText) text.insert(change.offset, change.insertText);
      }
    }, withScope(origin, { type: 'structure' }));
  }

  public replaceText(key: string, value: string, origin = LOCAL_EDITOR_ORIGIN): void {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TEXT_DOCUMENT_BYTES) {
      throw new Error(`${key} exceeds the collaborative text-size limit.`);
    }
    const text = this.ensureText(key);
    if (text.toString() === value) return;
    text.doc?.transact(() => {
      if (text.length) text.delete(0, text.length);
      if (value) text.insert(0, value);
    }, withScope(origin, { type: 'structure' }));
  }

  public text(key: string): Y.Text {
    return this.ensureText(key);
  }

  public reconcileNotebook(
    key: string,
    snapshot: NotebookSnapshot,
    origin: unknown = LOCAL_EDITOR_ORIGIN,
  ): void {
    const normalizedSnapshot = normalizeNotebookSnapshot(snapshot);
    const doc = this.ensureNotebook(key);
    const order = doc.getArray<string>('cells');
    const data = doc.getMap<Y.Map<unknown>>('cellData');
    const notebook = doc.getMap<string>('notebook');
    doc.transact(() => {
      notebook.set('metadata', JSON.stringify(normalizedSnapshot.metadata));
      const desiredIds: string[] = [];
      for (const rawCell of normalizedSnapshot.cells) {
        const cell = { ...rawCell, id: rawCell.id || newId() };
        desiredIds.push(cell.id);
        let map = data.get(cell.id);
        if (!map) {
          map = new Y.Map<unknown>();
          const source = new Y.Text();
          if (cell.source) source.insert(0, cell.source);
          map.set('source', source);
          map.set('textRevision', nextCellTextRevision());
          data.set(cell.id, map);
        }
        map.set('id', cell.id);
        map.set('kind', cell.kind);
        map.set('language', cell.language);
        map.set('metadata', JSON.stringify(cell.metadata ?? {}));
        map.set('outputs', JSON.stringify(cell.outputs ?? []));
        map.set('execution', JSON.stringify(cell.execution ?? null));
        const source = map.get('source') as Y.Text;
        if (source.toString() !== cell.source) {
          if (source.length) source.delete(0, source.length);
          if (cell.source) source.insert(0, cell.source);
          map.set('textRevision', nextCellTextRevision(map.get('textRevision')));
        }
      }

      for (let index = order.length - 1; index >= 0; index -= 1) {
        if (!desiredIds.includes(order.get(index))) order.delete(index, 1);
      }
      for (let index = 0; index < desiredIds.length; index += 1) {
        const id = desiredIds[index];
        if (id === undefined) continue;
        if (order.get(index) === id) continue;
        const current = order.toArray().indexOf(id, index + 1);
        if (current >= 0) order.delete(current, 1);
        order.insert(index, [id]);
      }
      while (order.length > desiredIds.length) order.delete(order.length - 1, 1);
    }, withScope(origin, { type: 'structure' }));
  }

  public applyCellTextChanges(
    key: string,
    cellId: string,
    changes: readonly TextChange[],
    origin = LOCAL_EDITOR_ORIGIN,
  ): void {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    const source = map?.get('source');
    if (!map || !(source instanceof Y.Text)) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    const ordered = validatedTextChanges(changes, source.toString(), MAX_CELL_SOURCE_BYTES, `${key} cell ${cellId}`);
    const changesText = ordered.some((change) => change.deleteCount > 0 || change.insertText.length > 0);
    if (!changesText) return;
    doc.transact(() => {
      for (const change of ordered) {
        if (change.deleteCount) source.delete(change.offset, change.deleteCount);
        if (change.insertText) source.insert(change.offset, change.insertText);
      }
      // Canonical text revision is updated only with cell-text mutations.
      // Output, execution and metadata transactions never touch it.
      map.set('textRevision', nextCellTextRevision(map.get('textRevision')));
    }, withScope(origin, { type: 'cellText', cellId }));
  }

  public cellSource(key: string, cellId: string): Y.Text {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    const source = map?.get('source');
    if (!(source instanceof Y.Text)) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    return source;
  }

  public cellTextState(key: string, cellId: string): CellTextState {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    const source = map?.get('source');
    if (!map || !(source instanceof Y.Text)) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    const value = source.toString();
    const stored = map.get('textRevision');
    const revision = cellTextRevisionSequence(stored) !== undefined
      ? String(stored)
      : `legacy-${createHash('sha256').update(cellId, 'utf8').update('\0').update(value, 'utf8').digest('hex').slice(0, 32)}`;
    return { source: value, revision };
  }

  public setCellOutputs(
    key: string,
    cellId: string,
    outputs: OutputSnapshot[],
    origin = LOCAL_EDITOR_ORIGIN,
  ): void {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    if (!map) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    const normalized = normalizeOutputSnapshots(outputs);
    doc.transact(() => map.set('outputs', JSON.stringify(normalized)), withScope(origin, { type: 'cellOutputs', cellId }));
  }

  public setCellMetadata(
    key: string,
    cellId: string,
    metadata: Record<string, unknown>,
    origin = LOCAL_EDITOR_ORIGIN,
  ): void {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    if (!map) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    const normalized = normalizeMetadata(metadata, 'Cell metadata');
    const serialized = JSON.stringify(normalized);
    if (map.get('metadata') === serialized) return;
    doc.transact(() => map.set('metadata', serialized), withScope(origin, { type: 'cellMetadata', cellId }));
  }

  public setCellExecution(
    key: string,
    cellId: string,
    execution: CellExecutionSnapshot | undefined,
    origin = LOCAL_EDITOR_ORIGIN,
  ): void {
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    if (!map) throw new Error(`Unknown notebook cell ${cellId} in ${key}`);
    const normalized = normalizeExecutionSnapshot(execution);
    doc.transact(
      () => map.set('execution', JSON.stringify(normalized ?? null)),
      withScope(origin, { type: 'cellExecution', cellId }),
    );
  }

  public setNotebookMetadata(
    key: string,
    metadata: Record<string, unknown>,
    origin = LOCAL_EDITOR_ORIGIN,
  ): void {
    const normalized = normalizeMetadata(metadata, 'Notebook metadata');
    const doc = this.ensureNotebook(key);
    const serialized = JSON.stringify(normalized);
    const notebook = doc.getMap<string>('notebook');
    if (notebook.get('metadata') === serialized) return;
    doc.transact(() => notebook.set('metadata', serialized), withScope(origin, { type: 'notebookMetadata' }));
  }

  /** Returns only one live logical cell; no whole-notebook snapshot is built. */
  public notebookCellSnapshot(key: string, cellId: string): CellSnapshot | undefined {
    if (!this.hasNotebookCell(key, cellId)) return undefined;
    const doc = this.ensureNotebook(key);
    const map = doc.getMap<Y.Map<unknown>>('cellData').get(cellId);
    const source = map?.get('source');
    if (!map || !(source instanceof Y.Text)) return undefined;
    return {
      id: cellId,
      kind: map.get('kind') === 1 ? 1 : 2,
      language: boundedLanguage(map.get('language')),
      source: boundedSource(source.toString()),
      metadata: parseObject(map.get('metadata'), MAX_NOTEBOOK_METADATA_JSON_BYTES),
      outputs: parseOutputs(map.get('outputs')),
      execution: parseExecution(map.get('execution')),
    };
  }

  /** Returns canonical notebook metadata without serializing cell payloads. */
  public notebookMetadata(key: string): Record<string, unknown> {
    const doc = this.ensureNotebook(key);
    return parseObject(doc.getMap<string>('notebook').get('metadata'), MAX_NOTEBOOK_METADATA_JSON_BYTES);
  }

  /**
   * Answers whether the shared order references a live cell payload without
   * serializing the notebook.  Callers such as cursor presence and per-keystroke
   * editor synchronization run on hot paths, where a full `notebookSnapshot`
   * would JSON-parse every cell's metadata and outputs just to test membership.
   */
  public hasNotebookCell(key: string, cellId: string): boolean {
    const entry = this.documents.get(key);
    if (!entry || entry.kind !== 'notebook') return false;
    if (!entry.doc.getMap<unknown>('cellData').has(cellId)) return false;
    return entry.doc.getArray<unknown>('cells').toArray().includes(cellId);
  }

  public notebookSnapshot(key: string): NotebookSnapshot {
    const doc = this.ensureNotebook(key);
    const entry = this.documents.get(key);
    if (entry) this.normalizeOrder(entry);
    const data = doc.getMap<Y.Map<unknown>>('cellData');
    const seen = new Set<string>();
    const cells: CellSnapshot[] = [];
    for (const id of doc.getArray<unknown>('cells').toArray()) {
      // Defensive: never serialize a duplicate logical cell and never fail the
      // whole notebook (which would block persistence) because one entry is
      // missing after a concurrent delete.
      if (!isValidCellId(id) || seen.has(id) || cells.length >= MAX_NOTEBOOK_CELLS) continue;
      const map = data.get(id);
      const source = map?.get('source');
      if (!map || !(source instanceof Y.Text)) continue;
      seen.add(id);
      cells.push({
        id,
        kind: map.get('kind') === 1 ? 1 : 2,
        language: boundedLanguage(map.get('language')),
        source: boundedSource(source.toString()),
        metadata: parseObject(map.get('metadata'), MAX_NOTEBOOK_METADATA_JSON_BYTES),
        outputs: parseOutputs(map.get('outputs')),
        execution: parseExecution(map.get('execution')),
      });
    }
    return {
      metadata: parseObject(doc.getMap<string>('notebook').get('metadata'), MAX_NOTEBOOK_METADATA_JSON_BYTES),
      cells,
    };
  }

  /**
   * Deletes every duplicate occurrence of a logical cell id from the shared
   * order array, keeping the first occurrence.  Runs as a deterministic
   * function of converged state, so all peers produce identical results.
   */
  private normalizeOrder(entry: ProjectDocument): void {
    if (entry.kind !== 'notebook' || this.normalizing.has(entry.doc)) return;
    const order = entry.doc.getArray<unknown>('cells');
    const seen = new Set<string>();
    const duplicates: number[] = [];
    order.toArray().forEach((id, index) => {
      if (!isValidCellId(id) || seen.has(id) || seen.size >= MAX_NOTEBOOK_CELLS) duplicates.push(index);
      else seen.add(id);
    });
    if (!duplicates.length) return;
    this.normalizing.add(entry.doc);
    try {
      entry.doc.transact(() => {
        for (const index of duplicates.reverse()) order.delete(index, 1);
      }, withScope(LOCAL_EDITOR_ORIGIN, { type: 'structure' }));
    } finally {
      this.normalizing.delete(entry.doc);
    }
  }

  /**
   * Removes cell state that has not been referenced by the visible order for at
   * least `graceMs`.  The delay keeps a concurrently delivered move that still
   * references the cell safe; deletion itself is an ordinary convergent Yjs
   * operation.
   */
  public collectGarbage(key: string, graceMs = 30_000, now = Date.now()): string[] {
    const entry = this.documents.get(key);
    if (!entry || entry.kind !== 'notebook') return [];
    if (this.collectionGuard && !this.collectionGuard(now)) {
      // Restart the whole grace measurement once collection becomes safe again,
      // so an absent peer never loses cell content that it is still editing.
      this.unreferencedSince.get(key)?.clear();
      return [];
    }
    const data = entry.doc.getMap<Y.Map<unknown>>('cellData');
    const referenced = new Set(entry.doc.getArray<string>('cells').toArray());
    const unreferencedSince = this.unreferencedSince.get(key) ?? new Map<string, number>();
    this.unreferencedSince.set(key, unreferencedSince);
    const collected: string[] = [];
    for (const id of [...data.keys()]) {
      if (referenced.has(id)) {
        unreferencedSince.delete(id);
        continue;
      }
      const since = unreferencedSince.get(id);
      if (since === undefined) {
        unreferencedSince.set(id, now);
        continue;
      }
      if (now - since < graceMs) continue;
      unreferencedSince.delete(id);
      collected.push(id);
    }
    for (const id of [...unreferencedSince.keys()]) {
      if (!data.has(id)) unreferencedSince.delete(id);
    }
    if (collected.length) {
      entry.doc.transact(() => {
        for (const id of collected) data.delete(id);
      }, withScope(LOCAL_EDITOR_ORIGIN, { type: 'structure' }));
      const known = this.collectedIds.get(key) ?? new Set<string>();
      for (const id of collected) known.add(id);
      this.collectedIds.set(key, known);
    }
    return collected;
  }

  /**
   * Removes order entries that point at cell state this peer already collected.
   * Without this repair a returning peer could re-reference a collected id and
   * leave the notebook with a visible cell that has no payload at all; the
   * repair is a deterministic function of converged state, so every peer
   * produces the same result.
   */
  public repairCollectedResurrections(key: string): string[] {
    const entry = this.documents.get(key);
    const known = this.collectedIds.get(key);
    if (!entry || entry.kind !== 'notebook' || !known?.size) return [];
    const data = entry.doc.getMap<Y.Map<unknown>>('cellData');
    const order = entry.doc.getArray<string>('cells');
    const dangling: number[] = [];
    const repaired: string[] = [];
    order.toArray().forEach((id, index) => {
      if (data.has(id) || !known.has(id)) return;
      dangling.push(index);
      repaired.push(id);
    });
    if (!dangling.length) return [];
    entry.doc.transact(() => {
      for (const index of dangling.reverse()) order.delete(index, 1);
    }, withScope(LOCAL_EDITOR_ORIGIN, { type: 'structure' }));
    this.emit('cellStateRepaired', key, repaired);
    return repaired;
  }

  /** Collects garbage for every notebook document. */
  public collectAllGarbage(graceMs = 30_000, now = Date.now()): void {
    for (const [key, entry] of this.documents) {
      if (entry.kind !== 'notebook') continue;
      this.collectGarbage(key, graceMs, now);
      this.repairCollectedResurrections(key);
    }
  }


  public encodeStateVector(key: string): Uint8Array {
    return Y.encodeStateVector(this.requireDocument(key).doc);
  }

  public encodeUpdate(key: string, remoteStateVector?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.requireDocument(key).doc, remoteStateVector);
  }

  public applyRemoteUpdate(key: string, kind: DocumentKind, update: Uint8Array, scope?: ProjectUpdate['scope']): void {
    const entry = this.documents.get(key) ?? this.createDocument(key, kind);
    if (entry.kind !== kind) throw new Error(`Document kind mismatch for ${key}`);
    this.applyingRemoteScope = scope;
    try {
      Y.applyUpdate(entry.doc, update, REMOTE_ORIGIN);
    } finally {
      this.applyingRemoteScope = undefined;
    }
  }

  public destroy(): void {
    for (const entry of this.documents.values()) entry.doc.destroy();
    this.documents.clear();
    this.unreferencedSince.clear();
    this.collectedIds.clear();
    this.normalizing.clear();
    this.removeAllListeners();
  }

  private requireDocument(key: string): ProjectDocument {
    const entry = this.documents.get(key);
    if (!entry) throw new Error(`Unknown collaborative document: ${key}`);
    return entry;
  }
}

function withScope(origin: unknown, scope: ProjectUpdate['scope']): unknown {
  return origin === REMOTE_ORIGIN ? origin : { pairNotebookOrigin: origin, pairNotebookScope: scope };
}

function scopedOrigin(origin: unknown): { origin: unknown; scope?: ProjectUpdate['scope'] } {
  if (!origin || typeof origin !== 'object') return { origin };
  const value = origin as { pairNotebookOrigin?: unknown; pairNotebookScope?: ProjectUpdate['scope'] };
  return 'pairNotebookOrigin' in value
    ? { origin: value.pairNotebookOrigin, scope: value.pairNotebookScope }
    : { origin };
}

function normalizeNotebookSnapshot(snapshot: NotebookSnapshot): NotebookSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.cells)) {
    throw new Error('Notebook snapshot is malformed.');
  }
  if (snapshot.cells.length > MAX_NOTEBOOK_CELLS) {
    throw new Error(`Notebook exceeds the ${MAX_NOTEBOOK_CELLS}-cell limit.`);
  }
  const seen = new Set<string>();
  const cells = snapshot.cells.map((rawCell): CellSnapshot => {
    const id = rawCell.id || newId();
    if (!isValidCellId(id) || seen.has(id)) throw new Error('Notebook contains an invalid or duplicate cell id.');
    seen.add(id);
    if (rawCell.kind !== 1 && rawCell.kind !== 2) throw new Error(`Notebook cell ${id} has an invalid kind.`);
    if (typeof rawCell.source !== 'string' || Buffer.byteLength(rawCell.source, 'utf8') > MAX_CELL_SOURCE_BYTES) {
      throw new Error(`Notebook cell ${id} exceeds the source-size limit.`);
    }
    return {
      id,
      kind: rawCell.kind,
      language: boundedLanguage(rawCell.language),
      source: rawCell.source,
      metadata: normalizeMetadata(rawCell.metadata ?? {}, 'Cell metadata'),
      outputs: normalizeOutputSnapshots(rawCell.outputs ?? []),
      execution: normalizeExecutionSnapshot(rawCell.execution),
    };
  });
  const normalized = {
    metadata: normalizeMetadata(snapshot.metadata ?? {}, 'Notebook metadata'),
    cells,
  };
  const serialized = stringifyJson(normalized, 'Notebook snapshot');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NOTEBOOK_STATE_BYTES) {
    throw new Error(`Notebook exceeds the ${MAX_NOTEBOOK_STATE_BYTES}-byte collaborative-state limit.`);
  }
  return normalized;
}

function normalizeMetadata(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const serialized = stringifyJson(value, label);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NOTEBOOK_METADATA_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_NOTEBOOK_METADATA_JSON_BYTES}-byte limit.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeOutputSnapshots(value: unknown): OutputSnapshot[] {
  if (!Array.isArray(value)) throw new Error('Notebook outputs must be an array.');
  if (value.length > MAX_CELL_OUTPUTS) throw new Error(`Cell exceeds the ${MAX_CELL_OUTPUTS}-output limit.`);
  let itemCount = 0;
  const outputs = value.map((raw): OutputSnapshot => {
    if (!isPlainRecord(raw) || !Array.isArray(raw.items)) throw new Error('Notebook output is malformed.');
    itemCount += raw.items.length;
    if (itemCount > MAX_OUTPUT_ITEMS_PER_CELL) {
      throw new Error(`Cell exceeds the ${MAX_OUTPUT_ITEMS_PER_CELL}-item output limit.`);
    }
    const items = raw.items.map((item) => {
      if (!isPlainRecord(item) || !isValidMime(item.mime) || !isValidBase64(item.dataBase64)) {
        throw new Error('Notebook output item is malformed.');
      }
      return { mime: item.mime, dataBase64: item.dataBase64 };
    });
    return {
      items,
      ...(raw.metadata === undefined ? {} : { metadata: normalizeMetadata(raw.metadata, 'Output metadata') }),
    };
  });
  const serialized = stringifyJson(outputs, 'Cell outputs');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CELL_OUTPUT_JSON_BYTES) {
    throw new Error(`Cell outputs exceed the ${MAX_CELL_OUTPUT_JSON_BYTES}-byte limit.`);
  }
  return outputs;
}

function parseObject(value: unknown, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeMetadata(parsed, 'Notebook metadata');
  } catch {
    return {};
  }
}

function parseOutputs(value: unknown): OutputSnapshot[] {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CELL_OUTPUT_JSON_BYTES) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeOutputSnapshots(parsed);
  } catch {
    return [];
  }
}

function parseExecution(value: unknown): CellExecutionSnapshot | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeExecutionSnapshot(parsed);
  } catch {
    return undefined;
  }
}

function normalizeExecutionSnapshot(value: unknown): CellExecutionSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) throw new Error('Cell execution summary is malformed.');
  const executionOrder = value.executionOrder;
  const success = value.success;
  const timing = value.timing;
  if (executionOrder !== undefined && (!Number.isSafeInteger(executionOrder) || Number(executionOrder) < 0)) {
    throw new Error('Cell execution order is malformed.');
  }
  if (success !== undefined && typeof success !== 'boolean') throw new Error('Cell execution result is malformed.');
  let normalizedTiming: CellExecutionSnapshot['timing'];
  if (timing !== undefined) {
    if (!isPlainRecord(timing) || !Number.isFinite(timing.startTime) || !Number.isFinite(timing.endTime)
      || Number(timing.startTime) < 0 || Number(timing.endTime) < Number(timing.startTime)) {
      throw new Error('Cell execution timing is malformed.');
    }
    normalizedTiming = { startTime: Number(timing.startTime), endTime: Number(timing.endTime) };
  }
  return {
    ...(executionOrder === undefined ? {} : { executionOrder: Number(executionOrder) }),
    ...(success === undefined ? {} : { success }),
    ...(normalizedTiming ? { timing: normalizedTiming } : {}),
  };
}

function boundedLanguage(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_LANGUAGE_LENGTH || hasControlCharacters(value)) {
    return 'python';
  }
  return value;
}

function boundedSource(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_CELL_SOURCE_BYTES) {
    throw new Error('Notebook cell exceeds the source-size limit after collaborative merging.');
  }
  return value;
}

function cellTextRevisionSequence(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^r([1-9][0-9]*)_[A-Za-z0-9_-]{1,96}$/.exec(value);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

function nextCellTextRevision(previous?: unknown): string {
  const sequence = (cellTextRevisionSequence(previous) ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Notebook cell text revision reached its supported limit.');
  }
  return `r${sequence}_${newId()}`;
}

function isValidCellId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_CELL_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidMime(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 256
    && value.includes('/') && /^[\x21-\x7e]+$/.test(value);
}

function isValidBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error(`${label} is not JSON-serializable.`);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is not JSON-serializable.`) throw error;
    throw new Error(`${label} is not JSON-serializable.`);
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validatedTextChanges(
  changes: readonly TextChange[],
  currentValue: string,
  maximumBytes: number,
  label: string,
): TextChange[] {
  if (!Array.isArray(changes) || changes.length > MAX_TEXT_CHANGES_PER_EVENT) {
    throw new Error(`${label} contains too many text changes.`);
  }
  const ascending = [...changes].sort((a, b) => a.offset - b.offset || a.deleteCount - b.deleteCount);
  const currentLength = currentValue.length;
  let previousEnd = 0;
  let nextLength = currentLength;
  let nextBytes = Buffer.byteLength(currentValue, 'utf8');
  for (const change of ascending) {
    if (!change || !Number.isSafeInteger(change.offset) || !Number.isSafeInteger(change.deleteCount)
      || change.offset < 0 || change.deleteCount < 0 || change.offset + change.deleteCount > currentLength
      || typeof change.insertText !== 'string' || Buffer.byteLength(change.insertText, 'utf8') > maximumBytes) {
      throw new Error(`Text change is outside ${label}.`);
    }
    if (change.offset < previousEnd) throw new Error(`Text changes overlap in ${label}.`);
    previousEnd = change.offset + change.deleteCount;
    nextLength += change.insertText.length - change.deleteCount;
    nextBytes += Buffer.byteLength(change.insertText, 'utf8')
      - Buffer.byteLength(currentValue.slice(change.offset, change.offset + change.deleteCount), 'utf8');
  }
  if (!Number.isSafeInteger(nextLength) || nextLength < 0 || nextLength > maximumBytes
    || !Number.isSafeInteger(nextBytes) || nextBytes < 0 || nextBytes > maximumBytes) {
    throw new Error(`${label} exceeds the collaborative text-size limit.`);
  }
  return ascending.reverse();
}
