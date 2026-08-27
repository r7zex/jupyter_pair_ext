import * as vscode from 'vscode';
import { OutputSnapshot } from '../core/crdt';
import { PerNotebookExecutionQueue } from '../core/executionQueue';
import { JupyterKernelEvent } from '../core/pythonKernel';
import { SessionRuntime } from '../runtime/session';
import { EditorSynchronizer } from './sync';

const MAX_RENDERED_CELL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RENDERED_CELL_OUTPUTS = 1_024;
const MAX_MIME_ITEMS_PER_OUTPUT = 64;
const MAX_PENDING_RENDER_EVENTS = 2_048;
const MAX_PENDING_RENDER_BYTES = 32 * 1024 * 1024;

export class PairNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private runtime: SessionRuntime | undefined;
  private synchronizer: EditorSynchronizer | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queues = new PerNotebookExecutionQueue();

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
    const prefer = (notebook: vscode.NotebookDocument) => {
      if (this.runtime?.notebookKey(notebook.uri)) {
        this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
      }
    };
    this.disposables.push(
      this.controller,
      vscode.workspace.onDidOpenNotebookDocument(prefer),
    );
  }

  public setRuntime(runtime: SessionRuntime | undefined): void {
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
    for (const disposable of this.disposables) disposable.dispose();
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
    execution.start(Date.now());
    await execution.clearOutput();
    runtime.project.setCellOutputs(notebookKey, cellId, []);
    const state: RenderState = {
      outputs: [],
      displays: new Map(),
      clearBeforeNext: false,
      outputBytes: 0,
      outputLimitReached: false,
    };
    let renderQueue = Promise.resolve();
    let pendingRenderEvents = 0;
    let pendingRenderBytes = 0;
    let renderOverflow: Error | undefined;
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
            .then(() => this.applyEvent(runtime, notebookKey, execution, state, event))
            .finally(() => {
              pendingRenderEvents -= 1;
              pendingRenderBytes -= retainedBytes;
            });
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
      if (!result.success && !state.outputs.some((output) => output.metadata?.outputType === 'error')) {
        const content = result.content;
        const error = errorOutput(String(content.ename ?? 'JupyterError'), String(content.evalue ?? 'Execution failed'), content.traceback);
        await this.appendBoundedOutput(execution, state, error);
      }
      runtime.project.setCellOutputs(notebookKey, cellId, state.outputs.map(snapshotOutput));
      runtime.project.setCellExecution(notebookKey, cellId, {
        executionOrder: execution.executionOrder,
        success,
      });
    } catch (error) {
      const output = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(error instanceof Error ? error : new Error(String(error))),
      ], { outputType: 'error' });
      await this.appendBoundedOutput(execution, state, output);
      runtime.project.setCellOutputs(notebookKey, cellId, state.outputs.map(snapshotOutput));
      this.log.appendLine(`[error] Jupyter execution: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      execution.end(success, Date.now());
    }
  }

  private async applyEvent(
    runtime: SessionRuntime,
    notebookKey: string,
    execution: vscode.NotebookCellExecution,
    state: RenderState,
    event: JupyterKernelEvent,
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
    if (event.type !== 'iopub') return;
    const content = event.content ?? {};
    if (event.messageType === 'execute_input') {
      const count = Number(content.execution_count);
      if (Number.isFinite(count)) {
        execution.executionOrder = count;
        runtime.project.setCellExecution(notebookKey, this.requireCellId(runtime, execution.cell), { executionOrder: count });
      }
      return;
    }
    if (event.messageType === 'clear_output') {
      if (content.wait === true) state.clearBeforeNext = true;
      else {
        state.outputs = [];
        state.displays.clear();
        state.outputBytes = 0;
        state.outputLimitReached = false;
        await execution.clearOutput();
        this.publishOutputs(runtime, notebookKey, execution.cell, state);
      }
      return;
    }
    if (!['stream', 'display_data', 'execute_result', 'error', 'update_display_data'].includes(event.messageType ?? '')) return;
    if (state.clearBeforeNext) {
      state.clearBeforeNext = false;
      state.outputs = [];
      state.displays.clear();
      state.outputBytes = 0;
      state.outputLimitReached = false;
      await execution.clearOutput();
    }
    if (event.messageType === 'update_display_data') {
      const displayId = displayIdOf(content);
      const existing = displayId ? state.displays.get(displayId) : undefined;
      if (existing) {
        const items = outputItems(content.data, event.buffersBase64);
        const metadata = outputMetadata('display_data', content);
        const nextBytes = state.outputBytes - notebookOutputBytes(existing.output)
          + notebookOutputPartsBytes(items, metadata);
        if (nextBytes > MAX_RENDERED_CELL_OUTPUT_BYTES) {
          await this.appendOutputLimitNotice(execution, state);
          this.publishOutputs(runtime, notebookKey, execution.cell, state);
          return;
        }
        existing.output.items = items;
        existing.output.metadata = metadata;
        state.outputBytes = nextBytes;
        await execution.replaceOutputItems(items, existing.output);
        this.publishOutputs(runtime, notebookKey, execution.cell, state);
      }
      return;
    }
    const output = event.messageType === 'stream'
      ? streamOutput(content)
      : event.messageType === 'error'
        ? errorOutput(String(content.ename ?? 'Error'), String(content.evalue ?? ''), content.traceback)
        : new vscode.NotebookCellOutput(
          outputItems(content.data, event.buffersBase64),
          outputMetadata(event.messageType ?? 'display_data', content),
        );
    if (!await this.appendBoundedOutput(execution, state, output)) {
      this.publishOutputs(runtime, notebookKey, execution.cell, state);
      return;
    }
    const displayId = displayIdOf(content);
    if (displayId) state.displays.set(displayId, { output });
    this.publishOutputs(runtime, notebookKey, execution.cell, state);
  }

  private async appendBoundedOutput(
    execution: vscode.NotebookCellExecution,
    state: RenderState,
    output: vscode.NotebookCellOutput,
  ): Promise<boolean> {
    const bytes = notebookOutputBytes(output);
    if (state.outputs.length >= MAX_RENDERED_CELL_OUTPUTS - 1
      || state.outputBytes + bytes > MAX_RENDERED_CELL_OUTPUT_BYTES) {
      await this.appendOutputLimitNotice(execution, state);
      return false;
    }
    state.outputs.push(output);
    state.outputBytes += bytes;
    await execution.appendOutput(output);
    return true;
  }

  private async appendOutputLimitNotice(
    execution: vscode.NotebookCellExecution,
    state: RenderState,
  ): Promise<void> {
    if (state.outputLimitReached) return;
    state.outputLimitReached = true;
    const notice = streamOutput({
      name: 'stderr',
      text: `\n[Pair Notebook] Output was truncated after ${MAX_RENDERED_CELL_OUTPUT_BYTES} bytes or ${MAX_RENDERED_CELL_OUTPUTS} output blocks.\n`,
    });
    state.outputs.push(notice);
    state.outputBytes += notebookOutputBytes(notice);
    await execution.appendOutput(notice);
  }

  private publishOutputs(
    runtime: SessionRuntime,
    notebookKey: string,
    cell: vscode.NotebookCell,
    state: RenderState,
  ): void {
    const cellId = runtime.notebookCellId(cell);
    if (cellId) runtime.project.setCellOutputs(notebookKey, cellId, state.outputs.map(snapshotOutput));
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

interface RenderState {
  outputs: vscode.NotebookCellOutput[];
  displays: Map<string, { output: vscode.NotebookCellOutput }>;
  clearBeforeNext: boolean;
  outputBytes: number;
  outputLimitReached: boolean;
}

function streamOutput(content: Record<string, any>): vscode.NotebookCellOutput {
  const name = content.name === 'stderr' ? 'stderr' : 'stdout';
  const item = name === 'stderr'
    ? vscode.NotebookCellOutputItem.stderr(String(content.text ?? ''))
    : vscode.NotebookCellOutputItem.stdout(String(content.text ?? ''));
  return new vscode.NotebookCellOutput([item], { outputType: 'stream', name });
}

function errorOutput(name: string, message: string, traceback: unknown): vscode.NotebookCellOutput {
  const error = new Error(message);
  error.name = name;
  if (Array.isArray(traceback)) error.stack = traceback.join('\n');
  else if (typeof traceback === 'string') error.stack = traceback;
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(error)], { outputType: 'error' });
}

function outputItems(raw: unknown, buffersBase64: readonly string[] = []): vscode.NotebookCellOutputItem[] {
  const items: vscode.NotebookCellOutputItem[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [mime, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_MIME_ITEMS_PER_OUTPUT)) {
      if (!isSafeMime(mime)) continue;
      if (isBase64Mime(mime) && (typeof value === 'string' || Array.isArray(value))) {
        const decoded = decodeJupyterBase64(value);
        if (decoded) items.push(new vscode.NotebookCellOutputItem(decoded, mime));
        else items.push(vscode.NotebookCellOutputItem.text(
          `[Pair Notebook] Invalid or oversized ${mime} output was omitted.`,
        ));
      } else if (mime === 'application/json' || mime.endsWith('+json')) {
        items.push(vscode.NotebookCellOutputItem.json(value, mime));
      } else {
        const text = Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : JSON.stringify(value);
        items.push(vscode.NotebookCellOutputItem.text(text, mime));
      }
    }
  }
  for (const buffer of buffersBase64.slice(0, 16)) {
    items.push(new vscode.NotebookCellOutputItem(
      Buffer.from(buffer, 'base64'),
      'application/vnd.pair-notebook.jupyter-buffer',
    ));
  }
  return items.length ? items : [vscode.NotebookCellOutputItem.text('')];
}

function isBase64Mime(mime: string): boolean {
  return mime === 'application/pdf'
    || /^image\/(?:png|jpe?g|gif|webp|bmp|tiff|avif|x-icon)$/i.test(mime);
}

export function decodeJupyterBase64(value: unknown): Buffer | undefined {
  const parts = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every((part) => typeof part === 'string')
      ? value as string[]
      : undefined;
  if (!parts) return undefined;
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > Math.ceil(MAX_RENDERED_CELL_OUTPUT_BYTES * 4 / 3) + 4 || length % 4 !== 0) return undefined;
  const encoded = parts.join('');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded ? decoded : undefined;
}

function outputMetadata(
  outputType: string,
  content: Record<string, any>,
): Record<string, any> {
  const metadata = content.metadata && typeof content.metadata === 'object' && !Array.isArray(content.metadata)
    ? content.metadata
    : {};
  return {
    ...metadata,
    outputType,
    executionCount: content.execution_count ?? null,
    transient: content.transient ?? {},
  };
}

function displayIdOf(content: Record<string, any>): string | undefined {
  const value = content.transient?.display_id;
  return typeof value === 'string' && value ? value : undefined;
}

function snapshotOutput(output: vscode.NotebookCellOutput): OutputSnapshot {
  return {
    metadata: output.metadata,
    items: output.items.map((item) => ({ mime: item.mime, dataBase64: Buffer.from(item.data).toString('base64') })),
  };
}

function notebookOutputBytes(output: vscode.NotebookCellOutput): number {
  return notebookOutputPartsBytes(output.items, output.metadata);
}

function notebookOutputPartsBytes(
  items: readonly vscode.NotebookCellOutputItem[],
  metadata: Record<string, unknown> | undefined,
): number {
  let bytes = items.reduce((total, item) => total + item.data.byteLength + Buffer.byteLength(item.mime, 'utf8'), 0);
  try {
    bytes += Buffer.byteLength(JSON.stringify(metadata ?? {}), 'utf8');
  } catch {
    bytes += MAX_RENDERED_CELL_OUTPUT_BYTES;
  }
  return bytes;
}

function isSafeMime(value: string): boolean {
  return value.length >= 3 && value.length <= 256 && value.includes('/') && /^[\x21-\x7e]+$/.test(value);
}

function estimateKernelEventBytes(event: JupyterKernelEvent): number {
  try {
    return Math.min(MAX_PENDING_RENDER_BYTES + 1, Buffer.byteLength(JSON.stringify(event), 'utf8') + 1024);
  } catch {
    return MAX_PENDING_RENDER_BYTES + 1;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
