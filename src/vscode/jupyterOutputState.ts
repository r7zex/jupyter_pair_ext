import * as vscode from 'vscode';
import type { OutputSnapshot } from '../core/crdt';
import type { JupyterExecutionResult, JupyterKernelEvent } from '../core/pythonKernel';

export const MAX_RENDERED_CELL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_RENDERED_CELL_OUTPUTS = 1_024;
const MAX_MIME_ITEMS_PER_OUTPUT = 64;

export interface JupyterRenderState {
  outputs: vscode.NotebookCellOutput[];
  displays: Map<string, { output: vscode.NotebookCellOutput }>;
  clearBeforeNext: boolean;
  outputBytes: number;
  outputLimitReached: boolean;
  executionOrder?: number | undefined;
}

export type JupyterOutputOperation =
  | { type: 'clear' }
  | { type: 'append'; output: vscode.NotebookCellOutput }
  | {
    type: 'replaceItems';
    output: vscode.NotebookCellOutput;
    items: vscode.NotebookCellOutputItem[];
  };

export interface JupyterEventStateUpdate {
  operations: JupyterOutputOperation[];
  outputsChanged: boolean;
  executionOrder?: number | undefined;
}

export function createJupyterRenderState(): JupyterRenderState {
  return {
    outputs: [],
    displays: new Map(),
    clearBeforeNext: false,
    outputBytes: 0,
    outputLimitReached: false,
    executionOrder: undefined,
  };
}

export function applyJupyterEventToState(
  state: JupyterRenderState,
  event: JupyterKernelEvent,
): JupyterEventStateUpdate {
  const operations: JupyterOutputOperation[] = [];
  if (event.type !== 'iopub') return { operations, outputsChanged: false };
  const content = event.content ?? {};

  if (event.messageType === 'execute_input') {
    const count = Number(content.execution_count);
    if (!Number.isFinite(count)) return { operations, outputsChanged: false };
    state.executionOrder = count;
    return { operations, outputsChanged: false, executionOrder: count };
  }

  if (event.messageType === 'clear_output') {
    if (content.wait === true) {
      state.clearBeforeNext = true;
      return { operations, outputsChanged: false };
    }
    resetOutputs(state);
    operations.push({ type: 'clear' });
    return { operations, outputsChanged: true };
  }

  if (!['stream', 'display_data', 'execute_result', 'error', 'update_display_data']
    .includes(event.messageType ?? '')) {
    return { operations, outputsChanged: false };
  }

  let outputsChanged = false;
  if (state.clearBeforeNext) {
    state.clearBeforeNext = false;
    resetOutputs(state);
    operations.push({ type: 'clear' });
    outputsChanged = true;
  }

  if (event.messageType === 'update_display_data') {
    const displayId = displayIdOf(content);
    const existing = displayId ? state.displays.get(displayId) : undefined;
    if (!existing) return { operations, outputsChanged };
    const items = outputItems(content.data, event.buffersBase64);
    const metadata = outputMetadata('display_data', content);
    const nextBytes = state.outputBytes - notebookOutputBytes(existing.output)
      + notebookOutputPartsBytes(items, metadata);
    if (nextBytes > MAX_RENDERED_CELL_OUTPUT_BYTES) {
      const notice = appendOutputLimitNotice(state);
      if (notice) {
        operations.push({ type: 'append', output: notice });
        outputsChanged = true;
      }
      return { operations, outputsChanged };
    }
    existing.output.items = items;
    existing.output.metadata = metadata;
    state.outputBytes = nextBytes;
    operations.push({ type: 'replaceItems', items, output: existing.output });
    return { operations, outputsChanged: true };
  }

  const output = event.messageType === 'stream'
    ? streamOutput(content)
    : event.messageType === 'error'
      ? errorOutput(
        String(content.ename ?? 'Error'),
        String(content.evalue ?? ''),
        content.traceback,
      )
      : new vscode.NotebookCellOutput(
        outputItems(content.data, event.buffersBase64),
        outputMetadata(event.messageType ?? 'display_data', content),
      );

  const appended = appendBoundedOutput(state, output);
  if (appended === output) {
    operations.push({ type: 'append', output });
    outputsChanged = true;
    const displayId = displayIdOf(content);
    if (displayId) state.displays.set(displayId, { output });
  } else if (appended) {
    operations.push({ type: 'append', output: appended });
    outputsChanged = true;
  }
  return { operations, outputsChanged };
}

export function appendJupyterFailureToState(
  state: JupyterRenderState,
  result: Pick<JupyterExecutionResult, 'success' | 'content'>,
): JupyterOutputOperation[] {
  if (result.success || state.outputs.some((output) => output.metadata?.outputType === 'error')) return [];
  const content = result.content;
  const output = errorOutput(
    String(content.ename ?? 'JupyterError'),
    String(content.evalue ?? 'Execution failed'),
    content.traceback,
  );
  const appended = appendBoundedOutput(state, output);
  return appended ? [{ type: 'append', output: appended }] : [];
}

export function snapshotJupyterOutputs(state: JupyterRenderState): OutputSnapshot[] {
  return state.outputs.map(snapshotOutput);
}

export function snapshotOutput(output: vscode.NotebookCellOutput): OutputSnapshot {
  return {
    metadata: output.metadata,
    items: output.items.map((item) => ({
      mime: item.mime,
      dataBase64: Buffer.from(item.data).toString('base64'),
    })),
  };
}

export function estimateKernelEventBytes(event: JupyterKernelEvent): number {
  const limit = 32 * 1024 * 1024;
  try {
    return Math.min(limit + 1, Buffer.byteLength(JSON.stringify(event), 'utf8') + 1024);
  } catch {
    return limit + 1;
  }
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

function appendBoundedOutput(
  state: JupyterRenderState,
  output: vscode.NotebookCellOutput,
): vscode.NotebookCellOutput | undefined {
  const bytes = notebookOutputBytes(output);
  if (state.outputs.length >= MAX_RENDERED_CELL_OUTPUTS - 1
    || state.outputBytes + bytes > MAX_RENDERED_CELL_OUTPUT_BYTES) {
    return appendOutputLimitNotice(state);
  }
  state.outputs.push(output);
  state.outputBytes += bytes;
  return output;
}

function appendOutputLimitNotice(state: JupyterRenderState): vscode.NotebookCellOutput | undefined {
  if (state.outputLimitReached) return undefined;
  state.outputLimitReached = true;
  const notice = streamOutput({
    name: 'stderr',
    text: `\n[Pair Notebook] Output was truncated after ${MAX_RENDERED_CELL_OUTPUT_BYTES} bytes or ${MAX_RENDERED_CELL_OUTPUTS} output blocks.\n`,
  });
  state.outputs.push(notice);
  state.outputBytes += notebookOutputBytes(notice);
  return notice;
}

function resetOutputs(state: JupyterRenderState): void {
  state.outputs = [];
  state.displays.clear();
  state.outputBytes = 0;
  state.outputLimitReached = false;
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
  return new vscode.NotebookCellOutput(
    [vscode.NotebookCellOutputItem.error(error)],
    { outputType: 'error' },
  );
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
        const text = Array.isArray(value)
          ? value.join('')
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
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

function notebookOutputBytes(output: vscode.NotebookCellOutput): number {
  return notebookOutputPartsBytes(output.items, output.metadata);
}

function notebookOutputPartsBytes(
  items: readonly vscode.NotebookCellOutputItem[],
  metadata: Record<string, unknown> | undefined,
): number {
  let bytes = items.reduce(
    (total, item) => total + item.data.byteLength + Buffer.byteLength(item.mime, 'utf8'),
    0,
  );
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
