import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import { atomicWriteFile } from '../core/atomicFile';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply, type SharedNotebook } from '../vps/persistentNotebookCrdt';
interface Connection { sessionId: string; memberId: string; endpoint: string; client: PersistentClient }
interface State { doc: Y.Doc; epoch: string; file: string; ids: WeakMap<vscode.NotebookCell, string>; pending: Promise<unknown>; applying: boolean; revision: number; closed: boolean; blocked: boolean; initialCells: vscode.NotebookCell[]; initialSources: string[]; pendingSnapshot?: SharedNotebook; pendingCells?: vscode.NotebookCell[] }

/** Each editor replica retains its Yjs state before HTTP submission; replay is idempotent. */
export class PersistentNotebookSynchronizer implements vscode.Disposable {
  private readonly states = new Map<vscode.NotebookDocument, State>();
  private readonly listeners: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext, private readonly connection: () => Connection | undefined) {
    this.listeners = [vscode.workspace.onDidChangeNotebookDocument((event) => {
      const state = this.states.get(event.notebook);
      if ((!state || !state.applying) && (event.contentChanges.length || event.cellChanges.some((change) => change.document || change.metadata))) void this.flush(event.notebook, true).catch(() => undefined);
    }), vscode.workspace.onDidCloseNotebookDocument((notebook) => { const state = this.states.get(notebook); if (state) { state.closed = true; state.doc.destroy(); this.states.delete(notebook); } })];
  }
  dispose(): void { for (const listener of this.listeners) listener.dispose(); this.reset(); }
  reset(): void { for (const state of this.states.values()) { state.closed = true; state.doc.destroy(); } this.states.clear(); }
  private displayed(notebook: vscode.NotebookDocument, state: State): SharedNotebook {
    const metadata = notebook.metadata.custom?.metadata ?? notebook.metadata;
    return { metadata, cells: notebook.getCells().map((cell) => {
      const id = state.ids.get(cell) ?? cell.metadata.pairNotebookCellId ?? randomUUID(); state.ids.set(cell, id);
      return { id, cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown', source: cell.document.getText(), metadata: cell.metadata.custom?.metadata ?? cell.metadata };
    }) };
  }
  async flush(notebook: vscode.NotebookDocument, capture = false): Promise<NotebookSyncReply | undefined> {
    const connection = this.connection();
    if (!connection || notebook.uri.scheme !== 'pair-vps' || notebook.uri.authority !== connection.sessionId) return undefined;
    let state = this.states.get(notebook);
    if (!state) {
      state = { doc: new Y.Doc(), epoch: '', ids: new WeakMap(), file: path.join(this.context.globalStorageUri.fsPath, 'persistent-replicas', createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId, notebook.uri.path])).digest('hex') + '.json'), pending: Promise.resolve(), applying: false, revision: 0, closed: false, blocked: false, initialCells: notebook.getCells(), initialSources: notebook.getCells().map((cell) => cell.document.getText()) };
      this.states.set(notebook, state);
    }
    const original = state;
    if (original.blocked) throw new Error('Notebook sync conflict is awaiting an explicit reload; offline edits remain preserved.');
    const captured = capture && !!original.epoch;
    if (captured) editSharedNotebook(original.doc, this.displayed(notebook, original));
    else if (capture) { original.pendingSnapshot = this.displayed(notebook, original); original.pendingCells = notebook.getCells(); }
    const current = (allowConflict = false): void => { if (this.connection() !== connection || original.closed || this.states.get(notebook) !== original) throw new Error('Notebook synchronization connection changed.'); if (original.blocked && !allowConflict) throw new Error('Notebook sync conflict is awaiting an explicit reload.'); };
    const work = original.pending.catch(() => undefined).then(async () => {
      current();
      if (!original.epoch) {
        try {
          const saved = JSON.parse(await readFile(original.file, 'utf8')) as { epoch: string; update: string };
          current(); Y.applyUpdate(original.doc, Buffer.from(saved.update, 'base64')); original.epoch = saved.epoch;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const reply = await connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: connection.sessionId, path: notebook.uri.path.slice(1), ...(original.epoch ? { epoch: original.epoch } : {}) });
        current(); Y.applyUpdate(original.doc, Buffer.from(reply.update, 'base64')); original.epoch = reply.epoch;
        if (original.pendingSnapshot && (reply.cells.length !== original.initialSources.length || reply.cells.some((cell, index) => cell.source !== original.initialSources[index]))) {
          await mkdir(path.dirname(original.file), { recursive: true, mode: 0o700 }); current();
          await atomicWriteFile(`${original.file}.initial-conflict-${randomUUID()}.json`, JSON.stringify(original.pendingSnapshot));
          throw new PersistentHttpError(409);
        }
        original.initialCells.forEach((cell, index) => { const id = reply.cells[index]?.id; if (id) original.ids.set(cell, id); });
        if (original.pendingSnapshot) {
          const pending = original.pendingSnapshot;
          pending.cells.forEach((cell, index) => { const document = original.pendingCells?.[index]; if (document) cell.id = original.ids.get(document) ?? cell.id; });
          editSharedNotebook(original.doc, pending); delete original.pendingSnapshot; delete original.pendingCells;
        }
      }
      if (capture && !captured) editSharedNotebook(original.doc, this.displayed(notebook, original));
      await mkdir(path.dirname(original.file), { recursive: true, mode: 0o700 }); current();
      await atomicWriteFile(original.file, JSON.stringify({ epoch: original.epoch, update: Buffer.from(Y.encodeStateAsUpdate(original.doc)).toString('base64') }));
      current();
      const reply = await connection.client.call<NotebookSyncReply>('notebookSync', { sessionId: connection.sessionId, path: notebook.uri.path.slice(1), epoch: original.epoch,
        update: Buffer.from(Y.encodeStateAsUpdate(original.doc)).toString('base64'), stateVector: Buffer.from(Y.encodeStateVector(original.doc)).toString('base64') });
      current(); Y.applyUpdate(original.doc, Buffer.from(reply.update, 'base64')); original.revision = reply.revision;
      await atomicWriteFile(original.file, JSON.stringify({ epoch: original.epoch, update: Buffer.from(Y.encodeStateAsUpdate(original.doc)).toString('base64') })); current();
      const merged = sharedNotebook(original.doc); const cells = notebook.getCells(); const edit = new vscode.WorkspaceEdit(); const notebookEdits: vscode.NotebookEdit[] = [];
      original.applying = true;
      try {
        const sameOrder = cells.length === merged.cells.length && cells.every((cell, index) => original.ids.get(cell) === merged.cells[index]?.id);
        if (sameOrder) {
          cells.forEach((cell, index) => { const shared = merged.cells[index]!;
            if (JSON.stringify(cell.metadata.custom?.metadata ?? cell.metadata) !== JSON.stringify(shared.metadata)) notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(index, { custom: { metadata: shared.metadata }, pairNotebookCellId: shared.id }));
            const source = shared.source; if (source !== cell.document.getText()) edit.replace(cell.document.uri, new vscode.Range(cell.document.positionAt(0), cell.document.positionAt(cell.document.getText().length)), source); });
        } else {
          const data = merged.cells.map((cell) => { const value = new vscode.NotebookCellData(cell.cell_type === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup, cell.source, cell.cell_type === 'code' ? 'python' : 'markdown'); value.metadata = { custom: { metadata: cell.metadata }, pairNotebookCellId: cell.id }; return value; });
          notebookEdits.push(vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, notebook.cellCount), data));
        }
        if (notebookEdits.length) edit.set(notebook.uri, notebookEdits);
        current(); if (edit.size && !await vscode.workspace.applyEdit(edit)) throw new Error('Could not apply shared notebook edits.'); current();
        notebook.getCells().forEach((cell, index) => { const id = merged.cells[index]?.id; if (id) original.ids.set(cell, id); });
      } finally { original.applying = false; }
      return { ...reply, ...merged };
    });
    const protectedWork = work.catch(async (error: unknown) => {
      current(true);
      if (error instanceof PersistentHttpError && error.status === 409) {
        original.blocked = true;
        const answer = await vscode.window.showWarningMessage('This notebook was replaced or its privacy changed. Keep the offline replica separately and reload the server version?', 'Preserve replica and reload');
        current(true);
        if (answer === 'Preserve replica and reload') {
          const archive = `${original.file}.conflict-${randomUUID()}.json`;
          try { await rename(original.file, archive); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicWriteFile(archive, JSON.stringify({ epoch: original.epoch, update: Buffer.from(Y.encodeStateAsUpdate(original.doc)).toString('base64'), pending: original.pendingSnapshot })); }
          current(true);
          original.closed = true; original.doc.destroy(); this.states.delete(notebook);
          await vscode.window.showInformationMessage('Offline notebook edits were preserved in the local replica archive. The next sync reloads the server version.');
        }
      }
      throw error;
    });
    original.pending = protectedWork; return protectedWork;
  }
}
