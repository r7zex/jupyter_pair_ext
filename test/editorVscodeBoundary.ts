import path from 'node:path';

export function createEditorVscodeBoundary(): any {
  const vscodeBoundary = createNotebookVscodeBoundary();
function fakeNotebook(root: string, cells: any[], relativePath = 'work.ipynb'): any {
  const notebook = {
    uri: vscodeBoundary.Uri.file(path.join(root, relativePath)),
    cells,
    metadata: { language_info: { name: 'python' } },
    saveCount: 0,
    get cellCount() { return this.cells.length; },
    getCells(range?: { start: number; end: number }) {
      return range ? this.cells.slice(range.start, range.end) : this.cells;
    },
    cellAt(index: number) { return this.cells[index]; },
    async save() { this.saveCount += 1; return true; },
  };
  for (const cell of cells) cell.notebook = notebook;
  reindex(notebook);
  return notebook;
}

let cellHandle = 0;
function fakeCell(source: string, id?: string): any {
  const handle = cellHandle += 1;
  const document = {
    uri: new vscodeBoundary.Uri(`/cell/${handle}`, 'vscode-notebook-cell'),
    languageId: 'python',
    text: source,
    version: 1,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
  };
  return {
    index: 0,
    kind: 2,
    document,
    metadata: id ? { pairNotebookCellId: id } : {},
    outputs: [],
    executionSummary: undefined,
    notebook: undefined,
  };
}

function fakeTextDocument(absolutePath: string, source: string): any {
  return {
    uri: vscodeBoundary.Uri.file(absolutePath),
    text: source,
    version: 1,
    saveCount: 0,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
    async save() { this.saveCount += 1; return true; },
  };
}

function reindex(notebook: any): void {
  notebook.cells.forEach((cell: any, index: number) => {
    cell.index = index;
    cell.notebook = notebook;
  });
}

function createNotebookVscodeBoundary(): any {
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const on = (name: string) => (callback: (event: any) => void) => {
    (handlers[name] ??= []).push(callback);
    return { dispose: () => { handlers[name] = (handlers[name] ?? []).filter((item) => item !== callback); } };
  };
  class Uri {
    public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
    public toString(): string { return `${this.scheme}://${this.fsPath}`; }
    public static file(value: string): Uri { return new Uri(value); }
  }
  class Range {
    public constructor(public readonly start: number, public readonly end: number) {}
  }
  class NotebookRange extends Range {}
  class NotebookCellData {
    public metadata: Record<string, unknown> = {};
    public outputs: any[] = [];
    public executionSummary: unknown;
    public constructor(public readonly kind: number, public readonly value: string, public readonly languageId: string) {}
  }
  class NotebookCellOutputItem {
    public constructor(public readonly data: Uint8Array, public readonly mime: string) {}
  }
  class NotebookCellOutput {
    public constructor(public items: any[], public metadata?: Record<string, unknown>) {}
  }
  class WorkspaceEdit {
    public operations: any[] = [];
    public replace(uri: Uri, range: Range, text: string): void { this.operations.push({ type: 'text', uri, range, text }); }
    public set(uri: Uri, edits: any[]): void {
      for (const edit of edits.filter((item) => item.newEol !== undefined)) {
        this.operations.push({ type: 'eol', uri, eol: edit.newEol });
      }
      const notebookEdits = edits.filter((item) => item.newEol === undefined);
      if (notebookEdits.length) this.operations.push({ type: 'notebook', uri, edits: notebookEdits });
    }
  }
  const boundary: any = {
    Uri,
    Range,
    NotebookRange,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    WorkspaceEdit,
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEdit: { setEndOfLine: (newEol: number) => ({ newEol }) },
    NotebookEdit: {
      replaceCells: (range: NotebookRange, cells: any[]) => ({ type: 'replaceCells', range, cells }),
      updateCellMetadata: (index: number, metadata: Record<string, unknown>) => ({ type: 'cellMetadata', index, metadata }),
      updateNotebookMetadata: (metadata: Record<string, unknown>) => ({ type: 'notebookMetadata', metadata }),
    },
    workspace: {
      notebookDocuments: [] as any[],
      textDocuments: [] as any[],
      onDidOpenTextDocument: on('openText'),
      onDidChangeTextDocument: on('changeText'),
      onDidCloseTextDocument: on('closeText'),
      onDidOpenNotebookDocument: on('openNotebook'),
      onDidChangeNotebookDocument: on('changeNotebook'),
      applyEdit: async (edit: WorkspaceEdit) => {
        if (boundary.__rejectEdits) return false;
        const documents = [...boundary.workspace.textDocuments,
          ...boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells.map((cell: any) => cell.document))];
        const versions = new Map(documents.map((document: any) => [document, document.version]));
        await boundary.__beforeApplyEdit?.(edit);
        if (edit.operations.some((operation: any) => operation.type === 'text'
          && documents.some((document: any) => document.uri.toString() === operation.uri.toString()
            && document.version !== versions.get(document)))) return false;
        for (const operation of edit.operations) {
          if (operation.type === 'eol') {
            const document = documents.find((item: any) => item.uri.toString() === operation.uri.toString());
            if (document) document.eol = operation.eol;
            continue;
          }
          if (operation.type === 'text') {
            boundary.__textEdits.push(operation);
            const cell = boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells)
              .find((item: any) => item.document.uri.toString() === operation.uri.toString());
            const document = cell?.document ?? boundary.workspace.textDocuments
              .find((item: any) => item.uri.toString() === operation.uri.toString());
            if (document) {
              document.text = `${document.text.slice(0, operation.range.start)}${operation.text}${document.text.slice(operation.range.end)}`;
              if (document.eol !== undefined) {
                document.text = document.text.replace(/\r?\n/g, document.eol === 2 ? '\r\n' : '\n');
              }
              boundary.__fireTextChange(document, [{ rangeOffset: operation.range.start,
                rangeLength: operation.range.end - operation.range.start, text: operation.text }]);
            }
            continue;
          }
          const notebook = boundary.workspace.notebookDocuments.find((item: any) => item.uri.toString() === operation.uri.toString());
          if (!notebook) continue;
          for (const notebookEdit of operation.edits) {
            boundary.__notebookEdits.push(notebookEdit);
            if (notebookEdit.type === 'cellMetadata') notebook.cells[notebookEdit.index].metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'notebookMetadata') notebook.metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'replaceCells') {
              const cells = notebookEdit.cells.map((data: any) => {
                const cell = fakeCell(data.value, data.metadata?.pairNotebookCellId);
                cell.kind = data.kind;
                cell.document.languageId = data.languageId;
                cell.metadata = { ...(data.metadata ?? {}) };
                cell.outputs = data.outputs ?? [];
                cell.executionSummary = data.executionSummary;
                return cell;
              });
              notebook.cells.splice(notebookEdit.range.start, notebookEdit.range.end - notebookEdit.range.start, ...cells);
              reindex(notebook);
            }
          }
        }
        const afterResolved = boundary.__afterApplyEditResolved;
        if (afterResolved) {
          boundary.__afterApplyEditResolved = undefined;
          setTimeout(() => afterResolved(edit), 0);
        }
        return true;
      },
    },
    window: {
      activeNotebookEditor: undefined as any,
      activeTextEditor: undefined as any,
      visibleNotebookEditors: [] as any[],
      visibleTextEditors: [] as any[],
      showWarningMessage: async () => undefined,
    },
    NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    __notebookEdits: [] as any[],
    __textEdits: [] as any[],
    __rejectEdits: false,
    __beforeApplyEdit: undefined as undefined | ((edit: WorkspaceEdit) => Promise<void>),
    __afterApplyEditResolved: undefined as undefined | ((edit: WorkspaceEdit) => void),
    __reset: (notebook: any) => {
      boundary.workspace.notebookDocuments = [notebook];
      boundary.workspace.textDocuments = [];
      boundary.__notebookEdits = [];
      boundary.__textEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
      boundary.__afterApplyEditResolved = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
    },
    __resetText: (document: any) => {
      boundary.workspace.notebookDocuments = [];
      boundary.workspace.textDocuments = [document];
      boundary.__notebookEdits = [];
      boundary.__textEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
      boundary.__afterApplyEditResolved = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
    },
    __fireNotebookChange: (notebook: any, structural: boolean, removedCells: any[] = []) => {
      for (const callback of handlers.changeNotebook ?? []) callback({
        notebook,
        contentChanges: structural ? [{ removedCells }] : [],
        cellChanges: [],
        metadata: undefined,
      });
    },
    __fireCellChange: (notebook: any, change: any) => {
      for (const callback of handlers.changeNotebook ?? []) callback({ notebook, contentChanges: [], cellChanges: [change] });
    },
    __fireTextChange: (document: any, contentChanges: any[]) => {
      document.version = (document.version ?? 0) + 1;
      for (const callback of handlers.changeText ?? []) callback({ document, contentChanges });
    },
  };
  return boundary;
}


  return { vscodeBoundary, fakeNotebook, fakeCell, fakeTextDocument, reindex };
}
