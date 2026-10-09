import path from 'node:path';
import type * as vscode from 'vscode';
import {
  MAX_CELL_OUTPUT_JSON_BYTES,
  MAX_CELL_OUTPUTS,
  MAX_NOTEBOOK_CELLS,
  MAX_OUTPUT_ITEMS_PER_CELL,
  type NotebookSnapshot,
} from '../core/crdt';
import { metadataCellId } from '../core/notebookIdentity';
import { portableRelativePath } from '../core/projectPath';
import {
  MAX_COLLABORATIVE_DOCUMENT_BYTES,
  normalizeNotebookMetadata,
  serializeIpynb,
  shouldTrackProjectPath,
  type ProjectWorkingCopyFile,
} from '../core/projectFiles';
import { newId } from '../core/types';

/** Preserve the host's unsaved buffers without saving or changing the source repository. */
export function captureInitialWorkingCopy(
  backingFolder: string,
  textDocuments: readonly vscode.TextDocument[],
  notebookDocuments: readonly vscode.NotebookDocument[],
): ProjectWorkingCopyFile[] {
  const captured = new Map<string, Uint8Array>();
  const relative = (uri: vscode.Uri): string | undefined => {
    if (uri.scheme !== 'file') return undefined;
    const key = portableRelativePath(path.relative(path.resolve(backingFolder), path.resolve(uri.fsPath)));
    return key && shouldTrackProjectPath(key) ? key : undefined;
  };
  const store = (key: string, bytes: Uint8Array): void => {
    if (bytes.byteLength > MAX_COLLABORATIVE_DOCUMENT_BYTES) {
      throw new Error(`Unsaved document ${key} exceeds the ${MAX_COLLABORATIVE_DOCUMENT_BYTES}-byte project limit.`);
    }
    captured.set(key, bytes);
  };
  for (const document of textDocuments) {
    if (document.isClosed || !document.isDirty) continue;
    const key = relative(document.uri);
    if (key) store(key, Buffer.from(document.getText(), 'utf8'));
  }
  for (const notebook of notebookDocuments) {
    if (notebook.isClosed || (!notebook.isDirty && !notebook.getCells().some((cell) => cell.document.isDirty))) continue;
    const key = relative(notebook.uri);
    if (!key || !key.toLowerCase().endsWith('.ipynb')) continue;
    // The notebook editor owns its cell buffers. A raw .ipynb text document
    // can still contain the older disk representation, so notebook state wins.
    store(key, serializeIpynb(snapshotNotebook(notebook)));
  }
  return [...captured].map(([relativePath, bytes]) => ({ relativePath, bytes }));
}

function snapshotNotebook(notebook: vscode.NotebookDocument): NotebookSnapshot {
  if (notebook.cellCount > MAX_NOTEBOOK_CELLS) throw new Error(`Notebook exceeds the ${MAX_NOTEBOOK_CELLS}-cell limit.`);
  const seenIds = new Set<string>();
  return {
    metadata: normalizeNotebookMetadata(notebook.metadata),
    cells: notebook.getCells().map((cell) => {
      let id = metadataCellId(cell.metadata);
      if (!id || seenIds.has(id)) id = newId();
      seenIds.add(id);
      const metadata = { ...cell.metadata };
      delete metadata.pairNotebookCellId;
      if (cell.outputs.length > MAX_CELL_OUTPUTS) throw new Error(`Cell exceeds the ${MAX_CELL_OUTPUTS}-output limit.`);
      let items = 0;
      let outputBytes = 0;
      const outputs = cell.outputs.map((output) => ({
        metadata: output.metadata,
        items: output.items.map((item) => {
          items++;
          outputBytes += Math.ceil(item.data.byteLength / 3) * 4 + Buffer.byteLength(item.mime, 'utf8');
          if (items > MAX_OUTPUT_ITEMS_PER_CELL || outputBytes > MAX_CELL_OUTPUT_JSON_BYTES) {
            throw new Error('Cell outputs exceed the collaborative output limit.');
          }
          return { mime: item.mime, dataBase64: Buffer.from(item.data).toString('base64') };
        }),
      }));
      return {
        id,
        kind: cell.kind,
        language: cell.document.languageId,
        source: cell.document.getText(),
        metadata,
        outputs,
        execution: cell.executionSummary ? { ...cell.executionSummary } : undefined,
      };
    }),
  };
}
