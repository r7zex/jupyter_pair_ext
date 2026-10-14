import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import { atomicWriteFile } from '../core/atomicFile';
import { CollaborativeProject, type NotebookSnapshot, type CellSnapshot, type TextChange } from '../core/crdt';
import { createSharedCursorPosition, encodeRelativeOffset, resolveRelativeOffset, resolveSharedCursorPosition } from '../core/cursorPosition';
import { lineLockMessage } from '../core/lineLock';
import { StableCellIdRegistry } from '../core/notebookIdentity';
import { normalizeNotebookMetadata, parseIpynb } from '../core/projectFiles';
import { REMOTE_ORIGIN } from '../core/types';
import type { PresenceState } from '../runtime/session';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply, type SharedNotebook } from '../vps/persistentNotebookCrdt';
import type { PersistentLiveEvent, PersistentPresence } from '../vps/persistentLive';
import { cellUserMetadata, hasLegacyNotebookMetadata, notebookUserMetadata } from './persistentNotebookMetadata';
import { PresenceRenderer, type PresenceSource } from './presence';
import { EditorSynchronizer, type EditorTextIntentRequest, type NotebookCellStateRenderer } from './sync';
import { rebaseInitialTextChanges } from './initialTextChanges';

interface Connection { sessionId: string; memberId: string; endpoint: string; client: PersistentClient }
interface Intent { actor: string; sequence: number; cellId: string; baseline: string; changes: TextChange[] }
interface State {
  connection: Connection; notebook: vscode.NotebookDocument; key: string; file: string; doc: Y.Doc; project: CollaborativeProject;
  ids: StableCellIdRegistry<vscode.NotebookCell>; epoch: string; revision: number; actor: string; sequence: number;
  intents: Intent[]; ready: Promise<void>; sending?: Promise<void>; editor?: EditorSynchronizer;
  journalTail?: Promise<void>;
  conflictPrompted?: boolean;
  savedCells?: Map<string, CellSnapshot>;
  structural: number; closed: boolean; blocked: boolean;
  initial: Map<string, string>;
}

/** VPS transport adapter for the EditorSynchronizer/EditorTextReplica used by a human host. */
export class PersistentNotebookSynchronizer implements vscode.Disposable {
  private readonly states = new Map<vscode.NotebookDocument, State>();
  private readonly presenceEvents = new EventEmitter();
  private presence: PersistentPresence[] = [];
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
  private lastWarning = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly connection: () => Connection | undefined, private readonly log: Pick<vscode.OutputChannel, 'appendLine'> = { appendLine: () => undefined }, private readonly invalidate: () => void = () => undefined, private readonly execution: (event: Extract<PersistentLiveEvent, { kind: 'execution' }>) => void = () => undefined, private readonly cellStateRenderer?: NotebookCellStateRenderer) {
    this.listeners = [vscode.workspace.onDidCloseNotebookDocument((notebook) => { const state = this.states.get(notebook); if (state) { if (state.intents.length || state.structural) void this.journal(state).catch((error) => this.report(error)).finally(() => this.closeState(state)); else this.closeState(state); } }),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedulePresence()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePresence()),
      vscode.window.onDidChangeWindowState(() => this.schedulePresence())];
    this.heartbeat = setInterval(() => { this.ensureStream(); this.schedulePresence(); }, 1000); this.heartbeat.unref();
  }
  dispose(): void { clearInterval(this.heartbeat); for (const listener of this.listeners) listener.dispose(); this.reset(); }
  reset(): void {
    this.stream?.dispose(); this.stream = undefined; this.streamConnection = undefined;
    if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    for (const state of [...this.states.values()]) this.closeState(state);
    this.renderer?.dispose(); this.renderer = undefined; this.presence = []; this.presenceEvents.emit('presence');
    this.lastPresence = undefined;
  }
  private closeState(state: State): void { state.closed = true; state.editor?.dispose(); state.project.destroy(); state.doc.destroy(); this.states.delete(state.notebook); this.schedulePresence(); }
  private current(state: State): void {
    if (state.closed || this.connection() !== state.connection) throw new Error('Notebook synchronization connection changed.');
    if (state.blocked) throw new Error('Offline notebook replica is preserved; reload the notebook after reviewing its conflict.');
  }
  private report(error: unknown): void {
    this.log.appendLine(`[error] Persistent notebook synchronization: ${error instanceof Error ? error.message : 'Operation failed.'}`);
    if (Date.now() - this.lastWarning > 10_000) { this.lastWarning = Date.now(); void vscode.window.showWarningMessage(`Pair Notebook VPS: ${error instanceof Error ? error.message : 'Synchronization failed.'}`); }
  }
  private async conflict(state: State): Promise<void> {
    if (state.conflictPrompted || state.closed) return; state.conflictPrompted = true; state.blocked = true;
    await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 });
    await atomicWriteFile(`${state.file}.conflict-${randomUUID()}.json`, JSON.stringify({ epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64'), intents: state.intents,
      displayed: state.notebook.getCells().map((cell) => ({ id: state.ids.knownId(cell), source: cell.document.getText(), metadata: cell.metadata })) }));
    const answer = await vscode.window.showWarningMessage('This notebook was replaced or its privacy changed. Local edits were archived. Reload the server version?', 'Preserve replica and reload');
    if (answer !== 'Preserve replica and reload' || state.closed || this.connection() !== state.connection) return;
    try { await rename(state.file, `${state.file}.conflict-journal-${randomUUID()}.json`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.closeState(state); await this.flush(state.notebook);
  }
  private ensureStream(): void {
    const connection = this.connection(); if (!connection || this.reconnect || this.streamConnection === connection) return;
    if (this.streamConnection) this.reset(); this.streamConnection = connection;
    try { this.stream = connection.client.subscribe(connection.sessionId, (event) => this.receive(event), () => {
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
        resolvePresenceCursor: (presence) => { const state = [...this.states.values()].find((item) => item.key === presence.activeFile); const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(presence.activeNotebookCellId ?? '')?.get('source'); return text instanceof Y.Text && presence.cursor ? resolveSharedCursorPosition(text, presence.cursor) : undefined; } };
      this.renderer = new PresenceRenderer(source);
    }
  }
  private receive(event: PersistentLiveEvent): void {
    if (event.kind === 'execution') { this.execution(event); return; }
    if (event.kind === 'presence') { this.presence = event.states; this.presenceEvents.emit('presence'); return; }
    if (event.kind === 'ready' || event.kind === 'invalidate') {
      this.invalidate(); for (const state of this.states.values()) void this.flush(state.notebook).catch((error) => this.report(error)); return;
    }
    for (const state of this.states.values()) if (state.key === event.path && state.epoch === event.epoch && !state.closed && !state.blocked) {
      Y.applyUpdate(state.doc, Buffer.from(event.update, 'base64')); state.revision = Math.max(state.revision, event.revision); this.applyCanonical(state);
    }
  }
  private presenceOffset(presence: PresenceState): number | undefined {
    const state = [...this.states.values()].find((item) => item.key === presence.activeFile);
    const text = state?.doc.getMap<Y.Map<unknown>>('cells').get(presence.activeNotebookCellId ?? '')?.get('source');
    return resolveRelativeOffset(text instanceof Y.Text ? text : undefined, presence.activeLineAnchor, undefined);
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
    if ([...this.states.values()].some((state) => state.intents.length || state.sending)) return;
    const editor = vscode.window.activeTextEditor;
    const state = editor && [...this.states.values()].find((item) => item.notebook.getCells().some((cell) => cell.document === editor.document));
    const cell = state && editor && state.notebook.getCells().find((item) => item.document === editor.document);
    let fields: Record<string, unknown> = {};
    if (state && cell && state.editor && state.epoch && !state.blocked) {
      const cellId = state.ids.knownId(cell); const offset = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(new vscode.Position(editor!.selection.active.line, 0)));
      const text = state.doc.getMap<Y.Map<unknown>>('cells').get(cellId ?? '')?.get('source');
      if (text instanceof Y.Text && offset !== undefined && text.toString() === state.project.cellSource(state.key, cellId!).toString()) {
        const anchor = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(editor!.selection.anchor));
        const active = state.editor.canonicalOffsetForDocument(cell.document, cell.document.offsetAt(editor!.selection.active));
        fields = { path: state.key, epoch: state.epoch, cellId, activeLineAnchor: encodeRelativeOffset(text, offset), ...(anchor !== undefined && active !== undefined ? { cursor: createSharedCursorPosition(text, anchor, active) } : {}) };
      }
      else if (this.lastPresence?.path === state.key && this.lastPresence.cellId === cellId && this.lastPresence.epoch === state.epoch) fields = this.lastPresence;
    }
    const reply = await connection.client.call<{ states: PersistentPresence[] }>('presence', { sessionId: connection.sessionId, ...fields });
    if (this.connection() === connection) { this.lastPresence = fields; this.presence = reply.states; this.presenceEvents.emit('presence'); }
  }
  private async journal(state: State): Promise<void> {
    const write = (state.journalTail ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 }); this.current(state);
      await atomicWriteFile(state.file, JSON.stringify({ epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64'), actor: state.actor, sequence: state.sequence, intents: state.intents, ...(state.structural ? { snapshot: this.outbound(state) } : {}) }));
    });
    state.journalTail = write; return write;
  }
  private async initialize(state: State): Promise<void> {
    let saved: { epoch: string; update: string; actor?: string; sequence?: number; intents?: Intent[]; snapshot?: SharedNotebook } | undefined;
    try { saved = JSON.parse(await readFile(state.file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.current(state);
    const reply = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key }); this.current(state);
    Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.epoch = reply.epoch; state.revision = reply.revision;
    const vector = Y.encodeStateVector(state.doc);
    if (saved) {
      if (saved.epoch !== reply.epoch) { await atomicWriteFile(`${state.file}.conflict-${randomUUID()}.json`, JSON.stringify(saved)); state.blocked = true; throw new PersistentHttpError(409); }
      if (saved.actor && /^[A-Za-z0-9_-]{32,64}$/.test(saved.actor) && Number.isSafeInteger(saved.sequence)) { state.actor = saved.actor; state.sequence = saved.sequence!; state.intents = saved.intents ?? []; }
      Y.applyUpdate(state.doc, Buffer.from(saved.update, 'base64'));
    }
    let shared = sharedNotebook(state.doc);
    await mkdir(path.dirname(state.file), { recursive: true, mode: 0o700 });
    if (hasLegacyNotebookMetadata(shared.metadata)) await atomicWriteFile(`${state.file}.legacy-metadata-${randomUUID()}.json`, JSON.stringify(saved ?? { epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString('base64') }));
    shared = { ...shared, metadata: notebookUserMetadata(shared.metadata), cells: shared.cells.map((cell) => ({ ...cell, metadata: cellUserMetadata(cell.metadata, typeof cell.metadata.id === 'string' && !!cell.metadata.metadata) })) };
    editSharedNotebook(state.doc, shared);
    const cleaned = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, epoch: state.epoch, update: Buffer.from(Y.encodeStateAsUpdate(state.doc, vector)).toString('base64') }); this.current(state);
    Y.applyUpdate(state.doc, Buffer.from(cleaned.update, 'base64')); state.revision = cleaned.revision;
    await this.readSavedCells(state); state.project.ensureNotebook(state.key, this.projectSnapshot(state));
    if (saved?.snapshot) { state.project.reconcileNotebook(state.key, { metadata: normalizeNotebookMetadata(saved.snapshot.metadata), cells: saved.snapshot.cells.map((cell) => ({ id: cell.id, source: cell.source, kind: cell.cell_type === 'code' ? 2 : 1, language: cell.cell_type === 'code' ? 'python' : 'markdown', metadata: cell.metadata, outputs: [] })) }, REMOTE_ORIGIN); state.structural = 1; }
    state.notebook.getCells().forEach((cell) => { const id = typeof cell.metadata.id === 'string' ? cell.metadata.id : cell.metadata.pairNotebookCellId; if (id) state.ids.seed(cell, undefined, id); });
    state.project.on('update', (event) => { if (event.origin !== REMOTE_ORIGIN && event.scope?.type !== 'cellText' && event.scope?.type !== 'cellState') { state.structural++; void this.send(state).catch((error) => this.report(error)); } });
    state.editor = new EditorSynchronizer(state.project, '', this.log, state.ids, this.cellStateRenderer,
      (request) => this.stage(state, request), (key, cellId, changes, source) => lineLockMessage(this.presence.filter((item) => !item.readOnly && item.epoch === state.epoch), state.connection.memberId, key, cellId, changes, source, (presence) => this.presenceOffset(presence)),
      (uri) => uri.toString() === state.notebook.uri.toString() ? state.key : undefined);
    await state.editor.whenNotebookReady(state.notebook); state.initial.clear(); await this.journal(state); this.schedulePresence();
  }
  private projectSnapshot(state: State): NotebookSnapshot {
    const shared = sharedNotebook(state.doc);
    return { metadata: normalizeNotebookMetadata(notebookUserMetadata(shared.metadata)), cells: shared.cells.map((cell) => {
      const previous = state.project.has(state.key) ? state.project.notebookCellSnapshot(state.key, cell.id) : undefined;
      const local = state.notebook.getCells().find((candidate) => candidate.metadata.id === cell.id || candidate.metadata.pairNotebookCellId === cell.id);
      const saved = state.savedCells?.get(cell.id); const managing = !!local && this.cellStateRenderer?.isManagingCellState?.(local);
      const outputs = saved && !managing ? saved.source === cell.source ? saved.outputs : [] : previous?.outputs ?? local?.outputs.map((output) => ({ metadata: output.metadata, items: output.items.map((item) => ({ mime: item.mime, dataBase64: Buffer.from(item.data).toString('base64') })) })) ?? [];
      const execution = managing || (previous?.execution?.executionOrder === saved?.execution?.executionOrder && JSON.stringify(previous?.outputs) === JSON.stringify(outputs)) ? previous?.execution : saved?.source === cell.source ? saved.execution : undefined;
      return { id: cell.id, kind: cell.cell_type === 'code' ? 2 : 1, language: cell.cell_type === 'code' ? 'python' : 'markdown', source: cell.source, metadata: cell.metadata,
        outputs, execution };
    }) };
  }
  private async readSavedCells(state: State): Promise<void> {
    const file = await state.connection.client.call<{ content: string }>('read', { sessionId: state.connection.sessionId, path: state.key }); this.current(state);
    if (typeof file.content === 'string') state.savedCells = new Map(parseIpynb(Buffer.from(file.content, 'base64').toString('utf8')).cells.map((cell) => [cell.id, cell]));
  }
  private applyCanonical(state: State): void {
    if (!state.editor) return; const next = this.projectSnapshot(state); const previous = state.project.notebookSnapshot(state.key);
    if (!state.structural && (previous.cells.length !== next.cells.length || previous.cells.some((cell, index) => cell.id !== next.cells[index]?.id || cell.kind !== next.cells[index]?.kind))) { state.project.reconcileNotebook(state.key, next, REMOTE_ORIGIN); return; }
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
    const baseline = request.baseline; let changes = [...request.changes]; const initial = state.initial.get(request.cellId);
    if (initial !== undefined && baseline !== initial) {
      let start = 0; let end = 0; while (start < Math.min(initial.length, request.result.length) && initial[start] === request.result[start]) start++;
      while (end < Math.min(initial.length, request.result.length) - start && initial[initial.length - end - 1] === request.result[request.result.length - end - 1]) end++;
      changes = rebaseInitialTextChanges(initial, baseline, [{ offset: start, deleteCount: initial.length - start - end, insertText: request.result.slice(start, request.result.length - end) }]);
    }
    state.initial.delete(request.cellId);
    if (!changes.some((change) => change.deleteCount || change.insertText)) return true;
    state.intents.push({ actor: state.actor, sequence: ++state.sequence, cellId: request.cellId, baseline, changes });
    void this.send(state).catch((error) => this.report(error)); return true;
  }
  private send(state: State): Promise<void> {
    if (state.sending) return state.sending;
    const work = Promise.resolve().then(async () => {
      await state.ready; this.current(state);
      while (state.intents.length || state.structural) {
        await this.journal(state); this.current(state);
        const intent = state.intents[0]; let snapshot: SharedNotebook | undefined;
        const structuralVersion = state.structural;
        if (!intent) snapshot = this.outbound(state);
        try {
          const reply = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, epoch: state.epoch, compact: true, stateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64'), ...(intent ? { intent } : { snapshot, snapshotStateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64') }) }); this.current(state);
          Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.revision = Math.max(state.revision, reply.revision);
          if (intent) state.intents.shift(); else if (state.structural === structuralVersion) state.structural = 0;
          this.applyCanonical(state); this.schedulePresence(); await this.journal(state);
        } catch (error) {
          if (error instanceof PersistentHttpError && error.status === 423 && intent) {
            await atomicWriteFile(`${state.file}.occupied-line-${randomUUID()}.json`, JSON.stringify({ epoch: state.epoch, intent }));
            state.intents.shift(); state.sequence = intent.sequence - 1;
            state.intents = state.intents.map((item) => ({ ...item, sequence: ++state.sequence }));
            const latest = await state.connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: state.connection.sessionId, path: state.key, epoch: state.epoch });
            this.current(state); Y.applyUpdate(state.doc, Buffer.from(latest.update, 'base64')); this.applyCanonical(state); state.editor?.rejectPendingText(state.key, intent.cellId); await this.journal(state);
            this.report(error); continue;
          }
          if (error instanceof PersistentHttpError && error.status === 409) { await atomicWriteFile(`${state.file}.conflict-${randomUUID()}.json`, JSON.stringify({ epoch: state.epoch, intents: state.intents, snapshot })); state.blocked = true; void this.conflict(state).catch((failure) => this.report(failure)); }
          throw error;
        }
      }
    });
    state.sending = work.finally(() => { delete state.sending; this.schedulePresence(); }); return state.sending;
  }
  async flush(notebook: vscode.NotebookDocument, capture = false): Promise<NotebookSyncReply | undefined> {
    if (capture && notebook.isClosed) throw new Error('Cannot save a closed notebook.');
    const connection = this.connection(); if (!connection || notebook.uri.scheme !== 'pair-vps' || notebook.uri.authority !== connection.sessionId) return undefined;
    this.ensureStream(); let state = this.states.get(notebook);
    if (!state) {
      state = { connection, notebook, key: notebook.uri.path.slice(1), file: path.join(this.context.globalStorageUri.fsPath, 'persistent-replicas', createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId, notebook.uri.path])).digest('hex') + '.json'),
        doc: new Y.Doc(), project: new CollaborativeProject(), ids: new StableCellIdRegistry(), epoch: '', revision: 0, actor: randomUUID(), sequence: 0, intents: [], ready: Promise.resolve(), structural: 0, closed: false, blocked: false,
        initial: new Map(notebook.getCells().map((cell) => [cell.metadata.id ?? cell.metadata.pairNotebookCellId, cell.document.getText()])) };
      this.states.set(notebook, state); state.ready = this.initialize(state);
    }
    try { await state.ready; this.current(state); await this.send(state); }
    catch (error) { if (error instanceof PersistentHttpError && error.status === 409) await this.conflict(state); throw error; }
    try {
      const reply = await connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: connection.sessionId, path: state.key, epoch: state.epoch, compact: true, stateVector: Buffer.from(Y.encodeStateVector(state.doc)).toString('base64') });
      this.current(state); Y.applyUpdate(state.doc, Buffer.from(reply.update, 'base64')); state.revision = Math.max(state.revision, reply.revision); await this.readSavedCells(state); this.applyCanonical(state);
      await state.editor?.prepareWorkingCopy(); await this.journal(state);
      return { ...reply, revision: state.revision, ...sharedNotebook(state.doc) };
    } catch (error) { if (error instanceof PersistentHttpError && error.status === 409) await this.conflict(state); throw error; }
  }
}
