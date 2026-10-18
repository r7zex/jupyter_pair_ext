import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import { diffChars } from 'diff';
import { atomicWriteFile } from '../core/atomicFile';
import { CollaborativeProject, type NotebookSnapshot, type CellSnapshot, type TextChange } from '../core/crdt';
import { createSharedCursorPosition, encodeRelativeOffset, resolveRelativeOffset, resolveSharedCursorPosition } from '../core/cursorPosition';
import { rebaseTextChanges } from '../core/textChanges';
import { StableCellIdRegistry } from '../core/notebookIdentity';
import { normalizeNotebookMetadata, parseIpynb, serializeIpynb } from '../core/projectFiles';
import { REMOTE_ORIGIN } from '../core/types';
import type { PresenceState } from '../runtime/session';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import { isPermanentConnectionError } from '../vps/compatibility';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply, type SharedNotebook } from '../vps/persistentNotebookCrdt';
import type { PersistentLiveEvent, PersistentPresence } from '../vps/persistentLive';
import { cellUserMetadata, hasLegacyNotebookMetadata, notebookUserMetadata } from './persistentNotebookMetadata';
import { PresenceRenderer, type PresenceSource } from './presence';
import { participantColor, commentColor, type LineComment, type LineCommentInput } from '../core/lineComments';
import { EditorSynchronizer, executionFromCell, outputsFromCell, type EditorTextIntentRequest, type NotebookCellStateRenderer } from './sync';
import { SESSION_NOTEBOOK_TYPE } from './sessionNotebook';
import { rebaseInitialTextChanges } from './initialTextChanges';

interface Connection { sessionId: string; memberId: string; endpoint: string; client: PersistentClient }
interface Intent { actor: string; sequence: number; cellId: string; baseline: string; changes: TextChange[]; update?: string }
function applyChanges(source: string, changes: readonly TextChange[]): string {
  for (const change of [...changes].sort((a, b) => b.offset - a.offset)) source = source.slice(0, change.offset) + change.insertText + source.slice(change.offset + change.deleteCount);
  return source;
}
function changesBetween(before: string, after: string): TextChange[] | undefined {
  const parts = diffChars(before, after, { timeout: 5 }); if (!parts) return undefined;
  const changes: TextChange[] = []; let offset = 0;
  for (const part of parts) {
    if (part.added) changes.push({ offset, deleteCount: 0, insertText: part.value });
    else { if (part.removed) changes.push({ offset, deleteCount: part.value.length, insertText: '' }); offset += part.value.length; }
  }
  return changes.length > 100 ? undefined : changes.length ? changes : [{ offset: 0, deleteCount: 0, insertText: '' }];
}
function mapTextOffset(before: string, after: string, offset: number): number | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > before.length) return undefined;
  if (before === after) return offset;
  const changes = changesBetween(before, after); if (!changes) return undefined;
  let adjustment = 0;
  for (const change of changes) {
    if (offset < change.offset) break;
    if (offset < change.offset + change.deleteCount) return change.offset + adjustment + change.insertText.length;
    adjustment += change.insertText.length - change.deleteCount;
  }
  return offset + adjustment;
}
interface State {
  connection: Connection; notebook: vscode.NotebookDocument; key: string; file: string; doc: Y.Doc; project: CollaborativeProject;
  ids: StableCellIdRegistry<vscode.NotebookCell>; epoch: string; revision: number; actor: string; sequence: number;
  intents: Intent[]; ready: Promise<void>; sending?: Promise<void>; editor?: EditorSynchronizer;
  activeIntent?: Intent; acknowledgedSequence: number; identity?: string | undefined;
  journalTail?: Promise<void>;
  conflictPrompted?: boolean;
  savedCells?: Map<string, CellSnapshot>;
  structural: number; closed: boolean; blocked: boolean;
  structureUpdate?: string;
  dirtyCells: Set<string>;
  structureChanged: boolean;
  initialized: boolean;
  initial: Map<string, string>;
}

/** VPS transport adapter for the EditorSynchronizer/EditorTextReplica used by a human host. */
export class PersistentNotebookSynchronizer implements vscode.Disposable {
  public canEdit: ((key: string) => boolean) | undefined;
  public commentCellId(cell: vscode.NotebookCell): string | undefined { return this.states.get(cell.notebook)?.ids.knownId(cell); }
  public async commentAnchors(cell: vscode.NotebookCell, start: number, end: number): Promise<Pick<LineCommentInput, 'startAnchor' | 'endAnchor' | 'epoch'>> {
    await this.flush(cell.notebook);
    const state = this.states.get(cell.notebook), id = state?.ids.knownId(cell);
    const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(id ?? '')?.get('source');
    if (!state || !id || !(text instanceof Y.Text) || text.toString() !== cell.document.getText()) throw new Error('Wait for notebook synchronization before commenting.');
    return { epoch: state.epoch, startAnchor: encodeRelativeOffset(text, start), endAnchor: encodeRelativeOffset(text, end) };
  }
  public resolveComment(comment: LineComment): { start: number; end: number } | undefined {
    const state = [...this.states.values()].find((state) => state.key === comment.path && state.epoch === comment.epoch);
    const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(comment.cellId ?? '')?.get('source');
    if (!state || !(text instanceof Y.Text)) return undefined;
    const start = resolveRelativeOffset(text, comment.startAnchor, undefined), end = resolveRelativeOffset(text, comment.endAnchor, undefined);
    const first = start === undefined ? undefined : this.displayedOffset(state, comment.cellId!, start), last = end === undefined ? undefined : this.displayedOffset(state, comment.cellId!, end);
    return first === undefined || last === undefined ? undefined : { start: first, end: last };
  }
  public fileEvent: ((event: PersistentLiveEvent) => void) | undefined;
  private readonly states = new Map<vscode.NotebookDocument, State>();
  private readonly retired = new WeakSet<vscode.NotebookDocument>();
  private readonly archives = new Set<Promise<void>>();
  public assertAvailable(notebook: vscode.NotebookDocument): void {
    if (this.retired.has(notebook)) throw new Error('This notebook instance was deleted or replaced. Its buffer is preserved; use Save As for recovery and close it before opening the current server file.');
  }
  public isRetired(notebook: vscode.NotebookDocument): boolean { return this.retired.has(notebook); }
  public epochOf(notebook: vscode.NotebookDocument): string | undefined { return this.states.get(notebook)?.epoch || undefined; }
  public retire(notebook: vscode.NotebookDocument, reason: 'deleted' | 'replaced'): Promise<void> {
    if (this.retired.has(notebook)) return Promise.resolve();
    this.retired.add(notebook);
    const state = this.states.get(notebook);
    if (state) { state.blocked = true; state.editor?.dispose(); }
    const connection = state?.connection ?? this.connection();
    if (!connection) return Promise.resolve();
    const file = state?.file ?? this.journalFile(connection, notebook);
    const archive = `${file}.${reason}-${randomUUID()}`;
    const snapshot = serializeIpynb({ metadata: normalizeNotebookMetadata(notebook.metadata), cells: notebook.getCells().map(cell => ({
      id: state?.ids.knownId(cell) ?? cell.metadata.pairNotebookCellId ?? cell.metadata.id ?? randomUUID(),
      kind: cell.kind, language: cell.document.languageId, source: cell.document.getText(), metadata: cell.metadata,
      outputs: outputsFromCell(cell), execution: executionFromCell(cell),
    })) });
    // Capture the replica before destroying its editor; late callbacks are fenced immediately.
    const journal = state && !state.closed ? this.journal(state) : Promise.resolve();
    if (state) this.closeState(state);
    const work = (async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicWriteFile(`${archive}.ipynb`, snapshot);
      await journal;
      if (state) {
        try { await rename(file, `${archive}.json`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.log.appendLine(`[info] ${reason} notebook buffer archived at ${archive}.ipynb`);
    })();
    this.archives.add(work);
    void work.finally(() => this.archives.delete(work)).catch(() => undefined);
    return work;
  }
  private journalFile(connection: Connection, notebook: vscode.NotebookDocument): string {
    return path.join(this.context.globalStorageUri.fsPath, 'persistent-replicas', createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId, notebook.uri.path])).digest('hex') + '.json');
  }
  private readonly remoteBootstrap = new WeakSet<vscode.NotebookDocument>();
  private readonly presenceEvents = new EventEmitter();
  private presence: PersistentPresence[] = [];
  public participantColors(): Record<string, string> {
    return Object.fromEntries(this.presence.map(state => [state.peer.peerId, state.cursorColor]));
  }
  private stream: { dispose(): void } | undefined;
  private streamConnection: Connection | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private readonly listeners: vscode.Disposable[];
  private readonly heartbeat: NodeJS.Timeout;
  private renderer: PresenceRenderer | undefined;
  private presencePending = false;
  private presenceSending = false;
  private presenceAgain = false;
  private lastPresence: Record<string, unknown> | undefined;
  private lastPresenceAt = 0;
  private lastWarning = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly connection: () => Connection | undefined, private readonly log: Pick<vscode.OutputChannel, 'appendLine'> = { appendLine: () => undefined }, private readonly invalidate: () => void = () => undefined, private readonly execution: (event: Extract<PersistentLiveEvent, { kind: 'execution' }>) => void = () => undefined, private readonly cellStateRenderer?: NotebookCellStateRenderer) {
    this.listeners = [vscode.workspace.onDidCloseNotebookDocument((notebook) => { const state = this.states.get(notebook); if (state) { if (state.intents.length || state.structural) void this.journal(state).catch((error) => this.report(error)).finally(() => this.closeState(state)); else this.closeState(state); } }),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedulePresence()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePresence()),
      vscode.window.onDidChangeWindowState(() => this.schedulePresence())];
    this.heartbeat = setInterval(() => { this.ensureStream(); this.schedulePresence(); }, 1000); this.heartbeat.unref();
  }
  dispose(): void { clearInterval(this.heartbeat); for (const listener of this.listeners) listener.dispose(); this.reset(); }
  async checkpoint(): Promise<void> {
    await Promise.all([...this.archives, ...[...this.states.values()].filter(state => state.initialized && !state.closed).map(state => this.journal(state))]);
  }
  async shutdown(): Promise<void> {
    clearInterval(this.heartbeat); for (const listener of this.listeners) listener.dispose();
    await Promise.all([...this.states.values()].filter((state) => state.initialized && !state.closed)
      .map((state) => this.journal(state).catch((error) => this.report(error))));
    this.reset(false);
    await Promise.all(this.archives);
  }
  reset(preserve = true): void {
    this.stream?.dispose(); this.stream = undefined; this.streamConnection = undefined;
    if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    for (const state of [...this.states.values()]) { if (preserve && state.initialized && !state.blocked) void this.journal(state).catch((error) => this.report(error)); this.closeState(state); }
    this.renderer?.dispose(); this.renderer = undefined; this.presence = []; this.presenceEvents.emit('presence');
    this.lastPresence = undefined;
  }
  private closeState(state: State): void { if (state.closed) return; state.closed = true; state.editor?.dispose(); state.project.destroy(); state.doc.destroy(); this.states.delete(state.notebook); this.schedulePresence(); }
  private current(state: State): void {
    if (state.closed || this.connection() !== state.connection) throw new Error('Notebook synchronization connection changed.');
    if (state.blocked) throw new Error('Notebook synchronization is recovering a replaced or rejected replica.');
  }
  private report(error: unknown): void {
    this.log.appendLine(`[error] Persistent notebook synchronization: ${error instanceof Error ? error.message : 'Operation failed.'}`);
    if (Date.now() - this.lastWarning > 10_000) { this.lastWarning = Date.now(); void vscode.window.showWarningMessage(`Pair Notebook VPS: ${error instanceof Error ? error.message : 'Synchronization failed.'}`); }
  }
  private async conflict(state: State, rejected = false): Promise<void> {
    if (state.conflictPrompted || state.closed) return; state.conflictPrompted = true; state.blocked = true;
    try {
      await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 });
      await atomicWriteFile(`${state.file}.conflict-${randomUUID()}.json`, JSON.stringify({ epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64'), intents: state.intents,
        displayed: state.notebook.getCells().map((cell) => ({ id: state.ids.knownId(cell), source: cell.document.getText(), metadata: cell.metadata })) }));
      if (state.closed || this.connection() !== state.connection) return;
      void vscode.window.showWarningMessage(rejected ? 'The server could not accept this edit. Local edits were archived for recovery; reconnecting to the saved version.' : 'The notebook was replaced or its access changed. Local edits were archived for recovery; reconnecting to the current version.');
      try { await rename(state.file, `${state.file}.conflict-journal-${randomUUID()}.json`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!rejected) { await this.retire(state.notebook, 'replaced'); return; }
      this.remoteBootstrap.add(state.notebook); this.closeState(state); await this.flush(state.notebook);
    } finally { delete state.conflictPrompted; }
  }
  private ensureStream(): void {
    const connection = this.connection(); if (!connection || this.reconnect || this.streamConnection === connection) return;
    if (this.streamConnection) this.reset(); this.streamConnection = connection;
    try { this.stream = connection.client.subscribe(connection.sessionId, (event) => { if (this.streamConnection === connection) this.receive(event); }, () => {
      if (this.streamConnection !== connection) return;
      this.stream = undefined; this.streamConnection = undefined; this.presence = []; this.presenceEvents.emit('presence');
      this.reconnect = setTimeout(() => { this.reconnect = undefined; this.ensureStream(); }, 1000); this.reconnect.unref();
    }); } catch (error) {
      this.streamConnection = undefined; this.report(error);
      this.reconnect = setTimeout(() => { this.reconnect = undefined; this.ensureStream(); }, 1000); this.reconnect.unref(); return;
    }
    if (!this.renderer) {
      const source: PresenceSource = { exactCursor: true, descriptor: { workingFolder: '', localPeer: { peerId: connection.memberId } },
        on: (_event, listener) => this.presenceEvents.on('presence', listener), off: (_event, listener) => this.presenceEvents.off('presence', listener),
        snapshot: () => ({ awareness: this.presence }), notebookKey: (uri) => uri.scheme === 'pair-vps' && uri.authority === connection.sessionId ? uri.path.slice(1) : undefined,
        notebookCellId: (cell) => this.states.get(cell.notebook)?.ids.knownId(cell), resolvePresenceLineOffset: (state) => this.presenceOffset(state),
        resolvePresenceCursor: (presence) => {
          const state = [...this.states.values()].find((item) => item.key === presence.activeFile); const cellId = presence.activeNotebookCellId ?? '';
          const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(cellId)?.get('source'); const cursor = text instanceof Y.Text && presence.cursor ? resolveSharedCursorPosition(text, presence.cursor) : undefined;
          if (!state || !cursor) return undefined;
          const anchor = this.displayedOffset(state, cellId, cursor.anchor); const active = this.displayedOffset(state, cellId, cursor.active);
          return anchor !== undefined && active !== undefined ? { anchor, active } : undefined;
        } };
      this.renderer = new PresenceRenderer(source);
    }
  }
  private receive(event: PersistentLiveEvent): void {
    this.fileEvent?.(event);
    if (event.kind === 'text') return;
    if (event.kind === 'execution') { this.execution(event); return; }
    if (event.kind === 'presence') { this.presence = event.states; this.presenceEvents.emit('presence'); return; }
    if (event.kind === 'ready' || event.kind === 'invalidate') {
      this.invalidate(); for (const state of this.states.values()) void this.flush(state.notebook).catch((error) => this.report(error)); return;
    }
    for (const state of this.states.values()) if (state.key === event.path && state.epoch === event.epoch && !state.closed && !state.blocked) {
      if (event.acknowledgement?.actor === state.actor) state.acknowledgedSequence = Math.max(state.acknowledgedSequence, event.acknowledgement.sequence);
      Y.applyUpdate(state.doc, Buffer.from(event.update, 'base64')); state.revision = Math.max(state.revision, event.revision); this.applyCanonical(state);
    }
  }
  private presenceOffset(presence: PresenceState): number | undefined {
    const state = [...this.states.values()].find((item) => item.key === presence.activeFile);
    const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(presence.activeNotebookCellId ?? '')?.get('source');
    const offset = resolveRelativeOffset(text instanceof Y.Text ? text : undefined, presence.activeLineAnchor, undefined);
    return state && offset !== undefined ? this.displayedOffset(state, presence.activeNotebookCellId ?? '', offset) : undefined;
  }
  private displayedOffset(state: State, cellId: string, offset: number): number | undefined {
    const text = state.doc.getMap<Y.Map<unknown>>('cells').get(cellId)?.get('source');
    const cell = state.notebook.getCells().find((candidate) => state.ids.knownId(candidate) === cellId);
    if (!(text instanceof Y.Text) || !cell || !state.project.has(state.key)) return undefined;
    const projected = state.project.notebookCellSnapshot(state.key, cellId)?.source; if (projected === undefined) return undefined;
    const position = mapTextOffset(text.toString(), projected, offset);
    return position !== undefined ? mapTextOffset(projected, cell.document.getText(), position) : undefined;
  }
  private schedulePresence(): void {
    if (this.presencePending) return; this.presencePending = true;
    const timer = setTimeout(() => {
      this.presencePending = false; if (this.presenceSending) { this.presenceAgain = true; return; } this.presenceSending = true;
      void this.publishPresence().catch((error) => this.log.appendLine(`[debug] Persistent presence unavailable: ${error instanceof Error ? error.message : 'Disconnected.'}`)).finally(() => {
        this.presenceSending = false; if (this.presenceAgain) { this.presenceAgain = false; this.schedulePresence(); }
      });
    }, 30); timer.unref();
  }
  private async publishPresence(): Promise<void> {
    const connection = this.connection(); if (!connection || !this.stream) return;
    const editor = vscode.window.activeTextEditor;
    const state = editor && [...this.states.values()].find((item) => item.notebook.getCells().some((cell) => cell.document === editor.document));
    const cell = state && editor && state.notebook.getCells().find((item) => item.document === editor.document);
    let fields: Record<string, unknown> = {};
    if (state && cell && state.editor && state.epoch && !state.blocked) {
      const cellId = state.ids.knownId(cell); const offset = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(new vscode.Position(editor!.selection.active.line, 0)));
      const text = state.doc.getMap<Y.Map<unknown>>('cells').get(cellId ?? '')?.get('source');
      if (text instanceof Y.Text && offset !== undefined) {
        const projected = state.project.cellSource(state.key, cellId!).toString(); const confirmed = text.toString();
        const anchor = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(editor!.selection.anchor));
        const active = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(editor!.selection.active));
        const linePosition = mapTextOffset(projected, confirmed, offset); const anchorPosition = anchor !== undefined ? mapTextOffset(projected, confirmed, anchor) : undefined; const activePosition = active !== undefined ? mapTextOffset(projected, confirmed, active) : undefined;
        if (linePosition !== undefined) fields = { path: state.key, epoch: state.epoch, cellId, activeLineAnchor: encodeRelativeOffset(text, linePosition), ...(anchorPosition !== undefined && activePosition !== undefined ? { cursor: createSharedCursorPosition(text, anchorPosition, activePosition) } : {}) };
        else if (this.lastPresence?.path === state.key && this.lastPresence.cellId === cellId && this.lastPresence.epoch === state.epoch) fields = this.lastPresence;
      }
      else if (this.lastPresence?.path === state.key && this.lastPresence.cellId === cellId && this.lastPresence.epoch === state.epoch) fields = this.lastPresence;
    }
    if (this.lastPresence && JSON.stringify(fields) === JSON.stringify(this.lastPresence) && Date.now() - this.lastPresenceAt < 750) return;
    const configuredColor = vscode.workspace.getConfiguration('pairNotebook').get<string>('cursorColor', '');
    const reply = await connection.client.call<{ states: PersistentPresence[] }>('presence', { sessionId: connection.sessionId, ...fields, cursorColor: configuredColor ? commentColor(configuredColor) : participantColor(connection.memberId) });
    if (this.connection() === connection) { this.lastPresence = fields; this.lastPresenceAt = Date.now(); this.presence = reply.states; this.presenceEvents.emit('presence'); }
  }
  private async journal(state: State): Promise<void> {
    // Capture before any await: disconnect/dispose may destroy the live docs
    // while an earlier disk write is still queued.
    const bytes = JSON.stringify({ epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64'), actor: state.actor, sequence: state.sequence, intents: state.intents, structureUpdate: state.structureUpdate, ...(state.structural ? { snapshot: this.outbound(state) } : {}) });
    const write = (state.journalTail ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 });
      await atomicWriteFile(state.file, bytes);
    });
    state.journalTail = write; return write;
  }
  private async initialize(state: State): Promise<void> {
    const reply = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, actor: state.actor, bootstrapEmpty: true }); this.current(state);
    const marker = state.notebook.metadata.pairNotebookServerEpoch;
    const legacyFile = this.journalFile(state.connection, state.notebook);
    state.file = `${legacyFile}.epoch-${createHash('sha256').update(reply.epoch).digest('hex').slice(0, 24)}.json`;
    if (typeof marker === 'string' && marker !== reply.epoch) {
      await this.retire(state.notebook, 'replaced'); throw new Error('The server notebook has a new epoch. The previous editor was preserved for recovery.');
    }
    let saved: { epoch: string; update: string; actor?: string; sequence?: number; intents?: Intent[]; snapshot?: SharedNotebook; structureUpdate?: string } | undefined;
    try {
      let bytes: string;
      try { bytes = await readFile(state.file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = await readFile(legacyFile, 'utf8'); }
      saved = JSON.parse(bytes);
      if (!saved || typeof saved.epoch !== 'string' || typeof saved.update !== 'string' || (saved.intents !== undefined && !Array.isArray(saved.intents))) throw new SyntaxError('Invalid replica journal.');
      const probe = new Y.Doc(); try { Y.applyUpdate(probe, Buffer.from(saved.update, 'base64')); } finally { probe.destroy(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
        await rename(state.file, `${state.file}.invalid-${randomUUID()}.json`); saved = undefined;
        this.log.appendLine('[warn] Invalid notebook replica journal archived; reconnecting from the server and current editor buffer.');
      }
    }
    this.current(state);
    if (saved && this.canEdit?.(state.key) === false) { await rename(state.file, `${state.file}.read-only-${randomUUID()}.json`); saved = undefined; this.remoteBootstrap.add(state.notebook); }
    if (saved && saved.epoch !== reply.epoch) {
      await atomicWriteFile(`${legacyFile}.conflict-${randomUUID()}.json`, JSON.stringify(saved));
      saved = undefined;
      if (state.notebook.isDirty) { await this.retire(state.notebook, 'replaced'); throw new Error('Old notebook changes were archived; close the preserved editor before opening the new file.'); }
      this.remoteBootstrap.add(state.notebook);
    }
    if (saved?.actor && /^[A-Za-z0-9_-]{32,64}$/.test(saved.actor) && Number.isSafeInteger(saved.sequence)) { state.actor = saved.actor; state.sequence = saved.sequence!; state.intents = saved.intents ?? []; }
    if (reply.textProtocol !== 'yjs-intents-v1') throw new Error('The VPS server needs an update before live editing can connect safely.');
    if (reply.bootstrapEmpty && state.notebook.cellCount && this.canEdit?.(state.key) !== false && !this.remoteBootstrap.has(state.notebook)) {
      const cells = state.notebook.getCells().map((cell) => {
        const candidate = cell.metadata.id ?? cell.metadata.pairNotebookCellId;
        const id = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : randomUUID();
        state.ids.seed(cell, undefined, id);
        return { id, cell_type: cell.kind === 2 ? 'code' : 'markdown', source: cell.document.getText(), metadata: cellUserMetadata(cell.metadata, typeof cell.metadata.id === 'string' && !!cell.metadata.metadata) };
      });
      const initial = await state.connection.client.call<NotebookSyncReply>('notebookSync', {
        sessionId: state.connection.sessionId, path: state.key, actor: state.actor, epoch: reply.epoch,
        snapshotStateVector: Buffer.from(Y.encodeStateVectorFromUpdate(Buffer.from(reply.update, 'base64'))).toString('base64'),
        snapshot: { cells, metadata: notebookUserMetadata(state.notebook.metadata) },
      }); this.current(state); Object.assign(reply, initial);
    }
    state.acknowledgedSequence = reply.acknowledgedSequence ?? 0;
    Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.epoch = reply.epoch; state.revision = reply.revision; state.identity = reply.identity;
    const vector = Y.encodeStateVector(state.doc);
    if (saved) {
      if (saved.epoch !== reply.epoch) { await atomicWriteFile(`${state.file}.conflict-${randomUUID()}.json`, JSON.stringify(saved)); state.blocked = true; throw new PersistentHttpError(409); }
      Y.applyUpdate(state.doc, Buffer.from(saved.update, 'base64'));
      if (saved.structureUpdate) { state.structureUpdate = saved.structureUpdate; state.structural = 1; }
      else if (saved.snapshot) { editSharedNotebook(state.doc, saved.snapshot); state.structureUpdate = Buffer.from(Y.encodeStateAsUpdate(state.doc, vector)).toString('base64'); state.structural = 1; }
    }
    if (this.canEdit?.(state.key) !== false) {
    let shared = sharedNotebook(state.doc);
    await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 });
    if (hasLegacyNotebookMetadata(shared.metadata)) await atomicWriteFile(`${state.file}.legacy-metadata-${randomUUID()}.json`, JSON.stringify(saved ?? { epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64') }));
    shared = { ...shared, metadata: notebookUserMetadata(shared.metadata), cells: shared.cells.map((cell) => ({ ...cell, metadata: cellUserMetadata(cell.metadata, typeof cell.metadata.id === 'string' && !!cell.metadata.metadata) })) };
    editSharedNotebook(state.doc, shared);
    const cleaned = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, actor: state.actor, epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc, vector)).toString('base64') }); this.current(state);
    Y.applyUpdate(state.doc, Buffer.from(cleaned.update, 'base64')); state.revision = cleaned.revision; state.identity = cleaned.identity;
    state.acknowledgedSequence = Math.max(state.acknowledgedSequence, cleaned.acknowledgedSequence ?? 0);
    }
    await this.readSavedCells(state);
    if (state.project.has(state.key)) state.project.reconcileNotebook(state.key, this.projectedSnapshot(state), REMOTE_ORIGIN);
    else state.project.ensureNotebook(state.key, this.projectedSnapshot(state));
    if (saved?.snapshot) { state.project.reconcileNotebook(state.key, { metadata: normalizeNotebookMetadata(saved.snapshot.metadata), cells: saved.snapshot.cells.map((cell) => ({ id: cell.id, source: cell.source, kind: cell.cell_type === 'code' ? 2 : 1, language: cell.cell_type === 'code' ? 'python' : 'markdown', metadata: cell.metadata, outputs: [] })) }, REMOTE_ORIGIN); state.structural = 1; }
    state.notebook.getCells().forEach((cell) => { const id = typeof cell.metadata.id === 'string' ? cell.metadata.id : cell.metadata.pairNotebookCellId; if (id) state.ids.seed(cell, undefined, id); });
    state.project.on('update', (event) => {
      if (event.origin === REMOTE_ORIGIN || !event.scope || ['cellText', 'cellOutputs', 'cellExecution'].includes(event.scope.type)) return;
      const vector = Y.encodeStateVector(state.doc);
      const next = this.outbound(state);
      // Source edits already live in this Y.Doc. Preserve raw cell types.
      for (const cell of next.cells) { const old = state.doc.getMap<Y.Map<unknown>>('cells').get(cell.id); if (old?.get('cell_type') === 'raw' && cell.cell_type === 'markdown') cell.cell_type = 'raw'; }
      editSharedNotebook(state.doc, next);
      const update = Y.encodeStateAsUpdate(state.doc, vector);
      state.structureUpdate = Buffer.from(state.structureUpdate ? Y.mergeUpdates([Buffer.from(state.structureUpdate, 'base64'), update]) : update).toString('base64');
      state.structural++; void this.send(state).catch((error) => this.report(error));
    });
    const renderer = this.cellStateRenderer && { ...this.cellStateRenderer,
      // Live runs use the controller's observer; fields read from disk are completed snapshots.
      renderRemoteCellState: (cell: vscode.NotebookCell, request: Parameters<NotebookCellStateRenderer['renderRemoteCellState']>[1]) => this.cellStateRenderer!.renderRemoteCellState(cell, { ...request, executionMode: 'snapshot' as const }) };
    const preserveInput = !this.remoteBootstrap.has(state.notebook) && this.canEdit?.(state.key) !== false; if (!preserveInput) state.initial.clear();
    state.editor = new EditorSynchronizer(state.project, '', this.log, state.ids, renderer,
      (request) => this.stage(state, request),
      (uri) => uri.toString() === state.notebook.uri.toString() ? state.key : undefined, preserveInput, (key) => this.canEdit?.(key) !== false);
    await state.editor.whenNotebookReady(state.notebook); this.remoteBootstrap.delete(state.notebook); state.initial.clear(); state.initialized = true; await this.journal(state); this.schedulePresence();
  }
  private projectSnapshot(state: State): NotebookSnapshot {
    const shared = sharedNotebook(state.doc);
    const localCells = new Map(state.notebook.getCells().map((cell) => [state.ids.knownId(cell) ?? cell.metadata.id ?? cell.metadata.pairNotebookCellId, cell]));
    return { metadata: { ...normalizeNotebookMetadata(notebookUserMetadata(shared.metadata)), pairNotebookServerEpoch: state.epoch }, cells: shared.cells.map((cell) => {
      const previous = state.project.has(state.key) ? state.project.notebookCellSnapshot(state.key, cell.id) : undefined;
      const local = localCells.get(cell.id);
      const saved = state.savedCells?.get(cell.id); const managing = !!local && this.cellStateRenderer?.isManagingCellState?.(local);
      const outputs = saved && !managing && saved.source === cell.source ? saved.outputs : previous?.outputs ?? local?.outputs.map((output) => ({ metadata: output.metadata, items: output.items.map((item) => ({ mime: item.mime, dataBase64: Buffer.from(item.data).toString('base64') })) })) ?? [];
      const execution = managing || (saved && saved.source !== cell.source) || (previous?.execution?.executionOrder === saved?.execution?.executionOrder && JSON.stringify(previous?.outputs) === JSON.stringify(outputs)) ? previous?.execution : saved?.source === cell.source ? saved.execution : undefined;
      return { id: cell.id, kind: cell.cell_type === 'code' ? 2 : 1, language: cell.cell_type === 'code' ? 'python' : 'markdown', source: cell.source, metadata: cell.metadata,
        outputs, execution };
    }) };
  }
  private async readSavedCells(state: State): Promise<void> {
    const file = await state.connection.client.call<{ content: string }>('read', { sessionId: state.connection.sessionId, path: state.key }); this.current(state);
    if (typeof file.content === 'string') state.savedCells = new Map(parseIpynb(Buffer.from(file.content, 'base64').toString('utf8')).cells.map((cell) => [cell.id, cell]));
  }
  private applyCanonical(state: State, rich = false): void {
    if (state.editor && state.initialized && !rich && !state.structureChanged && !state.structural) {
      for (const id of state.dirtyCells) {
        const cell = state.doc.getMap<Y.Map<unknown>>('cells').get(id);
        const source = cell?.get('source');
        if (!(source instanceof Y.Text) || !state.project.hasNotebookCell(state.key, id)) continue;
        const current = state.project.cellSource(state.key, id).toString(); const target = source.toString();
        if (current !== target) state.project.applyCellTextChanges(state.key, id, changesBetween(current, target) ?? [{ offset: 0, deleteCount: current.length, insertText: target }], REMOTE_ORIGIN);
        const metadata = cell?.get('metadata'); if (metadata) state.project.setCellMetadata(state.key, id, metadata as Record<string, unknown>, REMOTE_ORIGIN);
      }
      state.dirtyCells.clear(); return;
    }
    if (!state.editor) return; const next = this.projectedSnapshot(state); const previous = state.project.notebookSnapshot(state.key);
    state.dirtyCells.clear(); state.structureChanged = false;
    if (!state.structural && (previous.cells.length !== next.cells.length || previous.cells.some((cell, index) => cell.id !== next.cells[index]?.id || cell.kind !== next.cells[index]?.kind))) { state.project.reconcileNotebook(state.key, next, REMOTE_ORIGIN); return; }
    this.applyCells(state, next, previous);
  }
  private projectedSnapshot(state: State): NotebookSnapshot {
    const next = this.projectSnapshot(state);
    // Keep newer local input visible while projecting an earlier server commit.
    for (const intent of state.intents) if (!intent.update && intent.sequence > state.acknowledgedSequence) {
      const cell = next.cells.find((item) => item.id === intent.cellId);
      if (cell) cell.source = applyChanges(cell.source, rebaseTextChanges(intent.baseline, cell.source, intent.changes));
    }
    return next;
  }
  private applyCells(state: State, next: NotebookSnapshot, previous: NotebookSnapshot): void {
    for (const cell of next.cells) {
      if (!state.project.hasNotebookCell(state.key, cell.id)) continue;
      const text = state.project.cellSource(state.key, cell.id).toString();
      if (text !== cell.source) {
        let start = 0; let end = 0; while (start < Math.min(text.length, cell.source.length) && text[start] === cell.source[start]) start++;
        while (end < Math.min(text.length, cell.source.length) - start && text[text.length - end - 1] === cell.source[cell.source.length - end - 1]) end++;
        state.project.applyCellTextChanges(state.key, cell.id, [{ offset: start, deleteCount: text.length - start - end, insertText: cell.source.slice(start, cell.source.length - end) }], REMOTE_ORIGIN);
      }
      if (!state.structural && JSON.stringify(state.project.notebookCellSnapshot(state.key, cell.id)?.metadata) !== JSON.stringify(cell.metadata)) state.project.setCellMetadata(state.key, cell.id, cell.metadata, REMOTE_ORIGIN);
      const current = state.project.notebookCellSnapshot(state.key, cell.id);
      if (JSON.stringify(current?.outputs) !== JSON.stringify(cell.outputs)) state.project.setCellOutputs(state.key, cell.id, cell.outputs, REMOTE_ORIGIN);
      if (JSON.stringify(current?.execution) !== JSON.stringify(cell.execution)) state.project.setCellExecution(state.key, cell.id, cell.execution, REMOTE_ORIGIN);
    }
    if (!state.structural && JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata)) state.project.setNotebookMetadata(state.key, next.metadata, REMOTE_ORIGIN);
  }
  private outbound(state: State): SharedNotebook {
    const next = state.project.notebookSnapshot(state.key); const metadata = notebookUserMetadata(next.metadata); delete metadata.pairNotebookNbformat;
    return { metadata, cells: next.cells.map((cell) => ({ id: cell.id, source: cell.source, cell_type: cell.kind === 2 ? 'code' : 'markdown', metadata: cell.metadata })) };
  }
  private stage(state: State, request: EditorTextIntentRequest): boolean {
    this.current(state); if (!request.cellId) return false;
    const baseline = request.baseline; let changes = [...(request.canonicalChanges ?? request.changes)]; const initial = state.initial.get(request.cellId);
    if (initial !== undefined && baseline !== initial) {
      let start = 0; let end = 0; while (start < Math.min(initial.length, request.result.length) && initial[start] === request.result[start]) start++;
      while (end < Math.min(initial.length, request.result.length) - start && initial[initial.length - end - 1] === request.result[request.result.length - end - 1]) end++;
      changes = rebaseInitialTextChanges(initial, baseline, [{ offset: start, deleteCount: initial.length - start - end, insertText: request.result.slice(start, request.result.length - end) }]);
    }
    state.initial.delete(request.cellId);
    if (!changes.some((change) => change.deleteCount || change.insertText)) return false;
    const text = state.doc.getMap<Y.Map<unknown>>('cells').get(request.cellId)?.get('source');
    if (!(text instanceof Y.Text)) throw new Error('The edited cell no longer exists.');
    const vector = Y.encodeStateVector(state.doc);
    state.doc.transact(() => { for (const change of [...changes].sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); } });
    const update = Y.encodeStateAsUpdate(state.doc, vector);
    const tail = state.intents.at(-1);
    // The merged Yjs update preserves character identities. A bounded diff
    // timing out only needs a net-text bookkeeping fallback, not another RPC.
    const merged = tail && tail !== state.activeIntent && tail.cellId === request.cellId && applyChanges(tail.baseline, tail.changes) === baseline
      ? changesBetween(tail.baseline, request.result) ?? [{ offset: 0, deleteCount: tail.baseline.length, insertText: request.result }] : undefined;
    if (tail && merged && tail.update) state.intents[state.intents.length - 1] = { ...tail, changes: merged, update: Buffer.from(Y.mergeUpdates([Buffer.from(tail.update, 'base64'), update])).toString('base64') };
    else state.intents.push({ actor: state.actor, sequence: ++state.sequence, cellId: request.cellId, baseline, changes, update: Buffer.from(update).toString('base64') });
    void this.send(state).catch((error) => this.report(error)); return false;
  }
  private send(state: State): Promise<void> {
    if (state.sending) return state.sending;
    const work = Promise.resolve().then(async () => {
      await state.ready; this.current(state);
      while (state.intents.length || state.structural) {
        if (!state.structural && state.intents[0]) state.activeIntent = state.intents[0]; else delete state.activeIntent;
        await this.journal(state); this.current(state);
        const intent = state.activeIntent; let snapshot: SharedNotebook | undefined;
        const structuralVersion = state.structural;
        // A structural clock can depend on earlier local text which has not
        // reached the server yet. Commit that causal closure atomically.
        const structuralIntents = !intent && state.structureUpdate ? state.intents.filter((pending) => pending.update) : [];
        const structureUpdate = state.structureUpdate && Buffer.from(Y.mergeUpdates([Buffer.from(state.structureUpdate, 'base64'),
          ...structuralIntents.map((pending) => Buffer.from(pending.update!, 'base64'))])).toString('base64');
        const wireIntent = intent?.update ? { ...intent, baseline: '', changes: [{ offset: 0, deleteCount: 0, insertText: '' }] } : intent;
        if (!intent) snapshot = this.outbound(state);
        try {
          const reply = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, actor: state.actor, epoch: state.epoch, compact: true, stateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64'), ...(intent ? { intent: wireIntent } : structureUpdate ? { update: structureUpdate } : { snapshot, snapshotStateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64') }) }); this.current(state);
          Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.revision = Math.max(state.revision, reply.revision); state.identity = reply.identity;
          if (intent) { state.acknowledgedSequence = Math.max(state.acknowledgedSequence, intent.sequence); state.intents.shift(); }
          else {
            // An edit coalesced while this request was in flight has a new
            // object identity; retain it even if it reused the tail sequence.
            state.intents = state.intents.filter((pending) => !structuralIntents.includes(pending));
            for (const pending of structuralIntents) state.acknowledgedSequence = Math.max(state.acknowledgedSequence, pending.sequence);
            if (state.structural === structuralVersion) { state.structural = 0; delete state.structureUpdate; }
          }
          this.applyCanonical(state); this.schedulePresence(); await this.journal(state);
        } catch (error) {
          if (error instanceof PersistentHttpError && error.status === 404) await this.retire(state.notebook, 'deleted');
          else if (error instanceof PersistentHttpError && [400, 403, 409, 413].includes(error.status)) { state.blocked = true; void this.conflict(state, error.status !== 409).catch((failure) => this.report(failure)); }
          throw error;
        }
      }
    });
    state.sending = work.finally(() => { delete state.sending; delete state.activeIntent; this.schedulePresence(); }); return state.sending;
  }
  async flush(notebook: vscode.NotebookDocument, capture = false): Promise<NotebookSyncReply | undefined> {
    return this.synchronize(notebook, capture, true);
  }
  async prepareExecution(notebook: vscode.NotebookDocument): Promise<NotebookSyncReply | undefined> {
    // Admission validates identity, cell ID, source hash and generation on the server.
    return this.synchronize(notebook, true, false);
  }
  private async synchronize(notebook: vscode.NotebookDocument, capture: boolean, refresh: boolean): Promise<NotebookSyncReply | undefined> {
    if (capture && notebook.isClosed) throw new Error('Cannot save a closed notebook.');
    const connection = this.connection(); if (!connection || notebook.uri.scheme !== 'pair-vps' || notebook.uri.authority !== connection.sessionId) return undefined;
    if (this.retired.has(notebook)) { if (capture) this.assertAvailable(notebook); return undefined; }
    if (notebook.isClosed || (notebook.notebookType && notebook.notebookType !== SESSION_NOTEBOOK_TYPE)) return undefined;
    this.ensureStream(); let state = this.states.get(notebook);
    if (state?.blocked) { await this.conflict(state); state = this.states.get(notebook); }
    if (!state) {
      state = { connection, notebook, key: notebook.uri.path.slice(1), file: this.journalFile(connection, notebook),
        doc: new Y.Doc(), project: new CollaborativeProject(), ids: new StableCellIdRegistry(), epoch: '', revision: 0, actor: randomUUID(), sequence: 0, acknowledgedSequence: 0, intents: [], ready: Promise.resolve(), structural: 0, closed: false, blocked: false,
        initial: new Map(notebook.getCells().map((cell) => [cell.metadata.id ?? cell.metadata.pairNotebookCellId, cell.document.getText()])), dirtyCells: new Set(), structureChanged: false, initialized: false };
      const observedState = state;
      state.doc.getMap<Y.Map<unknown>>('cells').observeDeep((events) => { for (const event of events) { const id = event.path[0]; if (typeof id === 'string') observedState.dirtyCells.add(id); else observedState.structureChanged = true; } });
      state.doc.getArray('order').observe(() => { observedState.structureChanged = true; });
      state.doc.getMap('notebook').observe(() => { observedState.structureChanged = true; });
      this.states.set(notebook, state); state.ready = this.initialize(state);
    }
    try { await state.ready; this.current(state); if (capture) await state.editor?.prepareWorkingCopy(false); await this.send(state); }
    catch (error) {
      if (error instanceof PersistentHttpError && error.status === 404) await this.retire(notebook, 'deleted');
      else if (error instanceof PersistentHttpError && error.status === 409) await this.conflict(state);
      else if (isPermanentConnectionError(error, 'file')) { state.blocked = true; }
      else if (!state.initialized && !state.closed) {
        // A rejected bootstrap promise must never poison all subsequent retries.
        state.editor?.dispose(); delete state.editor;
        state.project.removeAllListeners('update');
        state.ready = this.initialize(state); void state.ready.catch(() => undefined);
      }
      throw error;
    }
    if (!refresh) return { epoch: state.epoch, revision: state.revision, ...(state.identity ? { identity: state.identity } : {}), update: '', ...sharedNotebook(state.doc) };
    try {
      const reply = await connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: connection.sessionId, path: state.key, actor: state.actor, epoch: state.epoch, compact: true, stateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64') });
      this.current(state); Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.revision = Math.max(state.revision, reply.revision); state.identity = reply.identity; state.acknowledgedSequence = Math.max(state.acknowledgedSequence, reply.acknowledgedSequence ?? 0); await this.readSavedCells(state); this.applyCanonical(state, true);
      await state.editor?.prepareWorkingCopy(false); await this.journal(state);
      return { ...reply, revision: state.revision, ...sharedNotebook(state.doc) };
    } catch (error) {
      if (error instanceof PersistentHttpError && error.status === 404) await this.retire(notebook, 'deleted');
      else if (error instanceof PersistentHttpError && error.status === 409) await this.conflict(state);
      throw error;
    }
  }
}
