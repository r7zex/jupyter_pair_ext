type Metadata = Record<string, unknown>;
const object = (value: unknown): Metadata | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Metadata : undefined;

export function nativeNotebookMetadata(value: Metadata): boolean {
  return typeof value.nbformat === 'number' && Array.isArray(value.cells) && !!object(value.metadata);
}

export function hasLegacyNotebookMetadata(value: Metadata): boolean {
  const marker = object(value.pair_crdt) ?? object(object(value.metadata)?.pair_crdt);
  return nativeNotebookMetadata(value) && typeof marker?.epoch === 'string' && typeof marker.update === 'string';
}

export function notebookUserMetadata(value: Metadata): Metadata {
  const custom = object(value.custom);
  let metadata = object(custom?.metadata) ?? (nativeNotebookMetadata(value) ? object(value.metadata)! : value);
  // Old clients copied the native serializer envelope, including its CRDT state.
  for (let depth = 0; hasLegacyNotebookMetadata(metadata); depth++) {
    if (depth >= 32) throw new Error('Notebook metadata nesting exceeds the supported repair limit. The local replica must be preserved.');
    metadata = object(metadata.metadata)!;
  }
  const result = { ...metadata }; delete result.pair_crdt; delete result.pairNotebookServerEpoch;
  return result;
}

export function cellUserMetadata(value: Metadata, native: boolean): Metadata {
  const result = { ...(object(object(value.custom)?.metadata) ?? (native ? object(value.metadata) ?? {} : value)) };
  delete result.pairNotebookCellId; return result;
}
