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
  NotebookUpdateScope,
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
import { EditorTextReplica } from './editorTextReplica';

const NOTEBOOK_CELL_STATE_COALESCE_MS = 75;

export interface NotebookCellRenderRequest {
  outputs: readonly vscode.NotebookCellOutput[];
  execution: CellExecutionSnapshot | undefined;
  outputsChanged: boolean;
  executionChanged: boolean;
  executionMode: 'live' | 'snapshot';
}

export interface NotebookCellStateRenderer {
  renderRemoteCellState(cell: vscode.NotebookCell, request: NotebookCellRenderRequest): Promise<void>;
}

export type LineLockGuard = (
  key: string,
  cellId: string | undefined,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  canonicalSource: string,
) => string | undefined;

export class EditorSynchronizer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly textReplicas = new Map<string, EditorTextReplica>();
  private readonly pendingTextEdits = new Map<string, vscode.TextDocumentChangeEvent[]>();
  private readonly textRenders = new Map<string, Promise<void>>();
  private readonly applyingNotebooks = new Set<string>();
  private readonly textObservers = new Map<string, (event: Y.YTextEvent) => void>();
  private readonly textApplyQueues = new Map<string, Promise<void>>();
  private readonly notebookApplyQueues = new Map<string, Promise<void>>();
  private readonly pendingNotebookCellStates = new Map<string, Set<string>>();
  private readonly notebookCellStateTimers = new Map<string, NodeJS.Timeout>();
  private readonly notebookBindings = new WeakMap<vscode.NotebookDocument, Promise<void>>();
  private readonly boundNotebooks = new WeakSet<vscode.NotebookDocument>();
  private readonly displayedStructures = new WeakMap<vscode.NotebookDocument, Array<Pick<CellSnapshot, 'id' | 'kind' | 'language'>>>();
  private lastRejectedEditorWarningAt = 0;

  public constructor(
    private readonly project: CollaborativeProject,
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly cellIds = new StableCellIdRegistry<vscode.NotebookCell>(),
    private readonly cellStateRenderer?: NotebookCellStateRenderer,
    private readonly lineLockGuard?: LineLockGuard,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.bindTextDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onTextChanged(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uri = document.uri.toString();
        this.textReplicas.get(uri)?.dispose();
        this.textReplicas.delete(uri);
      }),
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
    for (const replica of this.textReplicas.values()) replica.dispose();
    this.textReplicas.clear();
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
      await this.drainPendingNotebookCellStates(relativePath);
      // Persistence never invokes a full notebook snapshot merely because a
      // flush happened. Reconcile fields narrowly; full snapshot is reachable
      // only if this proves an actual structural mismatch.
      await this.applyUnscopedNotebookReconciliation(notebook, relativePath);
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
      const scope: NotebookUpdateScope | undefined = event.scope;
      if (!scope) {
        // State-vector/bootstrap reconciliation can merge historical scopes.
        // Apply fields narrowly when structure already matches; a full snapshot
        // is allowed only if stable-id structure proves an inconsistency.
        await this.applyUnscopedNotebookReconciliation(notebook, event.key);
        return;
      }
      switch (scope.type) {
        case 'cellText': {
          const located = this.findNotebookCellByStableId(notebook, scope.cellId);
          if (!located) return;
          // Canonical source is the Y.Text for this stable cell ID. No notebook
          // snapshot, cell index identity, or replaceCells path participates.
          let source: string;
          try {
            source = this.project.cellSource(event.key, scope.cellId).toString();
          } catch {
            return;
          }
          await this.applyText(located.cell.document, source);
          return;
        }
        case 'cellOutputs':
        case 'cellExecution':
          this.scheduleNotebookCellStateApply(event.key, scope.cellId);
          return;
        case 'cellMetadata':
          await this.applyNotebookCellMetadata(notebook, event.key, scope.cellId);
          return;
        case 'notebookMetadata':
          await this.applyNotebookMetadata(notebook, event.key);
          return;
        case 'structure':
          await this.applyStructuralRecoveryIfNeeded(notebook, event.key, 'remote structure scope');
          return;
        default:
          assertNeverNotebookScope(scope);
      }
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
      this.flushPendingNotebookCellStates(key);
    }, NOTEBOOK_CELL_STATE_COALESCE_MS);
    this.notebookCellStateTimers.set(key, timer);
  }

  private flushPendingNotebookCellStates(key: string): void {
    const pending = this.pendingNotebookCellStates.get(key);
    this.pendingNotebookCellStates.delete(key);
    if (!pending?.size) return;
    this.enqueueNotebookApply(key, async () => {
      const notebook = vscode.workspace.notebookDocuments.find((candidate) => this.keyForUri(candidate.uri) === key);
      if (!notebook) return;
      // Read canonical CRDT state only now, after the burst has collapsed. No
      // obsolete intermediate iopub/output/execution snapshot is replayed.
      for (const pendingCellId of pending) {
        await this.applyNotebookCellState(notebook, key, pendingCellId);
      }
    });
  }

  private async drainPendingNotebookCellStates(key: string): Promise<void> {
    const timer = this.notebookCellStateTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.notebookCellStateTimers.delete(key);
    }
    this.flushPendingNotebookCellStates(key);
    await (this.notebookApplyQueues.get(key) ?? Promise.resolve());
  }

  private async applyNotebookCellState(
    notebook: vscode.NotebookDocument,
    key: string,
    cellId: string,
    executionMode: 'live' | 'snapshot' = 'live',
  ): Promise<void> {
    const target = this.project.notebookCellSnapshot(key, cellId);
    const located = this.findNotebookCellByStableId(notebook, cellId);
    if (!target || !located) return;
    const current = located.cell;
    const outputsChanged = !sameJson(outputsFromCell(current), target.outputs);
    const executionChanged = !sameJson(
      executionFromCell(current),
      editorVisibleExecution(target.execution),
    );
    if (!outputsChanged && !executionChanged) return;
    if (!this.cellStateRenderer) {
      if (outputsChanged) {
        this.log.appendLine(
          `[error] Cannot render remote notebook outputs for ${key} cell ${cellId}: NotebookController renderer is unavailable.`,
        );
      }
      if (executionChanged) {
        this.log.appendLine(
          `[error] Cannot render remote notebook execution for ${key} cell ${cellId}: NotebookController renderer is unavailable.`,
        );
      }
      return;
    }
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      try {
        await this.cellStateRenderer.renderRemoteCellState(current, {
          outputs: target.outputs.map(toNotebookOutput),
          execution: target.execution,
          outputsChanged,
          executionChanged,
          executionMode,
        });
      } catch (error) {
        if (outputsChanged) {
          this.log.appendLine(
            `[error] Failed to render remote notebook outputs for ${key} cell ${cellId}: ${formatError(error)}`,
          );
        }
        if (executionChanged) {
          this.log.appendLine(
            `[error] Failed to render remote notebook execution for ${key} cell ${cellId}: ${formatError(error)}`,
          );
        }
      }
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private async applyNotebookCellMetadata(notebook: vscode.NotebookDocument, key: string, cellId: string): Promise<void> {
    const target = this.project.notebookCellSnapshot(key, cellId);
    const located = this.findNotebookCellByStableId(notebook, cellId);
    if (!target || !located) return;
    const currentCanonical = canonicalJsonObject(stripCollaborationMetadata(located.cell.metadata));
    const targetCanonical = canonicalJsonObject(target.metadata);
    if (sameJson(currentCanonical, targetCanonical)
      && metadataCellId(located.cell.metadata) === cellId) return;
    const metadata = { ...targetCanonical, pairNotebookCellId: cellId };
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(located.index, metadata)]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook cell metadata update.');
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private async applyNotebookMetadata(notebook: vscode.NotebookDocument, key: string): Promise<void> {
    const current = normalizeNotebookMetadata(notebook.metadata);
    const target = normalizeNotebookMetadata(this.project.notebookMetadata(key));
    if (sameJson(current, target)) return;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(
        toVscodeNotebookMetadata(target, notebook.metadata),
      )]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook metadata update.');
    } finally {
      this.applyingNotebooks.delete(uri);
    }
  }

  private findNotebookCellByStableId(
    notebook: vscode.NotebookDocument,
    cellId: string,
  ): { cell: vscode.NotebookCell; index: number } | undefined {
    for (let index = 0; index < notebook.cellCount; index += 1) {
      const cell = notebook.cellAt(index);
      if (this.cellIds.knownId(cell, metadataCellId(cell.metadata)) === cellId) {
        return { cell, index };
      }
    }
    return undefined;
  }

  private remapStableCellIdsAfterStructure(notebook: vscode.NotebookDocument): void {
    const seen = new Set<string>();
    for (const cell of notebook.getCells()) {
      const explicit = metadataCellId(cell.metadata);
      if (!explicit || seen.has(explicit)) continue;
      seen.add(explicit);
      this.cellIds.seed(cell, explicit, explicit);
    }
    this.rememberStructure(notebook);
  }

  private rememberStructure(notebook: vscode.NotebookDocument): void {
    this.displayedStructures.set(notebook, notebook.getCells().map((cell) => ({
      id: this.cellIds.idFor(cell, metadataCellId(cell.metadata)), kind: cell.kind, language: cell.document.languageId,
    })));
  }

  private reconcileEditorStructure(notebook: vscode.NotebookDocument, key: string): void {
    const canonical = this.project.notebookSnapshot(key);
    const editor = this.snapshotFromNotebook(notebook);
    const before = this.displayedStructures.get(notebook) ?? canonical.cells;
    const splice = minimalNotebookSplice(before, editor.cells);
    if (!splice) return;
    const previous = new Map(before.map((cell) => [cell.id, cell]));
    const canonicalCells = new Map(canonical.cells.map((cell) => [cell.id, cell]));
    const removed = new Set(before.slice(splice.start, splice.start + splice.deleteCount).map((cell) => cell.id));
    const inserted = splice.cells.flatMap((cell) => {
      const existing = canonicalCells.get(cell.id);
      const old = previous.get(cell.id);
      // A remote deletion wins over moving a stale editor cell. New cells are
      // initialized from the editor; existing cells retain canonical fields.
      if (!existing) return old ? [] : [cell];
      return [{ ...existing,
        kind: old && old.kind !== cell.kind ? cell.kind : existing.kind,
        language: old && old.language !== cell.language ? cell.language : existing.language,
      }];
    });
    const insertedIds = new Set(inserted.map((cell) => cell.id));
    const cells = canonical.cells.filter((cell) => !removed.has(cell.id) && !insertedIds.has(cell.id));
    const right = editor.cells.slice(splice.start + splice.cells.length).find((cell) => cells.some((current) => current.id === cell.id));
    const left = editor.cells.slice(0, splice.start).reverse().find((cell) => cells.some((current) => current.id === cell.id));
    const index = right ? cells.findIndex((cell) => cell.id === right.id)
      : left ? cells.findIndex((cell) => cell.id === left.id) + 1 : cells.length;
    cells.splice(index, 0, ...inserted);
    this.project.reconcileNotebook(key, { metadata: canonical.metadata, cells }, LOCAL_EDITOR_ORIGIN);
    this.rememberStructure(notebook);
    for (const cell of notebook.getCells()) {
      const id = this.cellIds.idFor(cell, metadataCellId(cell.metadata));
      if (this.project.hasNotebookCell(key, id)) this.rememberText(cell.document, key, id);
    }
  }

  private captureStructuralEditorState(notebook: vscode.NotebookDocument): StructuralEditorState | undefined {
    const editor = vscode.window.visibleNotebookEditors.find((candidate) => candidate.notebook === notebook);
    if (!editor) return undefined;
    const idAt = (index: number): string | undefined => {
      if (index < 0 || index >= notebook.cellCount) return undefined;
      const cell = notebook.cellAt(index);
      return this.cellIds.knownId(cell, metadataCellId(cell.metadata));
    };
    const selectionIds = editor.selections.map((range) =>
      notebook.getCells(range)
        .map((cell) => this.cellIds.knownId(cell, metadataCellId(cell.metadata)))
        .filter((id): id is string => Boolean(id)));
    const primaryCellId = idAt(editor.selection.start);
    const firstVisible = editor.visibleRanges[0];
    const visibleAnchorId = firstVisible ? idAt(firstVisible.start) : undefined;

    const activeTextEditor = vscode.window.activeTextEditor;
    let textSelection: StructuralEditorState['textSelection'];
    if (activeTextEditor) {
      const cell = notebook.getCells().find((candidate) =>
        candidate.document.uri.toString() === activeTextEditor.document.uri.toString());
      const cellId = cell ? this.cellIds.knownId(cell, metadataCellId(cell.metadata)) : undefined;
      if (cellId) textSelection = { cellId, selections: [...activeTextEditor.selections] };
    }
    return { editor, primaryCellId, selectionIds, visibleAnchorId, textSelection };
  }

  private restoreStructuralEditorState(
    notebook: vscode.NotebookDocument,
    state: StructuralEditorState | undefined,
  ): void {
    if (!state) return;
    const primary = state.primaryCellId
      ? this.findNotebookCellByStableId(notebook, state.primaryCellId)
      : undefined;

    // If the selected stable cell was deleted, do not fabricate a fallback
    // cell or line 0. Leave VS Code's post-edit selection untouched.
    if (primary) {
      const restoredSelections = state.selectionIds
        .map((ids) => ids
          .map((id) => this.findNotebookCellByStableId(notebook, id)?.index)
          .filter((index): index is number => index !== undefined))
        .filter((indexes) => indexes.length > 0)
        .map((indexes) => new vscode.NotebookRange(Math.min(...indexes), Math.max(...indexes) + 1));
      if (restoredSelections.length) state.editor.selections = restoredSelections;
    }

    if (state.textSelection) {
      const target = this.findNotebookCellByStableId(notebook, state.textSelection.cellId);
      if (target) {
        const textEditor = vscode.window.visibleTextEditors.find((candidate) =>
          candidate.document.uri.toString() === target.cell.document.uri.toString());
        if (textEditor) textEditor.selections = state.textSelection.selections;
      }
    }

    if (state.visibleAnchorId) {
      const anchor = this.findNotebookCellByStableId(notebook, state.visibleAnchorId);
      if (anchor) {
        const alreadyVisible = state.editor.visibleRanges.some((range) =>
          anchor.index >= range.start && anchor.index < range.end);
        if (!alreadyVisible) {
          // VS Code 1.95 exposes visibleRanges as read-only. Exact pixel scroll
          // offset cannot be restored through stable API; revealRange is the
          // supported best-effort restoration primitive.
          state.editor.revealRange(
            new vscode.NotebookRange(anchor.index, anchor.index + 1),
            vscode.NotebookEditorRevealType.AtTop,
          );
        }
      }
    }
  }

  private async applyStructuralRecoveryIfNeeded(
    notebook: vscode.NotebookDocument,
    key: string,
    reason: string,
  ): Promise<boolean> {
    const snapshot = this.project.notebookSnapshot(key);
    const currentStructure = notebook.getCells().map((cell) => ({
      id: this.cellIds.knownId(cell, metadataCellId(cell.metadata)) ?? '',
      kind: cell.kind,
      language: cell.document.languageId,
    }));
    if (!minimalNotebookSplice(currentStructure, snapshot.cells)) return false;
    this.log.appendLine(`[structural-recovery] ${key}: ${reason}; applying canonical notebook snapshot.`);
    await this.applyNotebookSnapshot(notebook, snapshot);
    return true;
  }

  private async applyUnscopedNotebookReconciliation(
    notebook: vscode.NotebookDocument,
    key: string,
  ): Promise<void> {
    if (await this.applyStructuralRecoveryIfNeeded(notebook, key, 'unscoped state-vector reconciliation')) return;
    const snapshot = this.project.notebookSnapshot(key);
    for (const target of snapshot.cells) {
      const located = this.findNotebookCellByStableId(notebook, target.id);
      if (!located) continue;
      await this.applyText(located.cell.document, target.source);
      await this.applyNotebookCellMetadata(notebook, key, target.id);
      await this.applyNotebookCellState(notebook, key, target.id, 'snapshot');
    }
    await this.applyNotebookMetadata(notebook, key);
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
    for (const replica of this.textReplicas.values()) {
      if (replica.key === from) replica.rename(to);
    }
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
    for (const [uri, replica] of this.textReplicas) {
      if (replica.key !== key) continue;
      replica.dispose();
      this.textReplicas.delete(uri);
    }
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
    this.rememberText(document, key);
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
    if (!key || !event.contentChanges.length || this.consumeTextEcho(event)) return;
    if (this.project.kindOf(key) !== 'text') return;
    const canonicalSource = this.project.text(key).toString();
    const lineLock = this.lineLockGuard?.(key, undefined, event.contentChanges, canonicalSource);
    if (lineLock) {
      this.restoreRejectedText(document, canonicalSource, lineLock);
      return;
    }
    const changes: TextChange[] = event.contentChanges.map((change) => ({
      offset: change.rangeOffset,
      deleteCount: change.rangeLength,
      insertText: change.text,
    }));
    try {
      this.publishTextChanges(document, key, undefined, changes);
    } catch (error) {
      this.restoreRejectedText(
        document,
        this.project.text(key).toString(),
        `Rejected unsafe text editor update for ${key}: ${formatError(error)}`,
      );
    }
  }

  private async applyText(document: vscode.TextDocument, target: string): Promise<void> {
    const uri = document.uri.toString();
    const previous = this.textRenders.get(uri) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.renderText(document, target));
    this.textRenders.set(uri, next);
    try { await next; } finally {
      if (this.textRenders.get(uri) === next) this.textRenders.delete(uri);
    }
  }

  private async renderText(document: vscode.TextDocument, fallback: string): Promise<void> {
    const uri = document.uri.toString();
    for (;;) {
      const displayed = this.textReplicas.get(uri);
      if (displayed) {
        const canonical = displayed.cellId ? this.project.cellSource(displayed.key, displayed.cellId) : this.project.text(displayed.key);
        if (document.getText() === canonical.toString() && displayed.source() === canonical.toString()) return;
      }
      const replica = displayed ? new EditorTextReplica(this.project, displayed.key, displayed.cellId) : undefined;
      const target = replica?.source() ?? fallback;
      const current = document.getText();
      if (current === target) {
        if (replica) this.replaceTextReplica(uri, replica);
        return;
      }
      const edit = minimalEdit(current, target);
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(
        document.uri,
        new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.deleteCount)),
        edit.insertText,
      );
      const version = document.version;
      const events: vscode.TextDocumentChangeEvent[] = [];
      this.pendingTextEdits.set(uri, events);
      let applied = false;
      try {
        applied = await vscode.workspace.applyEdit(workspaceEdit);
      } finally {
        this.pendingTextEdits.delete(uri);
        let echoed = false;
        for (const event of events) {
          const change = event.contentChanges[0];
          if (applied && !echoed && event.contentChanges.length === 1 && change
            && change.rangeOffset === edit.offset && change.rangeLength === edit.deleteCount && change.text === edit.insertText) {
            echoed = true;
            if (replica) this.replaceTextReplica(uri, replica);
          } else {
            this.onTextChanged(event);
          }
        }
        if (applied && !echoed && replica) this.replaceTextReplica(uri, replica);
        if (replica && this.textReplicas.get(uri) !== replica) replica.dispose();
      }
      if (!applied) {
        if (document.version !== version) continue;
        throw new Error(`VS Code rejected remote edit for ${document.uri.fsPath}`);
      }
      // A later canonical transaction or local keystroke may have arrived while
      // VS Code applied this version. Reconcile again before releasing the queue.
      if (!displayed) return;
    }
  }

  private replaceTextReplica(uri: string, replica: EditorTextReplica): void {
    const previous = this.textReplicas.get(uri);
    if (previous !== replica) previous?.dispose();
    this.textReplicas.set(uri, replica);
  }

  private rememberText(document: vscode.TextDocument, key: string, cellId?: string): void {
    const uri = document.uri.toString();
    if (!this.textReplicas.has(uri)) this.replaceTextReplica(uri, new EditorTextReplica(this.project, key, cellId));
  }

  private consumeTextEcho(event: vscode.TextDocumentChangeEvent): boolean {
    const pending = this.pendingTextEdits.get(event.document.uri.toString());
    if (!pending) return false;
    // Only a successful version-checked WorkspaceEdit proves which event is
    // its echo. Identical user typing before a rejected edit is still local.
    pending.push(event);
    return true;
  }

  private publishTextChanges(document: vscode.TextDocument, key: string, cellId: string | undefined, changes: TextChange[]): void {
    const uri = document.uri.toString();
    const replica = this.textReplicas.get(uri);
    const canonical = cellId ? this.project.cellSource(key, cellId) : this.project.text(key);
    if (replica && replica.source() !== canonical.toString()) {
      replica.edit(changes);
    } else {
      const capture = (event: ProjectUpdate) => {
        if (event.key === key && event.origin === LOCAL_EDITOR_ORIGIN) replica?.accept(event.update);
      };
      this.project.on('update', capture);
      try {
        if (cellId) this.project.applyCellTextChanges(key, cellId, changes, LOCAL_EDITOR_ORIGIN);
        else this.project.applyTextChanges(key, changes, LOCAL_EDITOR_ORIGIN);
      } finally {
        this.project.off('update', capture);
      }
      if (!replica) this.rememberText(document, key, cellId);
    }
  }

  private async bindNotebook(notebook: vscode.NotebookDocument): Promise<void> {
    const key = this.keyForUri(notebook.uri);
    if (!key) return;
    if (!this.project.has(key)) {
      await this.ensureStableCellIds(notebook);
      this.project.ensureNotebook(key, this.snapshotFromNotebook(notebook));
      this.rememberStructure(notebook);
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
        const cellId = this.cellIds.idFor(cell, metadataCellId(cell.metadata));
        if (this.project.hasNotebookCell(key, cellId)) this.rememberText(cell.document, key, cellId);
      }
      await this.applyUnscopedNotebookReconciliation(notebook, key);
    }
    await this.ensureStableCellIds(notebook);
    this.rememberStructure(notebook);
    for (const cell of notebook.getCells()) {
      const cellId = this.cellIds.idFor(cell, metadataCellId(cell.metadata));
      if (this.project.hasNotebookCell(key, cellId)) this.rememberText(cell.document, key, cellId);
    }
  }

  private onNotebookChanged(event: vscode.NotebookDocumentChangeEvent): void {
    const key = this.keyForUri(event.notebook.uri);
    if (!key || this.applyingNotebooks.has(event.notebook.uri.toString())) return;

    if (event.contentChanges.length) {
      try {
        this.reconcileEditorStructure(event.notebook, key);
        void this.ensureStableCellIds(event.notebook).catch((error) => {
          this.log.appendLine(`[error] Failed to persist notebook cell identities: ${formatError(error)}`);
        });
      } catch (error) {
        const detail = `Rejected unsafe notebook structural update: ${formatError(error)}`;
        this.log.appendLine(`[error] ${detail}`);
        this.log.appendLine(`[structural-recovery] ${key}: local structural validation failed; restoring canonical structure.`);
        this.enqueueNotebookApply(key, () => this.applyStructuralRecoveryIfNeeded(
          event.notebook,
          key,
          'local structural validation failed',
        ).then(() => undefined));
        this.warnRejectedEditorUpdate(detail);
      }
    }

    if (event.metadata) {
      try {
        this.project.setNotebookMetadata(key, normalizeNotebookMetadata(event.notebook.metadata), LOCAL_EDITOR_ORIGIN);
      } catch (error) {
        const detail = `Rejected unsafe notebook metadata update: ${formatError(error)}`;
        this.log.appendLine(`[error] ${detail}`);
        this.enqueueNotebookApply(key, () => this.applyNotebookMetadata(event.notebook, key));
        this.warnRejectedEditorUpdate(detail);
      }
    }

    for (const change of event.cellChanges) {
      const cellId = this.cellIds.idFor(change.cell, metadataCellId(change.cell.metadata));
      if (change.metadata) {
        try {
          this.project.setCellMetadata(key, cellId, stripCollaborationMetadata(change.metadata), LOCAL_EDITOR_ORIGIN);
        } catch (error) {
          const detail = `Rejected unsafe notebook cell metadata update: ${formatError(error)}`;
          this.log.appendLine(`[error] ${detail}`);
          this.enqueueNotebookApply(key, () => this.applyNotebookCellMetadata(event.notebook, key, cellId));
          this.warnRejectedEditorUpdate(detail);
        }
      }
      if (change.outputs) {
        try {
          this.project.setCellOutputs(key, cellId, outputsFromCell(change.cell), LOCAL_EDITOR_ORIGIN);
        } catch (error) {
          const detail = `Rejected unsafe notebook cell output update: ${formatError(error)}`;
          this.log.appendLine(`[error] ${detail}`);
          this.scheduleNotebookCellStateApply(key, cellId);
          this.warnRejectedEditorUpdate(detail);
        }
      }
      if (change.executionSummary) {
        try {
          this.project.setCellExecution(key, cellId, executionFromCell(change.cell), LOCAL_EDITOR_ORIGIN);
        } catch (error) {
          const detail = `Rejected unsafe notebook cell execution update: ${formatError(error)}`;
          this.log.appendLine(`[error] ${detail}`);
          this.scheduleNotebookCellStateApply(key, cellId);
          this.warnRejectedEditorUpdate(detail);
        }
      }
    }
  }

  private onNotebookCellTextChanged(event: vscode.TextDocumentChangeEvent): void {
    let canonicalSource: string | undefined;
    try {
      if (!event.contentChanges.length || this.consumeTextEcho(event)) return;
      for (const notebook of vscode.workspace.notebookDocuments) {
        const cell = notebook.getCells().find((candidate) => candidate.document.uri.toString() === event.document.uri.toString());
        if (!cell) continue;
        const key = this.keyForUri(notebook.uri);
        const cellId = this.cellIds.idFor(cell, metadataCellId(cell.metadata));
        if (!key || !cellId) return;
        if (!this.project.hasNotebookCell(key, cellId)) {
          this.reconcileEditorStructure(notebook, key);
          return;
        }
        canonicalSource = this.project.cellSource(key, cellId).toString();
        const lineLock = this.lineLockGuard?.(key, cellId, event.contentChanges, canonicalSource);
        if (lineLock) {
          this.restoreRejectedText(event.document, canonicalSource, lineLock);
          return;
        }
        const changes = event.contentChanges.map((change) => ({
          offset: change.rangeOffset,
          deleteCount: change.rangeLength,
          insertText: change.text,
        }));
        this.publishTextChanges(event.document, key, cellId, changes);
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
    const structuralEditorState = splice ? this.captureStructuralEditorState(notebook) : undefined;
    let structureApplied = false;
    const uri = notebook.uri.toString();
    this.applyingNotebooks.add(uri);
    try {
      if (splice) {
        const edit = new vscode.WorkspaceEdit();
        // The only normal production replaceCells call. The range is the
        // minimal structural splice computed from stable logical cell IDs.
        edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(
          new vscode.NotebookRange(splice.start, splice.start + splice.deleteCount),
          splice.cells.map(toNotebookCellData),
        )]);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook structure.');
        this.remapStableCellIdsAfterStructure(notebook);
        structureApplied = true;
      }

      for (const target of snapshot.cells) {
        const located = this.findNotebookCellByStableId(notebook, target.id);
        if (!located) continue;
        await this.applyText(located.cell.document, target.source);
      }

      const notebookEdits: vscode.NotebookEdit[] = [];
      const stateRenders: Array<{ cell: vscode.NotebookCell; request: NotebookCellRenderRequest }> = [];
      for (const target of snapshot.cells) {
        const located = this.findNotebookCellByStableId(notebook, target.id);
        if (!located) continue;
        const current = located.cell;
        const desiredMetadata = { ...canonicalJsonObject(target.metadata), pairNotebookCellId: target.id };
        const outputsChanged = !sameJson(outputsFromCell(current), target.outputs);
        const executionChanged = !sameJson(
      executionFromCell(current),
      editorVisibleExecution(target.execution),
    );

        if (!sameJson(current.metadata, desiredMetadata)) {
          notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(located.index, desiredMetadata));
        }
        if (outputsChanged || executionChanged) {
          stateRenders.push({
            cell: current,
            request: {
              outputs: target.outputs.map(toNotebookOutput),
              execution: target.execution,
              outputsChanged,
              executionChanged,
              executionMode: 'snapshot',
            },
          });
        }
      }

      const currentMetadata = normalizeNotebookMetadata(notebook.metadata);
      if (!sameJson(currentMetadata, normalizeNotebookMetadata(snapshot.metadata))) {
        notebookEdits.push(vscode.NotebookEdit.updateNotebookMetadata(
          toVscodeNotebookMetadata(snapshot.metadata, notebook.metadata),
        ));
      }
      if (notebookEdits.length) {
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, notebookEdits);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected remote notebook metadata update.');
      }

      if (stateRenders.length) {
        if (!this.cellStateRenderer) {
          this.log.appendLine(
            `[error] Cannot render ${stateRenders.length} notebook output/execution state update(s): NotebookController renderer is unavailable.`,
          );
        } else {
          for (const state of stateRenders) {
            await this.cellStateRenderer.renderRemoteCellState(state.cell, state.request);
          }
        }
      }
    } finally {
      try {
        if (structureApplied) this.restoreStructuralEditorState(notebook, structuralEditorState);
      } finally {
        this.applyingNotebooks.delete(uri);
      }
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

interface StructuralEditorState {
  editor: vscode.NotebookEditor;
  primaryCellId: string | undefined;
  selectionIds: string[][];
  visibleAnchorId: string | undefined;
  textSelection: {
    cellId: string;
    selections: readonly vscode.Selection[];
  } | undefined;
}

function canonicalJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return canonicalJsonValue(value) as Record<string, unknown>;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJsonValue(record[key])]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function assertNeverNotebookScope(scope: never): never {
  throw new Error(`Unhandled notebook update scope: ${JSON.stringify(scope)}`);
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

function editorVisibleExecution(
  execution: CellExecutionSnapshot | undefined,
): CellExecutionSnapshot | undefined {
  if (!execution) return undefined;
  const { executionOrder, success, timing } = execution;
  return {
    ...(executionOrder !== undefined ? { executionOrder } : {}),
    ...(success !== undefined ? { success } : {}),
    ...(timing !== undefined ? { timing: { ...timing } } : {}),
  };
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
