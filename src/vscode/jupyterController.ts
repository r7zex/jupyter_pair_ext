import * as vscode from 'vscode';
import { CellExecutionSnapshot } from '../core/crdt';
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
  type JupyterOutputOperation,
  type JupyterRenderState,
} from './jupyterOutputState';

export { decodeJupyterBase64 } from './jupyterOutputState';

const MAX_PENDING_RENDER_EVENTS = 2_048;
const MAX_PENDING_RENDER_BYTES = 32 * 1024 * 1024;

export class PairNotebookController implements vscode.Disposable, NotebookCellStateRenderer {
  private readonly controller: vscode.NotebookController;
  private runtime: SessionRuntime | undefined;
  private synchronizer: EditorSynchronizer | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queues = new PerNotebookExecutionQueue();
  private readonly mirroredExecutions = new Map<vscode.NotebookCell, MirroredExecutionState>();
  private remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();

  public constructor(private readonly log: vscode.OutputChannel) {
    this.controller = vscode.notebooks.createNotebookController(
      'pair-notebook-jupyter',
      'jupyter-notebook',
      'Pair Notebook • Jupyter',
      (cells, notebook) => this.execute(cells, notebook),
    );
    this.controller.supportedLanguages = ['python'];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = 'Real Jupyter kernel on the selected Pair Notebook compute target';
    this.controller.interruptHandler = async (notebook) => {
      const runtime = this.requireRuntime();
      const key = runtime.notebookKey(notebook.uri);
      if (key) await runtime.interruptNotebook(key);
    };
    const claim = (notebook: vscode.NotebookDocument) => {
      if (this.runtime?.notebookKey(notebook.uri)) {
        // VS Code exposes Preferred as its strongest NotebookController
        // affinity. All Pair commands route through this controller; native
        // kernels are never used by Pair's execution/output protocol.
        this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
      }
    };
    this.disposables.push(
      this.controller,
      vscode.workspace.onDidOpenNotebookDocument(claim),
    );
  }

  public setRuntime(runtime: SessionRuntime | undefined): void {
    if (!runtime) {
      this.finishMirroredExecutions();
      this.remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();
    }
    this.runtime = runtime;
    if (runtime) for (const notebook of vscode.workspace.notebookDocuments) {
      if (runtime.notebookKey(notebook.uri)) {
        this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
      }
    }
  }

  public setSynchronizer(synchronizer: EditorSynchronizer | undefined): void {
    this.synchronizer = synchronizer;
  }

  public async restartActive(): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) throw new Error('Open a Pair Notebook notebook first.');
    const runtime = this.requireRuntime();
    const key = runtime.notebookKey(editor.notebook.uri);
    if (!key) throw new Error('The active notebook is outside the Pair Notebook working copy.');
    await runtime.restartNotebook(key);
  }

  public dispose(): void {
    this.finishMirroredExecutions();
    this.remoteExecutionRequestIds = new WeakMap<vscode.NotebookCell, string>();
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
    if (!request.outputsChanged && !request.executionChanged) return;
    const target: CellExecutionSnapshot | undefined = request.execution;
    const liveRequestId = this.remoteExecutionRequestIds.get(cell);
    if (liveRequestId && target?.requestId === liveRequestId) {
      // The initiator already rendered these live events through its local
      // NotebookCellExecution. The CRDT copy is the authoritative echo for the
      // same execution identity and must not be applied a second time.
      return;
    }
    let state = this.mirroredExecutions.get(cell);
    if (!state) {
      state = {
        execution: this.controller.createNotebookCellExecution(cell),
        started: false,
      };
      this.mirroredExecutions.set(cell, state);
    }

    if (request.executionChanged) {
      state.execution.executionOrder = target?.executionOrder;
    } else if (target?.executionOrder !== undefined) {
      state.execution.executionOrder = target.executionOrder;
    }

    if (target && !state.started) {
      state.execution.start(target.timing?.startTime);
      state.started = true;
    }

    if (request.outputsChanged) {
      await state.execution.replaceOutput(request.outputs);
    }

    const liveRunning = request.executionMode === 'live'
      && target !== undefined
      && target.success === undefined;
    if (liveRunning) return;

    if (!state.started) {
      state.execution.start(target?.timing?.startTime);
      state.started = true;
    }
    state.execution.end(target?.success, target?.timing?.endTime);
    this.mirroredExecutions.delete(cell);
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

  private async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    const runtime = this.requireRuntime();
    const notebookKey = runtime.notebookKey(notebook.uri);
    if (!notebookKey) throw new Error('This notebook is outside the Pair Notebook working copy.');
    await this.synchronizer?.whenNotebookReady(notebook);
    const requested = cells.map((cell) => ({ cell, id: runtime.notebookCellId(cell) }));
    await this.queues.enqueue(notebookKey, async () => {
      for (const item of requested) {
        // Initial identity repair can replace ambiguous cells. Resolve the live
        // object by stable ID after the queue barrier. A numerical index can
        // point at a different cell after a concurrent move or deletion.
        const cell = item.id
          ? notebook.getCells().find((candidate) => runtime.notebookCellId(candidate) === item.id)
          : notebook.getCells().includes(item.cell) ? item.cell : undefined;
        if (!cell) continue;
        if (cell.kind !== vscode.NotebookCellKind.Code) continue;
        await this.executeCell(runtime, notebookKey, cell);
      }
    });
  }

  private async executeCell(runtime: SessionRuntime, notebookKey: string, cell: vscode.NotebookCell): Promise<void> {
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
      return;
    }
    const authoritativePublisher = runtime.computeForNotebook(notebookKey).executorId
      === runtime.descriptor.localPeer.peerId;
    execution.start(Date.now());
    await execution.clearOutput();
    if (authoritativePublisher) {
      runtime.project.setCellOutputs(notebookKey, cellId, []);
      runtime.project.setCellExecution(notebookKey, cellId, {});
    }
    const state = createJupyterRenderState();
    let renderQueue = Promise.resolve();
    let pendingRenderEvents = 0;
    let pendingRenderBytes = 0;
    let renderOverflow: Error | undefined;
    let executionRequestId: string | undefined;
    let success = false;
    try {
      let result: Awaited<ReturnType<SessionRuntime['executeCell']>> | undefined;
      let executionFailure: unknown;
      try {
        result = await runtime.executeCell(notebookKey, cellId, cell.document.getText(), (event) => {
          if (renderOverflow) return;
          const retainedBytes = estimateKernelEventBytes(event);
          if (pendingRenderEvents >= MAX_PENDING_RENDER_EVENTS
            || pendingRenderBytes + retainedBytes > MAX_PENDING_RENDER_BYTES) {
            renderOverflow = new Error('Jupyter output arrived faster than VS Code could render it and was interrupted.');
            void runtime.interruptNotebook(notebookKey).catch((error) => {
              this.log.appendLine(`[error] Jupyter overflow interrupt: ${formatError(error)}`);
            });
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
      } catch (error) {
        renderFailure = error;
      }
      if (renderOverflow) throw renderOverflow;
      if (executionFailure) throw executionFailure;
      if (renderFailure) throw renderFailure;
      if (!result) throw new Error('Jupyter execution ended without a result.');
      success = result.success;
      const failureOperations = appendJupyterFailureToState(state, result);
      await this.applyOutputOperations(execution, failureOperations);
      if (authoritativePublisher) {
        runtime.project.setCellOutputs(notebookKey, cellId, snapshotJupyterOutputs(state));
        runtime.project.setCellExecution(notebookKey, cellId, {
          ...(executionRequestId ? { requestId: executionRequestId } : {}),
          executionOrder: execution.executionOrder,
          success,
        });
      }
    } catch (error) {
      const failure = {
        success: false,
        content: {
          ename: error instanceof Error ? error.name : 'Error',
          evalue: error instanceof Error ? error.message : String(error),
          traceback: error instanceof Error ? error.stack : undefined,
        },
      };
      await this.applyOutputOperations(execution, appendJupyterFailureToState(state, failure));
      if (authoritativePublisher) {
        runtime.project.setCellOutputs(notebookKey, cellId, snapshotJupyterOutputs(state));
      }
      this.log.appendLine(`[error] Jupyter execution: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      execution.end(success, Date.now());
      // Keep the latest remote request identity for this cell after the
      // terminal result. CRDT propagation and executeResult use independent
      // delivery paths, so the authoritative final echo may arrive later.
      // WeakMap keeps this bounded by the lifetime of the NotebookCell; the
      // next remote execution simply replaces the stored request ID.
    }
  }

  private async applyEvent(
    runtime: SessionRuntime,
    notebookKey: string,
    execution: vscode.NotebookCellExecution,
    state: JupyterRenderState,
    event: JupyterKernelEvent,
    authoritativePublisher: boolean,
    executionRequestId: string | undefined,
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
    await this.applyOutputOperations(execution, update.operations);
    if (authoritativePublisher && update.outputsChanged) {
      runtime.project.setCellOutputs(
        notebookKey,
        this.requireCellId(runtime, execution.cell),
        snapshotJupyterOutputs(state),
      );
    }
  }

  private async applyOutputOperations(
    execution: vscode.NotebookCellExecution,
    operations: readonly JupyterOutputOperation[],
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.type === 'clear') {
        await execution.clearOutput();
      } else if (operation.type === 'append') {
        await execution.appendOutput(operation.output);
      } else {
        await execution.replaceOutputItems(operation.items, operation.output);
      }
    }
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
