import type { SharedCell } from '../vps/persistentNotebookCrdt';
import { nativeNotebookMetadata } from '../core/notebookMetadata';

type Metadata = Record<string, unknown>;
const object = (value: unknown): Metadata | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Metadata : undefined;

export { nativeNotebookMetadata, hasLegacyNotebookMetadata, notebookUserMetadata, cellUserMetadata } from '../core/notebookMetadata';

export function renderedNotebookMetadata(original: Metadata, metadata: Metadata): Metadata {
  if (nativeNotebookMetadata(original)) return { ...original, cells: [], metadata };
  if (object(original.custom)?.metadata) return { ...original, custom: { ...object(original.custom), metadata } };
  return metadata;
}

export function renderedCellMetadata(original: Metadata, cell: SharedCell, native: boolean): Metadata {
  if (native) return { ...original, id: cell.id, metadata: cell.metadata };
  if (object(original.custom)?.metadata) return { ...original, custom: { ...object(original.custom), metadata: cell.metadata }, pairNotebookCellId: cell.id };
  return { ...cell.metadata, pairNotebookCellId: cell.id };
}
