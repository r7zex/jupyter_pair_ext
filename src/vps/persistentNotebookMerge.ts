type JsonObject = Record<string, unknown>;

function record(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): unknown { return Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join('') : value; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function sourceView(notebook: JsonObject): JsonObject {
  return { ...notebook, cells: (notebook.cells as JsonObject[]).map((cell) => {
    const result: JsonObject = { ...cell, source: text(cell.source) };
    delete result.outputs;
    delete result.execution_count;
    return result;
  }) };
}
function outputView(cell: JsonObject): JsonObject {
  return {
    execution_count: cell.execution_count ?? null,
    outputs: Array.isArray(cell.outputs) ? cell.outputs.map((output: unknown) => {
      if (!record(output)) return output;
      const normalized = { ...output };
      if ('text' in normalized) normalized.text = text(normalized.text);
      if (record(normalized.data)) normalized.data = Object.fromEntries(Object.entries(normalized.data).map(([mime, value]) => [mime, mime === 'application/json' ? value : text(value)]));
      return normalized;
    }) : [],
  };
}
function parse(bytes: Uint8Array): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return record(value) && Array.isArray(value.cells) && value.cells.every(record) ? value : undefined;
  } catch { return undefined; }
}

/** Merge output-only server changes without acknowledging somebody else's source or metadata edits. */
export function mergePersistentNotebookOutputs(baseline: Uint8Array, desired: Uint8Array, latest: Uint8Array): Uint8Array | undefined {
  const base = parse(baseline), local = parse(desired), remote = parse(latest);
  if (!base || !local || !remote || !equal(sourceView(base), sourceView(remote))) return undefined;
  const baseCells = base.cells as JsonObject[], localCells = local.cells as JsonObject[], remoteCells = remote.cells as JsonObject[];
  const ids = baseCells.map((cell) => cell.id);
  const stableIds = ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length;
  if (!stableIds && (localCells.length !== baseCells.length || localCells.some((cell, index) => cell.cell_type !== baseCells[index]?.cell_type))) return undefined;
  for (let index = 0; index < localCells.length; index++) {
    const cell = localCells[index]!;
    const baseIndex = stableIds ? typeof cell.id === 'string' ? ids.indexOf(cell.id) : -1 : index;
    if (baseIndex < 0) continue;
    const original = baseCells[baseIndex]!, current = remoteCells[baseIndex]!;
    const localOutput = outputView(cell), baseOutput = outputView(original), remoteOutput = outputView(current);
    if (equal(localOutput, baseOutput)) {
      if ('outputs' in current) cell.outputs = current.outputs; else delete cell.outputs;
      if ('execution_count' in current) cell.execution_count = current.execution_count; else delete cell.execution_count;
    } else if (!equal(remoteOutput, baseOutput) && !equal(localOutput, remoteOutput)) {
      return undefined;
    }
  }
  return Buffer.from(JSON.stringify(local));
}
