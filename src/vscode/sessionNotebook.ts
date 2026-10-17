import * as vscode from 'vscode';
import { parseIpynb, serializeIpynb } from '../core/projectFiles';
import { newId } from '../core/types';
import { executionFromCell, outputsFromCell, toNotebookCellData } from './sync';

export const SESSION_NOTEBOOK_TYPE = 'pair-notebook-session';

/** A distinct notebook type keeps the session controller out of ordinary Jupyter notebooks. */
export class SessionNotebookSerializer implements vscode.NotebookSerializer {
  public deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const snapshot = parseIpynb(Buffer.from(content).toString('utf8'));
    const notebook = new vscode.NotebookData(snapshot.cells.map(toNotebookCellData));
    notebook.metadata = snapshot.metadata;
    return notebook;
  }

  public serializeNotebook(notebook: vscode.NotebookData): Uint8Array {
    return serializeIpynb({
      metadata: notebook.metadata ?? {},
      cells: notebook.cells.map(cell => ({
        id: typeof cell.metadata?.pairNotebookCellId === 'string' ? cell.metadata.pairNotebookCellId : newId(),
        kind: cell.kind, language: cell.languageId, source: cell.value,
        metadata: cell.metadata ?? {}, outputs: outputsFromCell({ outputs: cell.outputs ?? [] }), execution: executionFromCell({ executionSummary: cell.executionSummary }),
      })),
    });
  }
}
