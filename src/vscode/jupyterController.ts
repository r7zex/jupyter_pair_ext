import { SESSION_NOTEBOOK_TYPE } from './sessionNotebook';
import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { renderNotebookCellState } from './notebookCellStateRenderer';
import { CellExecutionSnapshot } from '../core/crdt';
import { CadencedTask, OUTPUT_STATE_CADENCE_MS } from '../core/cadencedTask';
import { PerNotebookExecutionQueue } from '../core/executionQueue';
import { JupyterKernelEvent } from '../core/pythonKernel';
import { SessionRuntime } from '../runtime/session';
import {
  EditorSynchronizer,
  type NotebookCellRenderRequest,
  type NotebookCellStateRenderer,
} from './sync';
import {
  appendJupyterFailureToState,
  applyJupyterEventToState,
  createJupyterRenderState,
  estimateKernelEventBytes,
  snapshotJupyterOutputs,
  type JupyterRenderState,
} from './jupyterOutputState';

export { decodeJupyterBase64 } from './jupyterOutputState';

const MAX_PENDING_RENDER_EVENTS = 2_048;
const MAX_PENDING_RENDER_BYTES = 32 * 1024 * 1024;

export class PairNotebookController implements vscode.Disposable, NotebookCellStateRenderer {
  private registeredController: vscode.NotebookController | undefined;
  private selectionSubscription: vscode.Disposable | undefined;
  private readonly selectionEvents = new EventEmitter();
  public readonly onDidChangeSelectedNotebooks: vscode.Event<{ notebook: vscode.NotebookDocument; selected: boolean }> = listener => {
    this.selectionEvents.on('selection', listener);
    return { dispose: () => { this.selectionEvents.off('selection', listener); } };
  };
  public get controller(): vscode.NotebookController {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (!this.runtime && !this.persistent?.connected
      && !(notebook && this.persistent?.owns(notebook))) {
      throw new Error('Join a Pair Notebook session before selecting its kernel.');
    }
    return this.registeredController ?? this.registerController();
  }
  public refreshSession(): void {
    if (this.runtime || this.persistent?.connected) return;
    this.finishActiveExecutions();
    this.finishMirroredExecutions();
    this.selectionSubscription?.dispose();
    this.selectionSubscription = undefined;
    this.registeredController?.dispose();
    this.registeredController = undefined;
  }
  public persistent: {
    connected?: boolean;
    owns(notebook: vscode.NotebookDocument): boolean;
    execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void>;
    interrupt(notebook: vscode.NotebookDocument): Promise<void>;
  } | undefined;
  private runtime: SessionRuntime | undefined;
  private synchronizer: EditorSynchronizer | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queues = new PerNotebookExecutionQueue();
  private readonly queueKeys = new WeakMap<vscode.NotebookDocument, string>();
  private readonly cancellationGenerations = new WeakMap<vscode.NotebookDocument, number>();
  private runtimeGeneration = 0;
  private readonly mirroredExecutions = new Map<vscode.NotebookCell, MirroredExecutionState>();
  private remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();
  private readonly activeExecutions = new WeakSet<vscode.NotebookCell>();
  private readonly activeExecutionHandles = new Map<vscode.NotebookCell, vscode.NotebookCellExecution>();
  private readonly retiredCellStates = new WeakSet<vscode.NotebookCell>();
  private readonly selections = new Map<string, Promise<vscode.NotebookEditor>>();
  private readonly deferredSelections = new WeakSet<vscode.NotebookDocument>();
  private selectionTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly log: vscode.OutputChannel) {
    const claim = (notebook: vscode.NotebookDocument) => this.claimNotebook(notebook);
    this.disposables.push(
      vscode.workspace.onDidOpenNotebookDocument(claim),
      vscode.window.onDidChangeActiveNotebookEditor(this.selectActiveController),
      vscode.workspace.onDidSaveNotebookDocument?.((notebook) => {
        this.deferredSelections.delete(notebook);
        setTimeout(() => {
          if (vscode.window.activeNotebookEditor?.notebook === notebook) this.selectActiveController(vscode.window.activeNotebookEditor);
        }, 0);
      }) ?? { dispose: () => undefined },
    );
  }

  public claimNotebook(notebook: vscode.NotebookDocument): void {
    if (this.runtime?.notebookKey(notebook.uri) || this.persistent?.owns(notebook)) {
        if (notebook.notebookType && notebook.notebookType !== SESSION_NOTEBOOK_TYPE) {
          if (vscode.window.activeNotebookEditor?.notebook === notebook) this.selectActiveController(vscode.window.activeNotebookEditor);
          return;
        }
        this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    }
  }

  private registerController(): vscode.NotebookController {
    const controller = vscode.notebooks.createNotebookController(
      'pair-notebook-jupyter',
      SESSION_NOTEBOOK_TYPE,
      'Pair Notebook',
      (cells, notebook) => this.execute(cells, notebook),
    );
    controller.supportedLanguages = ['python'];
    controller.supportsExecutionOrder = true;
    controller.description = 'Real Jupyter kernel on the selected Pair Notebook compute target';
    controller.interruptHandler = async (notebook) => {
      if (this.persistent?.owns(notebook)) { await this.persistent.interrupt(notebook); return; }
      const runtime = this.requireRuntime();
      const key = runtime.notebookKey(notebook.uri);
      if (key && await runtime.confirmOperation('interrupt', key)) this.cancelQueuedExecution(notebook);
    };
    this.registeredController = controller;
    this.selectionSubscription = controller.onDidChangeSelectedNotebooks?.(event => this.selectionEvents.emit('selection', event));
    return controller;
  }

  public setRuntime(runtime: SessionRuntime | undefined): void {
    if (this.runtime !== runtime) this.runtimeGeneration += 1;
    if (this.runtime && this.runtime !== runtime) this.finishActiveExecutions();
    if (!runtime) {
      this.finishMirroredExecutions();
      this.remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();
    }
    this.runtime = runtime;
    this.refreshSession();
    if (runtime) void this.controller;
    if (runtime) for (const notebook of vscode.workspace.notebookDocuments) {
      if (runtime.notebookKey(notebook.uri)) {
        this.claimNotebook(notebook);
      }
    }
    this.selectActiveController(vscode.window.activeNotebookEditor);
  }

  private readonly selectActiveController = (editor: vscode.NotebookEditor | undefined): void => {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    if (!editor || (!this.runtime?.notebookKey(editor.notebook.uri) && !this.persistent?.owns(editor.notebook))) return;
    // Affinity alone does not bind the controller to a newly activated notebook.
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      if (vscode.window.activeNotebookEditor?.notebook !== editor.notebook || editor.notebook.isClosed) return;
      void this.selectController(editor).catch((error: unknown) => {
        this.log.appendLine(`[error] Could not restore Pair Notebook kernel selection: ${String(error)}`);
      });
    }, 250);
  };

  private selectController(editor: vscode.NotebookEditor): Promise<vscode.NotebookEditor> {
    const key = editor.notebook.uri.toString();
    const pending = this.selections.get(key);
    if (pending) return pending;
    const work = Promise.resolve().then(() => this.selectEditor(editor));
    this.selections.set(key, work);
    void work.finally(() => { if (this.selections.get(key) === work) this.selections.delete(key); }).catch(() => undefined);
    return work;
  }

  private async selectEditor(editor: vscode.NotebookEditor): Promise<vscode.NotebookEditor> {
    if (editor.notebook.notebookType && editor.notebook.notebookType !== SESSION_NOTEBOOK_TYPE) {
      const original = editor.notebook;
      if (original.isDirty) {
        if (!this.deferredSelections.has(original)) {
          this.deferredSelections.add(original);
          void vscode.window.showWarningMessage('This session notebook is open in Jupyter with unsaved changes. Save it or use Save As to preserve a separate copy, then reopen it in Pair Notebook. Its editor has been kept open.');
        }
        throw new Error('Preserve the unsaved Jupyter notebook before switching its editor.');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === original.uri.toString());
      if (!tabs.length || tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs, true)) {
        throw new Error('Close the existing notebook editor before switching to Pair Notebook. Unsaved changes were retained.');
      }
      // VS Code releases API-held model references while resolving the new type.
      // Visible tabs must be closed first; their references cannot be transferred.
      if (!this.runtime?.notebookKey(original.uri) && !this.persistent?.owns(original)) throw new Error('The notebook session changed during editor switching.');
      await vscode.commands.executeCommand('vscode.openWith', original.uri, SESSION_NOTEBOOK_TYPE);
      const reopened = vscode.window.activeNotebookEditor;
      if (!reopened || reopened.notebook.notebookType !== SESSION_NOTEBOOK_TYPE || reopened.notebook.uri.toString() !== editor.notebook.uri.toString()) throw new Error('Open this session notebook in the Pair Notebook session editor to execute it.');
      editor = reopened;
    }
    if (vscode.window.activeNotebookEditor?.notebook !== editor.notebook) throw new Error('The active notebook changed during kernel selection. Select the intended notebook again.');
    const controller = this.controller;
    const selected = await vscode.commands.executeCommand<boolean>('notebook.selectKernel', {
      id: controller.id, extension: 'pair-notebook.pair-notebook', notebookEditor: editor,
    });
    if (selected !== true) throw new Error('VS Code could not select the Pair Notebook kernel.');
    return editor;
  }

  public setSynchronizer(synchronizer: EditorSynchronizer | undefined): void {
    this.synchronizer = synchronizer;
  }

  public isManagingCellState(cell: vscode.NotebookCell): boolean {
    return this.activeExecutions.has(cell) || this.mirroredExecutions.has(cell);
  }

  public releaseCellState(cell: vscode.NotebookCell): void {
    this.retiredCellStates.add(cell);
    this.remoteExecutionRequestIds.delete(cell);
    const mirrored = this.mirroredExecutions.get(cell);
    if (mirrored) {
      try {
        mirrored.execution.end(undefined);
      } catch (error) {
        this.log.appendLine(`[error] Could not retire removed mirrored execution: ${formatError(error)}`);
      } finally {
        this.mirroredExecutions.delete(cell);
      }
    }
    const active = this.activeExecutionHandles.get(cell);
    if (!active) return;
    try {
      active.end(undefined);
    } catch (error) {
      this.log.appendLine(`[error] Could not retire removed local execution: ${formatError(error)}`);
    } finally {
      this.activeExecutionHandles.delete(cell);
      this.activeExecutions.delete(cell);
    }
    // Removed cells retire only their execution handle. The runtime keeps
    // accepted computation alive until natural completion or a CONFIRM stop.
  }

  public async restartActive(): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) throw new Error('Open a Pair Notebook notebook first.');
    const runtime = this.requireRuntime();
    const key = runtime.notebookKey(editor.notebook.uri);
    if (!key) throw new Error('The active notebook is outside the Pair Notebook working copy.');
    if (await runtime.confirmOperation('restart', key)) this.cancelQueuedExecution(editor.notebook);
  }

  public async executeActive(): Promise<void> {
    let editor = vscode.window.activeNotebookEditor;
    if (!editor) throw new Error('Open a notebook and select a code cell first.');
    if (!this.persistent?.owns(editor.notebook) && !this.requireRuntime().notebookKey(editor.notebook.uri)) throw new Error('The active notebook is outside the Pair Notebook working copy.');
    editor = await this.selectController(editor);
    const cells = editor.notebook.getCells(editor.selection).filter((cell) => cell.kind === vscode.NotebookCellKind.Code);
    if (!cells.length) throw new Error('Select a Python code cell first.');
    await this.execute(cells, editor.notebook);
  }

  public dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.runtimeGeneration += 1;
    this.finishActiveExecutions();
    this.finishMirroredExecutions();
    this.remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();
    this.selectionSubscription?.dispose();
    this.registeredController?.dispose();
    this.selectionEvents.removeAllListeners();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /**
   * Render execution started on another Pair compute target via the stable
   * NotebookController API. In VS Code 1.95 executionSummary is read-only;
   * createNotebookCellExecution + executionOrder/start/end are the supported
   * reconstruction path.
   *
   * startTime can only be supplied to start(). If a live running update first
   * arrives without it, a later final event cannot retroactively set startTime;
   * only endTime can still be supplied exactly.
   */
  public async renderRemoteCellState(
    cell: vscode.NotebookCell,
    request: NotebookCellRenderRequest,
  ): Promise<void> {
    if (!this.registeredController || (!this.runtime && !this.persistent?.connected)) return;
    if (cell.notebook.notebookType && cell.notebook.notebookType !== SESSION_NOTEBOOK_TYPE) return;
    if (!request.outputsChanged && !request.executionChanged) return;
    if (this.retiredCellStates.has(cell)) return;
    const target: CellExecutionSnapshot | undefined = request.execution;
    const liveRequestId = this.remoteExecutionRequestIds.get(cell);
    if (liveRequestId && target?.requestId === liveRequestId) {
      // The initiator already rendered these live events through its local
      // NotebookCellExecution. The CRDT copy is the authoritative echo for the
      // same execution identity and must not be applied a second time.
      return;
    }
    await renderNotebookCellState(this.controller, this.mirroredExecutions, cell, request);
  }

  private finishMirroredExecutions(): void {
    for (const state of this.mirroredExecutions.values()) {
      try {
        state.execution.end(undefined);
      } catch {
        // Best effort during controller/session disposal.
      }
    }
    this.mirroredExecutions.clear();
  }

  private finishActiveExecutions(): void {
    for (const [cell, execution] of this.activeExecutionHandles) {
      try {
        execution.end(undefined);
      } catch {
        // Best effort during controller/session disposal.
      }
      this.activeExecutions.delete(cell);
    }
    this.activeExecutionHandles.clear();
  }

  private cancelQueuedExecution(notebook: vscode.NotebookDocument): void {
    this.cancellationGenerations.set(notebook, (this.cancellationGenerations.get(notebook) ?? 0) + 1);
  }

  private async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    if (notebook.notebookType && notebook.notebookType !== SESSION_NOTEBOOK_TYPE) throw new Error('Open this notebook in the Pair Notebook session editor before executing it.');
    if (this.persistent?.owns(notebook)) { await this.persistent.execute(cells, notebook); return; }
    const runtime = this.requireRuntime();
    const runtimeGeneration = this.runtimeGeneration;
    const cancellationGeneration = this.cancellationGenerations.get(notebook) ?? 0;
    let notebookKey = runtime.notebookKey(notebook.uri);
    if (!notebookKey) throw new Error('This notebook is outside the Pair Notebook working copy.');
    const queueKey = this.queueKeys.get(notebook) ?? notebookKey;
    this.queueKeys.set(notebook, queueKey);
    const onRename = (from: string, to: string) => { if (notebookKey === from) notebookKey = to; };
    runtime.project.on('documentRenamed', onRename);
    try {
    await this.synchronizer?.whenNotebookReady(notebook);
    const requested = cells.map((cell) => ({ cell, id: runtime.notebookCellId(cell) }));
    await this.queues.enqueue(queueKey, async () => {
      for (const item of requested) {
        if (this.runtimeGeneration !== runtimeGeneration
          || (this.cancellationGenerations.get(notebook) ?? 0) !== cancellationGeneration) break;
        // Initial identity repair can replace ambiguous cells. Resolve the live
        // object by stable ID after the queue barrier. A numerical index can
        // point at a different cell after a concurrent move or deletion.
        const cell = item.id
          ? notebook.getCells().find((candidate) => runtime.notebookCellId(candidate) === item.id)
          : notebook.getCells().includes(item.cell) ? item.cell : undefined;
        if (!cell) continue;
        if (cell.kind !== vscode.NotebookCellKind.Code) continue;
        this.activeExecutions.add(cell);
        let success = false;
        try { success = await this.executeCell(runtime, notebookKey!, cell); }
        finally { this.activeExecutions.delete(cell); }
        if (!success) break;
      }
    });
    } finally { runtime.project.off('documentRenamed', onRename); }
  }

  private async executeCell(runtime: SessionRuntime, notebookKey: string, cell: vscode.NotebookCell): Promise<boolean> {
    const onRename = (from: string, to: string) => { if (notebookKey === from) notebookKey = to; };
    runtime.project.on('documentRenamed', onRename);
    try {
    const mirrored = this.mirroredExecutions.get(cell);
    if (mirrored) {
      mirrored.execution.end(undefined);
      this.mirroredExecutions.delete(cell);
    }
    const execution = this.controller.createNotebookCellExecution(cell);
    const cellId = runtime.notebookCellId(cell);
    if (!cellId) {
      execution.start(Date.now());
      await execution.replaceOutput(new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(new Error('Cell collaboration ID is unavailable.')),
      ], { outputType: 'error' }));
      execution.end(false, Date.now());
      return false;
    }
    this.activeExecutionHandles.set(cell, execution);
    const authoritativePublisher = runtime.computeForNotebook(notebookKey).executorId
      === runtime.descriptor.localPeer.peerId;
    execution.start(Date.now());
    await execution.clearOutput();
    if (authoritativePublisher) {
      runtime.project.setCellOutputs(notebookKey, cellId, []);
      runtime.project.setCellExecution(notebookKey, cellId, {});
    }
    const state = createJupyterRenderState();
    const outputTask = new CadencedTask(
      OUTPUT_STATE_CADENCE_MS,
      async () => {
        await execution.replaceOutput([...state.outputs]);
        if (authoritativePublisher) {
          runtime.project.setCellOutputs(notebookKey, cellId, snapshotJupyterOutputs(state));
        }
      },
      (error) => {
        this.log.appendLine(`[error] Deferred Jupyter output render: ${formatError(error)}`);
      },
    );
    let renderQueue = Promise.resolve();
    let pendingRenderEvents = 0;
    let pendingRenderBytes = 0;
    let renderOverflow: Error | undefined;
    let executionRequestId: string | undefined;
    let terminalExecutionPublished = false;
    let success = false;
    const publishTerminalExecution = (terminalSuccess: boolean): void => {
      if (terminalExecutionPublished || !authoritativePublisher) return;
      try {
        if (!runtime.project.hasNotebookCell(notebookKey, cellId)) return;
        runtime.project.setCellExecution(notebookKey, cellId, {
          ...(executionRequestId ? { requestId: executionRequestId } : {}),
          executionOrder: execution.executionOrder,
          success: terminalSuccess,
        });
        terminalExecutionPublished = true;
      } catch (error) {
        this.log.appendLine(`[error] Could not publish terminal Jupyter execution: ${formatError(error)}`);
      }
    };
    try {
      let result: Awaited<ReturnType<SessionRuntime['executeCell']>> | undefined;
      let executionFailure: unknown;
      try {
        result = await runtime.executeCell(notebookKey, cellId, cell.document.getText(), (event) => {
          if (renderOverflow) return;
          const retainedBytes = estimateKernelEventBytes(event);
          if (pendingRenderEvents >= MAX_PENDING_RENDER_EVENTS
            || pendingRenderBytes + retainedBytes > MAX_PENDING_RENDER_BYTES) {
            renderOverflow = new Error('Jupyter display output was truncated because VS Code could not render it fast enough. Computation continues.');
            this.log.appendLine(`[warning] ${renderOverflow.message}`);
            return;
          }
          pendingRenderEvents += 1;
          pendingRenderBytes += retainedBytes;
          renderQueue = renderQueue
            .then(() => this.applyEvent(
              runtime,
              notebookKey,
              execution,
              state,
              event,
              authoritativePublisher,
              executionRequestId,
              outputTask,
            ))
            .finally(() => {
              pendingRenderEvents -= 1;
              pendingRenderBytes -= retainedBytes;
            });
        }, (requestId) => {
          executionRequestId = requestId;
          if (authoritativePublisher) {
            runtime.project.setCellExecution(notebookKey, cellId, { requestId });
          } else {
            this.remoteExecutionRequestIds.set(cell, requestId);
          }
        });
      } catch (error) {
        executionFailure = error;
      }
      let renderFailure: unknown;
      try {
        await renderQueue;
        // Retry the latest complete snapshot even if a prior background render
        // failed after consuming its pending marker.
        outputTask.schedule();
        await outputTask.flush();
      } catch (error) {
        renderFailure = error;
      }
      if (renderOverflow) this.log.appendLine(`[warning] Completed execution with truncated display: ${renderOverflow.message}`);
      if (executionFailure) throw executionFailure;
      if (renderFailure) throw renderFailure;
      if (!result) throw new Error('Jupyter execution ended without a result.');
      success = result.success;
      const failureOperations = appendJupyterFailureToState(state, result);
      if (failureOperations.length) {
        outputTask.schedule();
        await outputTask.flush();
      }
      publishTerminalExecution(success);
    } catch (error) {
      publishTerminalExecution(false);
      const failure = {
        success: false,
        content: {
          ename: error instanceof Error ? error.name : 'Error',
          evalue: error instanceof Error ? error.message : String(error),
          traceback: error instanceof Error ? error.stack : undefined,
        },
      };
      if (appendJupyterFailureToState(state, failure).length) {
        outputTask.schedule();
        try {
          await outputTask.flush();
        } catch (renderError) {
          this.log.appendLine(`[error] Final Jupyter output render: ${formatError(renderError)}`);
        }
      }
      this.log.appendLine(`[error] Jupyter execution: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      outputTask.dispose();
      if (this.activeExecutionHandles.get(cell) === execution) {
        execution.end(success, Date.now());
        this.activeExecutionHandles.delete(cell);
      }
      // Keep the latest remote request identity for this cell after the
      // terminal result. CRDT propagation and executeResult use independent
      // delivery paths, so the authoritative final echo may arrive later.
      // WeakMap keeps this bounded by the lifetime of the NotebookCell; the
      // next remote execution simply replaces the stored request ID.
    }
    return success;
    } finally { runtime.project.off('documentRenamed', onRename); }
  }

  private async applyEvent(
    runtime: SessionRuntime,
    notebookKey: string,
    execution: vscode.NotebookCellExecution,
    state: JupyterRenderState,
    event: JupyterKernelEvent,
    authoritativePublisher: boolean,
    executionRequestId: string | undefined,
    outputTask: CadencedTask,
  ): Promise<void> {
    if (event.type === 'inputRequest') {
      runtime.reportWaitingForInput(notebookKey);
      try {
        const prompt = String(event.content?.prompt ?? 'Input').slice(0, 4_096);
        const value = await vscode.window.showInputBox({
          title: 'Jupyter input',
          prompt,
          password: event.content?.password === true,
          ignoreFocusOut: true,
        });
        if (value === undefined) await runtime.cancelInput(String(event.requestId));
        else {
          try {
            await runtime.replyToInput(String(event.requestId), value);
          } catch (error) {
            await runtime.cancelInput(String(event.requestId));
            throw error;
          }
        }
      } finally {
        runtime.reportInputResolved(notebookKey);
      }
      return;
    }

    const update = applyJupyterEventToState(state, event);
    if (update.executionOrder !== undefined) {
      execution.executionOrder = update.executionOrder;
      if (authoritativePublisher) {
        runtime.project.setCellExecution(
          notebookKey,
          this.requireCellId(runtime, execution.cell),
          {
            ...(executionRequestId ? { requestId: executionRequestId } : {}),
            executionOrder: update.executionOrder,
          },
        );
      }
    }
    if (update.outputsChanged) outputTask.schedule();
  }

  private requireCellId(runtime: SessionRuntime, cell: vscode.NotebookCell): string {
    const cellId = runtime.notebookCellId(cell);
    if (!cellId) throw new Error('Cell collaboration ID became unavailable during execution.');
    return cellId;
  }

  private requireRuntime(): SessionRuntime {
    if (!this.runtime) throw new Error('No active Pair Notebook session.');
    return this.runtime;
  }
}

interface MirroredExecutionState {
  execution: vscode.NotebookCellExecution;
  started: boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
