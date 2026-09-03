import path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import {
  CellExecutionSnapshot,
  CellSnapshot,
  CollaborativeProject,
  MAX_CELL_OUTPUT_JSON_BYTES,
  MAX_CELL_OUTPUTS,
  MAX_NOTEBOOK_CELLS,
  MAX_OUTPUT_ITEMS_PER_CELL,
  NotebookSnapshot,
  OutputSnapshot,
  ProjectUpdate,
  TextChange,
} from '../core/crdt';
import {
  StableCellIdRegistry,
  matchInitialCellIds,
  metadataCellId,
  minimalNotebookSplice,
} from '../core/notebookIdentity';
import { safeRelativePath } from '../core/persistence';
import { classifyFile, normalizeNotebookMetadata, shouldTrackProjectPath } from '../core/projectFiles';
import { LOCAL_EDITOR_ORIGIN, REMOTE_ORIGIN } from '../core/types';

export class EditorSynchronizer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly applyingText = new Set<string>();
  private readonly applyingNotebooks = new Set<string>();
  private readonly textObservers = new Map<string, (event: Y.YTextEvent) => void>();
  private readonly textApplyQueues = new Map<string, Promise<void>>();
  private readonly notebookApplyQueues = new Map<string, Promise<void>>();
  private readonly pendingNotebookCellStates = new Map<string, Set<string>>();
  private readonly notebookCellStateTimers = new Map<string, NodeJS.Timeout>();
  private readonly notebookBindings = new WeakMap<vscode.NotebookDocument, Promise<void>>();
  private readonly boundNotebooks = new WeakSet<vscode.NotebookDocument>();
  private lastRejectedEditorWarningAt = 0;

  public constructor(
    private readonly project: CollaborativeProject,
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly cellIds = new StableCellIdRegistry<vscode.NotebookCell>(),
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.bindTextDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onTextChanged(event)),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => {
        void this.whenNotebookReady(notebook).catch((error) => {
          this.log.appendLine(`[error] Failed to bind notebook ${notebook.uri.fsPath}: ${formatError(error)}`);
        });
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => this.onNotebookChanged(event)),
    );
    this.project.on('update', this.onProjectUpdate);
    this.project.on('documentRenamed', this.onDocumentRenamed);
    this.project.on('documentDeleted', this.onDocumentDeleted);
    for (const document of vscode.workspace.textDocuments) this.bindTextDocument(document);
    for (const notebook of vscode.workspace.notebookDocuments) {
      void this.whenNotebookReady(notebook).catch((error) => {
        this.log.appendLine(`[error] Failed to bind notebook ${notebook.uri.fsPath}: ${formatError(error)}`);
      });
    }
  }

  public dispose(): void {
    this.project.off('update', this.onProjectUpdate);
    this.project.off('documentRenamed', this.onDocumentRenamed);
    this.project.off('documentDeleted', this.onDocumentDeleted);
    for (const [key, observer] of this.textObservers) this.project.text(key).unobserve(observer);
    this.textObservers.clear();
    for (const timer of this.notebookCellStateTimers.values()) clearTimeout(timer);
    this.notebookCellStateTimers.clear();
    this.pendingNotebookCellStates.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Waits until stable CRDT cell IDs are attached before execution starts. */
  public whenNotebookReady(notebook: vscode.NotebookDocument): Promise<void> {
    if (this.boundNotebooks.has(notebook)) return Promise.resolve();
    const active = this.notebookBindings.get(notebook);
    if (active) return active;
    const binding = this.bindNotebook(notebook).then(() => {
      this.boundNotebooks.add(notebook);
    }).finally(() => {
      if (this.notebookBindings.get(notebook) === binding) this.notebookBindings.delete(notebook);
    });
    this.notebookBindings.set(notebook, binding);
    return binding;
  }

  /**
   * Persists open documents through VS Code, never through an external fs write.
   * Closed documents return false so StorageAdapter can use its atomic writer.
   */
  public async persistWorkingCopy(relativePath: string, bytes: Uint8Array): Promise<boolean> {
    void bytes;
    return this.persistOpenWorkingCopy(relativePath, false);
  }

  /** Materializes every open document before local execution needs a physical filesystem snapshot. */
  public async prepareWorkingCopy(): Promise<void> {
    const keys = new Set<string>();
    for (const notebook of vscode.workspace.notebookDocuments) {
      const key = this.keyForUri(notebook.uri);
      if (key) keys.add(key);
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'vscode-notebook-cell') continue;
      const key = this.keyForUri(document.uri);
      if (key) keys.add(key);
    }
    for (const key of keys) await this.persistOpenWorkingCopy(key, true);
  }

  private async persistOpenWorkingCopy(relativePath: string, forceSave: boolean): Promise<boolean> {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => this.keyForUri(candidate.uri) === relativePath);
    if (notebook) {
      await this.whenNotebookReady(notebook);
      await (this.notebookApplyQueues.get(relativePath) ?? Promise.resolve());
      await this.applyNotebookSnapshot(notebook, this.project.notebookSnapshot(relativePath));
      await this.ensureStableCellIds(notebook);
      if (forceSave && !await notebook.save()) {
        throw new Error(`VS Code could not save ${relativePath}.`);
      }
      return true;
    }
    const document = this.project.kindOf(relativePath) === 'text'
      ? vscode.workspace.textDocuments.find((candidate) =>
        candidate.uri.scheme !== 'vscode-notebook-cell' && this.keyForUri(candidate.uri) === relativePath)
      : undefined;
    if (document) {
      await (this.textApplyQueues.get(relativePath) ?? Promise.resolve());
      await this.applyText(document, this.project.text(relativePath).toString());
      if (forceSave && !await document.save()) {
        throw new Error(`VS Code could not save ${relativePath}.`);
      }
      return true;
    }
    return false;
  }

  private readonly onProjectUpdate = (event: ProjectUpdate): void => {
    if (event.origin !== REMOTE_ORIGIN || event.kind !== 'notebook') return;
    this.enqueueNotebookApply(event.key, async () => {
      const notebook = vscode.workspace.notebookDocuments.find((candidate) => this.keyForUri(candidate.uri) === event.key);
      if (!notebook) return;
      if (event.scope?.type === 'cellText' && event.scope.cellId) {
        const cellId = event.scope.cellId;
        const open = notebook.getCells().find((cell) =>
          this.cellIds.knownId(cell, metadataCellId(cell.metadata)) === cellId);
        if (!open) return;
        // Only the edited cell's source is needed; serializing the whole
        // notebook (JSON-parsing every output) on each remote keystroke would
        // add avoidable latency to the editor hot path.
        let source: string;
        try {
          source = this.project.cellSource(event.key, cellId).toString();
        } catch {
          return;
        }
        await this.applyText(open.document, source);
        return;
      }
      if ((event.scope?.type === 'cellOutputs' || event.scope?.type === 'cellExecution') && event.scope.cellId) {
        this.scheduleNotebookCellStateApply(event.key, event.scope.cellId);
        return;
      }
      if (event.scope?.type === 'cellMetadata' && event.scope.cellId) {
        await this.applyNotebookCellMetadata(notebook, event.key, event.scope.cellId);
        return;
      }
      if (event.scope?.type === 'notebookMetadata') {
        await this.applyNotebookMetadata(notebook, event.key);
        return;
      }
      await this.applyNotebookSnapshot(notebook, this.project.notebookSnapshot(event.key));
    });
  };

  private enqueueNotebookApply(key: string, task: () => Promise<void>): void {
    const previous = this.notebookApplyQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task).catch((error) => {
      this.log.appendLine(`[error] Failed to apply queued remote notebook update for ${key}: ${formatError(error)}`);
    });
    this.notebookApplyQueues.set(key, next);
    void next.finally(() => {
      if (this.notebookApplyQueues.get(key) === next) this.notebookApplyQueues.delete(key);
    });
  }

  /** Output events can arrive many times per kernel message. Render only the newest cell state. */
  private scheduleNotebookCellStateApply(key: string, cellId: string): void {
    const cells = this.pendingNotebookCellStates.get(key) ?? new Set<string>();
    cells.add(cellId);
    this.pendingNotebookCellStates.set(key, cells);
    if (this.notebookCellStateTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.notebookCellStateTimers.delete(key);
      const pending = this.pendingNotebookCellStates.get(key);
      this.pendingNotebookCellStates.delete(key);
      if (!pending?.size) return;
      this.enqueueNotebookApply(key, async () => {
        const notebook = vscode.workspace.notebookDocuments.find((candidate) => this.keyForUri(candidate.uri) === key);
        if (!notebook) return;
        for (const pendingCellId of pending) await this.applyNotebookCellState(notebook, key, pendingCellId);
      });
    }, 75);
    this.notebookCellStateTimers.set(key, timer);
  }

  private async applyNotebookCellState(notebook: vscode.NotebookDocument, key: string, cellId: string): Promise<void> {
    let snapshot: NotebookSnapshot;
    try {
      snapshot = this.project.notebookSnapshot(key);
    } catch {
      return;
    }
    const index = snapshot.cells.findIndex((cell) => cell.id === cellId);
    if (index < 0 || index >= notebook.cellCount) return;
    const target = snapshot.cells[index]!;
    const current = notebook.cellAt(index);
    if (this.cellIds.knownId(current, metadataCellId(current.metadata)) !== cellId) return;
    const outputsChanged = JSON.stringify(outputsFromCell(current)) !== JSON.stringify(target.outputs);
    const executionChanged = JSON.stringify(executionFromCell(current)) !== JSON.stringify(target.execution);
    if (!outputsChanged && !executionChanged) return;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const edit = new vscode.WorkspaceEdit();
      // VS Code exposes no direct NotebookEdit for outputs/execution. Replacing
      // this one cell is the narrowest supported mutation and keeps every other
      // cell, its editor, and its viewport state intact.
      edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(
        new vscode.NotebookRange(index, index + 1),
        [toNotebookCellData({ ...target, source: current.document.getText() })],
      )]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook cell output update.');
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private async applyNotebookCellMetadata(notebook: vscode.NotebookDocument, key: string, cellId: string): Promise<void> {
    const snapshot = this.project.notebookSnapshot(key);
    const index = snapshot.cells.findIndex((cell) => cell.id === cellId);
    if (index < 0 || index >= notebook.cellCount) return;
    const current = notebook.cellAt(index);
    if (this.cellIds.knownId(current, metadataCellId(current.metadata)) !== cellId) return;
    const target = snapshot.cells[index]!;
    const metadata = { ...target.metadata, pairNotebookCellId: target.id };
    if (JSON.stringify(current.metadata) === JSON.stringify(metadata)) return;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(index, metadata)]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook cell metadata update.');
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private async applyNotebookMetadata(notebook: vscode.NotebookDocument, key: string): Promise<void> {
    const metadata = this.project.notebookSnapshot(key).metadata;
    if (JSON.stringify(normalizeNotebookMetadata(notebook.metadata)) === JSON.stringify(metadata)) return;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(
        toVscodeNotebookMetadata(metadata, notebook.metadata),
      )]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook metadata update.');
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private enqueueTextApply(key: string, task: () => Promise<void>): void {
    const previous = this.textApplyQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task).catch((error) => {
      this.log.appendLine(`[error] Failed to apply queued remote text update for ${key}: ${formatError(error)}`);
    });
    this.textApplyQueues.set(key, next);
    void next.finally(() => {
      if (this.textApplyQueues.get(key) === next) this.textApplyQueues.delete(key);
    });
  }

  private readonly onDocumentRenamed = (from: string, to: string, kind: string): void => {
    if (kind !== 'text') return;
    // A rename is allowed to replace an existing destination. Its observer was
    // attached to the destroyed destination document and must not block a fresh
    // binding for the renamed Y.Text.
    this.textObservers.delete(to);
    const observer = this.textObservers.get(from);
    if (observer) {
      this.project.text(to).unobserve(observer);
      this.textObservers.delete(from);
    }
    const open = vscode.workspace.textDocuments.find((document) => this.keyForUri(document.uri) === to);
    if (open) this.bindTextDocument(open);
  };

  private readonly onDocumentDeleted = (key: string, kind: string, doc?: Y.Doc): void => {
    if (kind !== 'text') return;
    const observer = this.textObservers.get(key);
    if (observer) {
      doc?.getText('content').unobserve(observer);
      this.textObservers.delete(key);
    }
  };

  private bindTextDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme === 'vscode-notebook-cell') return;
    const key = this.keyForUri(document.uri);
    if (!key) return;
    const existingKind = this.project.kindOf(key);
    if (existingKind && existingKind !== 'text') return;
    if (!existingKind && classifyFile(key, Buffer.byteLength(document.getText(), 'utf8')) !== 'text') return;
    const text = this.project.has(key)
      ? this.project.text(key)
      : this.project.ensureText(key, document.getText(), LOCAL_EDITOR_ORIGIN);
    if (this.textObservers.has(key)) return;
    const observer = (event: Y.YTextEvent) => {
      if (event.transaction.origin !== REMOTE_ORIGIN) return;
      this.enqueueTextApply(key, async () => {
        const open = vscode.workspace.textDocuments.find((candidate) => this.keyForUri(candidate.uri) === key);
        if (open) await this.applyText(open, this.project.text(key).toString());
      });
    };
    text.observe(observer);
    this.textObservers.set(key, observer);
  }

  private onTextChanged(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    if (document.uri.scheme === 'vscode-notebook-cell') {
      this.onNotebookCellTextChanged(event);
      return;
    }
    const key = this.keyForUri(document.uri);
    if (!key || this.applyingText.has(document.uri.toString()) || !event.contentChanges.length) return;
    if (this.project.kindOf(key) !== 'text') return;
    const changes: TextChange[] = event.contentChanges.map((change) => ({
      offset: change.rangeOffset,
      deleteCount: change.rangeLength,
      insertText: change.text,
    }));
    try {
      this.project.applyTextChanges(key, changes, LOCAL_EDITOR_ORIGIN);
    } catch (error) {
      this.restoreRejectedText(
        document,
        this.project.text(key).toString(),
        `Rejected unsafe text editor update for ${key}: ${formatError(error)}`,
      );
    }
  }

  private async applyText(document: vscode.TextDocument, target: string): Promise<void> {
    const current = document.getText();
    if (current === target) return;
    const edit = minimalEdit(current, target);
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      document.uri,
      new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.deleteCount)),
      edit.insertText,
    );
    const uri = document.uri.toString();
    this.applyingText.add(uri);
    try {
      if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error(`VS Code rejected remote edit for ${document.uri.fsPath}`);
    } finally {
      this.applyingText.delete(uri);
    }
  }

  private async bindNotebook(notebook: vscode.NotebookDocument): Promise<void> {
    const key = this.keyForUri(notebook.uri);
    if (!key) return;
    if (!this.project.has(key)) {
      await this.ensureStableCellIds(notebook);
      this.project.ensureNotebook(key, this.snapshotFromNotebook(notebook));
    } else {
      const snapshot = this.project.notebookSnapshot(key);
      const matches = matchInitialCellIds(
        Array.from({ length: notebook.cellCount }, (_, index) => {
          const cell = notebook.cellAt(index);
          return { kind: cell.kind, language: cell.document.languageId, source: cell.document.getText() };
        }),
        snapshot.cells,
      );
      for (let index = 0; index < notebook.cellCount; index += 1) {
        const cell = notebook.cellAt(index);
        this.cellIds.seed(cell, metadataCellId(cell.metadata), matches[index]);
      }
      await this.applyNotebookSnapshot(notebook, snapshot);
    }
    await this.ensureStableCellIds(notebook);
  }

  private onNotebookChanged(event: vscode.NotebookDocumentChangeEvent): void {
    let key: string | undefined;
    try {
      key = this.keyForUri(event.notebook.uri);
      if (!key || this.applyingNotebooks.has(event.notebook.uri.toString())) return;
      if (event.contentChanges.length) {
        this.project.reconcileNotebook(key, this.snapshotFromNotebook(event.notebook), LOCAL_EDITOR_ORIGIN);
        void this.ensureStableCellIds(event.notebook).catch((error) => {
          this.log.appendLine(`[error] Failed to persist notebook cell identities: ${formatError(error)}`);
        });
      }
      if (event.metadata) {
        this.project.setNotebookMetadata(key, normalizeNotebookMetadata(event.notebook.metadata), LOCAL_EDITOR_ORIGIN);
      }
      for (const change of event.cellChanges) {
        const cellId = this.cellIds.idFor(change.cell, metadataCellId(change.cell.metadata));
        if (change.metadata) {
          this.project.setCellMetadata(key, cellId, stripCollaborationMetadata(change.metadata), LOCAL_EDITOR_ORIGIN);
        }
        if (change.outputs) {
          this.project.setCellOutputs(key, cellId, outputsFromCell(change.cell), LOCAL_EDITOR_ORIGIN);
        }
        if (change.executionSummary) {
          this.project.setCellExecution(key, cellId, executionFromCell(change.cell), LOCAL_EDITOR_ORIGIN);
        }
      }
    } catch (error) {
      const detail = `Rejected unsafe notebook editor update: ${formatError(error)}`;
      this.log.appendLine(`[error] ${detail}`);
      if (key && this.project.kindOf(key) === 'notebook') {
        this.enqueueNotebookApply(key, () => this.applyNotebookSnapshot(event.notebook, this.project.notebookSnapshot(key!)));
      }
      this.warnRejectedEditorUpdate(detail);
    }
  }

  private onNotebookCellTextChanged(event: vscode.TextDocumentChangeEvent): void {
    let canonicalSource: string | undefined;
    try {
      if (this.applyingText.has(event.document.uri.toString()) || !event.contentChanges.length) return;
      for (const notebook of vscode.workspace.notebookDocuments) {
        const cell = notebook.getCells().find((candidate) => candidate.document.uri.toString() === event.document.uri.toString());
        if (!cell) continue;
        const key = this.keyForUri(notebook.uri);
        const cellId = this.cellIds.idFor(cell, metadataCellId(cell.metadata));
        if (!key || !cellId) return;
        if (!this.project.hasNotebookCell(key, cellId)) {
          this.project.reconcileNotebook(key, this.snapshotFromNotebook(notebook), LOCAL_EDITOR_ORIGIN);
          return;
        }
        canonicalSource = this.project.cellSource(key, cellId).toString();
        const changes = event.contentChanges.map((change) => ({
          offset: change.rangeOffset,
          deleteCount: change.rangeLength,
          insertText: change.text,
        }));
        this.project.applyCellTextChanges(key, cellId, changes, LOCAL_EDITOR_ORIGIN);
        return;
      }
    } catch (error) {
      const detail = `Rejected unsafe notebook cell update: ${formatError(error)}`;
      if (canonicalSource !== undefined) this.restoreRejectedText(event.document, canonicalSource, detail);
      else {
        this.log.appendLine(`[error] ${detail}`);
        this.warnRejectedEditorUpdate(detail);
      }
    }
  }

  private restoreRejectedText(document: vscode.TextDocument, canonical: string, detail: string): void {
    this.log.appendLine(`[error] ${detail}`);
    void this.applyText(document, canonical).catch((error) => {
      this.log.appendLine(`[error] Could not restore rejected editor update: ${formatError(error)}`);
    });
    this.warnRejectedEditorUpdate(detail);
  }

  private warnRejectedEditorUpdate(detail: string): void {
    const now = Date.now();
    if (now - this.lastRejectedEditorWarningAt < 5_000) return;
    this.lastRejectedEditorWarningAt = now;
    void vscode.window?.showWarningMessage?.(
      `Pair Notebook отклонил изменение и восстановил общее состояние: ${detail}`,
    );
  }

  private async applyNotebookSnapshot(notebook: vscode.NotebookDocument, snapshot: NotebookSnapshot): Promise<void> {
    const currentCells = notebook.getCells();
    const currentStructure = currentCells.map((cell, index) => ({
      id: this.cellIds.knownId(cell, metadataCellId(cell.metadata)) ?? `unidentified:${index}`,
      kind: cell.kind,
      language: cell.document.languageId,
    }));
    const splice = minimalNotebookSplice(currentStructure, snapshot.cells);
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      if (splice) {
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(
          new vscode.NotebookRange(splice.start, splice.start + splice.deleteCount),
          splice.cells.map(toNotebookCellData),
        )]);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook structure.');
      }

      for (let index = 0; index < snapshot.cells.length; index += 1) {
        const target = snapshot.cells[index];
        if (!target) continue;
        const current = notebook.cellAt(index);
        await this.applyText(current.document, target.source);
      }
      const notebookEdits: vscode.NotebookEdit[] = [];
      for (let index = 0; index < snapshot.cells.length; index += 1) {
        const target = snapshot.cells[index];
        if (!target) continue;
        const current = notebook.cellAt(index);
        const desiredMetadata = { ...target.metadata, pairNotebookCellId: target.id };
        const outputChanged = JSON.stringify(outputsFromCell(current)) !== JSON.stringify(target.outputs);
        const executionChanged = JSON.stringify(executionFromCell(current)) !== JSON.stringify(target.execution);
        if (outputChanged || executionChanged) {
          notebookEdits.push(vscode.NotebookEdit.replaceCells(
            new vscode.NotebookRange(index, index + 1),
            [toNotebookCellData(target)],
          ));
        } else if (JSON.stringify(current.metadata) !== JSON.stringify(desiredMetadata)) {
          notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(index, desiredMetadata));
        }
      }
      const currentMetadata = normalizeNotebookMetadata(notebook.metadata);
      if (JSON.stringify(currentMetadata) !== JSON.stringify(snapshot.metadata)) {
        notebookEdits.push(vscode.NotebookEdit.updateNotebookMetadata(
          toVscodeNotebookMetadata(snapshot.metadata, notebook.metadata),
        ));
      }
      if (notebookEdits.length) {
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, notebookEdits);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook metadata/output update.');
      }
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private snapshotFromNotebook(notebook: vscode.NotebookDocument): NotebookSnapshot {
    if (notebook.cellCount > MAX_NOTEBOOK_CELLS) {
      throw new Error(`Notebook exceeds the ${MAX_NOTEBOOK_CELLS}-cell limit.`);
    }
    return {
      metadata: normalizeNotebookMetadata(notebook.metadata),
      cells: notebook.getCells().map((cell) => ({
        id: this.cellIds.idFor(cell, metadataCellId(cell.metadata)),
        kind: cell.kind,
        language: cell.document.languageId,
        source: cell.document.getText(),
        metadata: stripCollaborationMetadata(cell.metadata),
        outputs: outputsFromCell(cell),
        execution: executionFromCell(cell),
      })),
    };
  }

  private async ensureStableCellIds(notebook: vscode.NotebookDocument): Promise<void> {
    const edits: vscode.NotebookEdit[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < notebook.cellCount; index += 1) {
      const cell = notebook.cellAt(index);
      const existing = metadataCellId(cell.metadata);
      let id = this.cellIds.idFor(cell, existing);
      if (seen.has(id)) id = this.cellIds.renew(cell);
      seen.add(id);
      if (existing !== id) {
        edits.push(vscode.NotebookEdit.updateCellMetadata(index, {
          ...cell.metadata,
          pairNotebookCellId: id,
        }));
      }
    }
    if (!edits.length) return;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(notebook.uri, edits);
      if (!await vscode.workspace.applyEdit(workspaceEdit)) {
        throw new Error('VS Code rejected stable notebook cell identity metadata.');
      }
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private keyForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const relative = path.relative(this.root, uri.fsPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    try {
      const key = safeRelativePath(relative).split(path.sep).join('/');
      return shouldTrackProjectPath(key) ? key : undefined;
    } catch {
      return undefined;
    }
  }
}

function toVscodeNotebookMetadata(
  canonical: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeNotebookMetadata(canonical);
  const marker = asRecord(normalized.pairNotebookNbformat);
  const metadata = { ...normalized };
  delete metadata.pairNotebookNbformat;
  const currentRecord = asRecord(current);
  const currentCustom = asRecord(currentRecord.custom);
  const usesJupyterWrapper = 'custom' in currentRecord
    || Array.isArray(currentRecord.cells)
    || 'indentAmount' in currentRecord;
  if (!usesJupyterWrapper) return normalized;
  const outer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentRecord)) {
    if (!['custom', 'cells', 'metadata', 'nbformat', 'nbformat_minor', 'kernelspec', 'language_info'].includes(key)) {
      outer[key] = value;
    }
  }
  const customExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentCustom)) {
    if (!['cells', 'metadata', 'nbformat', 'nbformat_minor'].includes(key)) customExtra[key] = value;
  }
  return {
    ...outer,
    custom: {
      ...customExtra,
      cells: [],
      metadata,
      nbformat: typeof marker.nbformat === 'number' ? marker.nbformat : 4,
      nbformat_minor: typeof marker.nbformat_minor === 'number' ? marker.nbformat_minor : 5,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function minimalEdit(current: string, target: string): TextChange {
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start]) start += 1;
  let currentEnd = current.length;
  let targetEnd = target.length;
  while (currentEnd > start && targetEnd > start && current[currentEnd - 1] === target[targetEnd - 1]) {
    currentEnd -= 1;
    targetEnd -= 1;
  }
  return { offset: start, deleteCount: currentEnd - start, insertText: target.slice(start, targetEnd) };
}

function stripCollaborationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  delete copy.pairNotebookCellId;
  return copy;
}

function outputsFromCell(cell: vscode.NotebookCell): OutputSnapshot[] {
  if (cell.outputs.length > MAX_CELL_OUTPUTS) {
    throw new Error(`Cell exceeds the ${MAX_CELL_OUTPUTS}-output limit.`);
  }
  let itemCount = 0;
  let encodedBytes = 0;
  const outputs = cell.outputs.map((output) => ({
    metadata: output.metadata,
    items: output.items.map((item) => {
      itemCount += 1;
      encodedBytes += Math.ceil(item.data.byteLength / 3) * 4 + Buffer.byteLength(item.mime, 'utf8');
      if (itemCount > MAX_OUTPUT_ITEMS_PER_CELL || encodedBytes > MAX_CELL_OUTPUT_JSON_BYTES) {
        throw new Error('Cell outputs exceed the collaborative output limit.');
      }
      return { mime: item.mime, dataBase64: Buffer.from(item.data).toString('base64') };
    }),
  }));
  return outputs;
}

function executionFromCell(cell: vscode.NotebookCell): CellExecutionSnapshot | undefined {
  const summary = cell.executionSummary;
  if (!summary) return undefined;
  return {
    executionOrder: summary.executionOrder,
    success: summary.success,
    timing: summary.timing ? { ...summary.timing } : undefined,
  };
}

function toNotebookOutput(output: OutputSnapshot): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput(
    output.items.map((item) => new vscode.NotebookCellOutputItem(Buffer.from(item.dataBase64, 'base64'), item.mime)),
    ...(output.metadata !== undefined ? [output.metadata] : []),
  );
}

function toNotebookCellData(cell: CellSnapshot): vscode.NotebookCellData {
  const result = new vscode.NotebookCellData(cell.kind, cell.source, cell.language);
  result.metadata = { ...cell.metadata, pairNotebookCellId: cell.id };
  result.outputs = cell.outputs.map(toNotebookOutput);
  if (cell.execution !== undefined) {
    const { executionOrder, success, timing } = cell.execution;
    result.executionSummary = {
      ...(executionOrder !== undefined ? { executionOrder } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(timing !== undefined ? { timing: { ...timing } } : {}),
    };
  }
  return result;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
