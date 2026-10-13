type JsonObject = Record<string, unknown>;
export type PersistentNotebookOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { output_type: 'display_data'; data: JsonObject; metadata: JsonObject }
  | { output_type: 'execute_result'; data: JsonObject; metadata: JsonObject; execution_count: number | null }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const count = (value: unknown): number | null | undefined => value === null ? null : Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value
  : Array.isArray(value) && value.every((line) => typeof line === 'string') ? value.join('') : undefined;

/** Reduce bridge events to nbformat outputs without retaining transport-only fields. */
export function persistentNotebookOutputs(events: readonly JsonObject[]): { outputs: PersistentNotebookOutput[]; executionCount: number | null } {
  const outputs: PersistentNotebookOutput[] = [];
  const displays = new Map<string, Extract<PersistentNotebookOutput, { output_type: 'display_data' | 'execute_result' }>[]>();
  let clearPending = false; let executionCount: number | null = null;
  const clear = (): void => { outputs.length = 0; displays.clear(); clearPending = false; };
  const append = (output: PersistentNotebookOutput): void => {
    if (clearPending) clear();
    const previous = outputs.at(-1);
    if (output.output_type === 'stream' && previous?.output_type === 'stream' && previous.name === output.name) previous.text += output.text;
    else outputs.push(output);
  };
  for (const event of events) {
    if (event.type === 'complete') {
      const value = count(event.executionCount); if (value !== undefined) executionCount = value;
      continue;
    }
    if (event.type === 'channelError') {
      const message = typeof event.message === 'string' ? event.message : 'Jupyter output was omitted by the transport limit.';
      append({ output_type: 'stream', name: 'stderr', text: `Pair Notebook: ${message}${message.endsWith('\n') ? '' : '\n'}` });
      continue;
    }
    const content = object(event.content);
    if (event.type !== 'iopub' || !content) continue;
    if (event.messageType === 'clear_output') {
      if (content.wait === true) clearPending = true; else clear();
    } else if (event.messageType === 'stream') {
      const value = text(content.text);
      if (value !== undefined && (content.name === 'stdout' || content.name === 'stderr')) append({ output_type: 'stream', name: content.name, text: value });
    } else if (event.messageType === 'display_data' || event.messageType === 'execute_result' || event.messageType === 'update_display_data') {
      const data = object(content.data) ?? {}; const metadata = object(content.metadata) ?? {};
      const displayId = object(content.transient)?.display_id;
      if (event.messageType === 'update_display_data') {
        // Updating an existing display does not append a replacement for deferred clear.
        if (typeof displayId === 'string') for (const output of displays.get(displayId) ?? []) { output.data = data; output.metadata = metadata; }
        continue;
      }
      const value = count(content.execution_count);
      const output: Extract<PersistentNotebookOutput, { output_type: 'display_data' | 'execute_result' }> = event.messageType === 'display_data'
        ? { output_type: 'display_data', data, metadata }
        : { output_type: 'execute_result', data, metadata, execution_count: value ?? null };
      if (event.messageType === 'execute_result' && value !== undefined) executionCount = value;
      append(output);
      if (typeof displayId === 'string') displays.set(displayId, [...displays.get(displayId) ?? [], output]);
    } else if (event.messageType === 'error') {
      append({ output_type: 'error', ename: typeof content.ename === 'string' ? content.ename : 'Error',
        evalue: typeof content.evalue === 'string' ? content.evalue : '',
        traceback: Array.isArray(content.traceback) ? content.traceback.filter((line): line is string => typeof line === 'string') : [] });
    }
  }
  return { outputs, executionCount };
}
