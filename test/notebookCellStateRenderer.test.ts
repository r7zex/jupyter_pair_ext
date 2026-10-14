import type * as vscode from 'vscode';
import { renderNotebookCellState } from '../src/vscode/notebookCellStateRenderer';

describe('Native empty notebook state', () => {
  it('starts and releases a restored output handle even when execution metadata is absent', async () => {
    const calls: string[] = []; let started = false;
    const execution = { start: () => { started = true; calls.push('start'); }, replaceOutput: async () => { if (!started) throw new Error('Must call start'); calls.push('output'); }, end: () => { calls.push('end'); } };
    const controller = { createNotebookCellExecution: () => execution } as unknown as vscode.NotebookController;
    const cell = { outputs: [] } as unknown as vscode.NotebookCell; const states = new Map();
    await renderNotebookCellState(controller, states, cell, { outputs: [{} as vscode.NotebookCellOutput], execution: undefined, outputsChanged: true, executionChanged: true, executionMode: 'snapshot' });
    if (calls.join(',') !== 'start,output,end' || states.size) throw new Error('Restored output retained an active execution handle');
  });
  it('does not require a selected kernel to restore an unexecuted empty-output cell', async () => {
    const controller = { createNotebookCellExecution: () => { throw new Error('Controller is not associated'); } } as unknown as vscode.NotebookController;
    const cell = { outputs: [] } as unknown as vscode.NotebookCell;
    await renderNotebookCellState(controller, new Map(), cell, {
      outputs: [], execution: undefined, outputsChanged: true, executionChanged: true, executionMode: 'snapshot',
    });
    await renderNotebookCellState(controller, new Map(), cell, {
      outputs: [], execution: {}, outputsChanged: true, executionChanged: true, executionMode: 'live',
    });
  });
});
