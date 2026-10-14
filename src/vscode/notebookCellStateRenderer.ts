import type * as vscode from 'vscode';
import type { NotebookCellRenderRequest } from './sync';

export interface MirroredCellState { execution: vscode.NotebookCellExecution; started: boolean }

/** Shared native NotebookController presentation from the existing host path. */
export async function renderNotebookCellState(controller: vscode.NotebookController, states: Map<vscode.NotebookCell, MirroredCellState>, cell: vscode.NotebookCell, request: NotebookCellRenderRequest): Promise<void> {
  const target = request.execution;
  if (request.executionMode === 'snapshot' && !states.has(cell) && !cell.executionSummary
    && target?.executionOrder === undefined && target?.success === undefined && !target?.timing
    && !request.outputs.length && !cell.outputs.length) return;
    let state = states.get(cell);
    if (!state) {
      state = {
        execution: controller.createNotebookCellExecution(cell),
        started: false,
      };
      states.set(cell, state);
    }

    if (request.executionChanged) {
      state.execution.executionOrder = target?.executionOrder;
    } else if (target?.executionOrder !== undefined) {
      state.execution.executionOrder = target.executionOrder;
    }

    if (target && !state.started) {
      state.execution.start(target.timing?.startTime);
      state.started = true;
    }

    if (request.outputsChanged) {
      await state.execution.replaceOutput(request.outputs);
    }

    const liveRunning = request.executionMode === 'live'
      && target !== undefined
      && target.success === undefined;
    if (liveRunning) return;

    if (!state.started) {
      state.execution.start(target?.timing?.startTime);
      state.started = true;
    }
    state.execution.end(target?.success, target?.timing?.endTime);
    states.delete(cell);
}
