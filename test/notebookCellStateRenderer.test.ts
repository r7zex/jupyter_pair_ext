import type * as vscode from 'vscode';
import { renderNotebookCellState } from '../src/vscode/notebookCellStateRenderer';

describe('Native empty notebook state', () => {
  it('does not require a selected kernel to restore an unexecuted empty-output cell', async () => {
    const controller = { createNotebookCellExecution: () => { throw new Error('Controller is not associated'); } } as unknown as vscode.NotebookController;
    const cell = { outputs: [] } as unknown as vscode.NotebookCell;
    await renderNotebookCellState(controller, new Map(), cell, {
      outputs: [], execution: undefined, outputsChanged: true, executionChanged: true, executionMode: 'snapshot',
    });
  });
});
