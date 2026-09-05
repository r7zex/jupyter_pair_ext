import path from 'node:path';
import * as vscode from 'vscode';
import { safeRelativePath } from '../core/persistence';
import { shouldTrackProjectPath } from '../core/projectFiles';
import type { PresenceState, SessionRuntime } from '../runtime/session';

/** Renders only a collaborator's selected line; character cursors are not shown. */
export class PresenceRenderer implements vscode.Disposable {
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly disposables: vscode.Disposable[];
  private signature = '';
  private readonly invalidPresenceSignatures = new Map<string, string>();

  public constructor(private readonly runtime: SessionRuntime) {
    const update = () => {
      const hadInvalid = this.invalidPresenceSignatures.size > 0;
      this.invalidPresenceSignatures.clear();
      this.render(hadInvalid);
    };
    const force = () => this.render(true);
    runtime.on('presence', update);
    this.disposables = [
      vscode.window.onDidChangeVisibleTextEditors(force),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === event.document.uri.toString())) force();
      }),
      vscode.workspace.onDidChangeNotebookDocument(force),
      { dispose: () => runtime.off('presence', update) },
    ];
    this.render(true);
  }

  public dispose(): void {
    for (const decoration of this.decorations.values()) decoration.dispose();
    this.decorations.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private render(force: boolean): void {
    const states = this.visibleRemoteStates();
    const signature = JSON.stringify(states.map((state) => ({
      peerId: state.peer.peerId,
      activeFile: state.activeFile,
      activeNotebookCellId: state.activeNotebookCellId,
      activeLine: state.activeLine,
      activeLineAnchor: state.activeLineAnchor,
    })).sort((left, right) => left.peerId.localeCompare(right.peerId)));
    if (!force && signature === this.signature) return;
    this.signature = signature;

    const currentPeerIds = new Set(states.map((state) => state.peer.peerId));
    for (const peerId of [...this.decorations.keys()]) {
      if (!currentPeerIds.has(peerId)) this.disposeDecoration(peerId);
    }

    for (const editor of vscode.window.visibleTextEditors) {
      for (const decoration of this.decorations.values()) editor.setDecorations(decoration, []);
      const location = this.editorLocation(editor);
      if (!location) continue;
      for (const state of states) {
        if (state.activeFile !== location.key || state.activeNotebookCellId !== location.cellId) continue;
        const line = this.renderedLine(state, editor.document);
        if (line === undefined) continue;
        const textLine = editor.document.lineAt(line);
        editor.setDecorations(this.decorationFor(state.peer.peerId), [{
          range: new vscode.Range(textLine.range.start, textLine.range.end),
        }]);
      }
    }
  }

  private renderedLine(state: PresenceState, document: vscode.TextDocument): number | undefined {
    // Keep the renderer compatible with an already-running older runtime
    // during extension reload; the numeric semantic line remains safe.
    const resolver = (this.runtime as Partial<SessionRuntime>).resolvePresenceLineOffset;
    const offset = typeof resolver === 'function' ? resolver.call(this.runtime, state) : undefined;
    if (offset !== undefined) {
      try {
        const line = document.positionAt(offset).line;
        if (Number.isSafeInteger(line) && line >= 0 && line < document.lineCount) return line;
      } catch {
        // Fall back to the numeric line only for an older peer without anchors.
      }
    }
    if (Number.isSafeInteger(state.activeLine) && state.activeLine! >= 0 && state.activeLine! < document.lineCount) {
      return state.activeLine;
    }
    this.blockInvalidPresence(state);
    return undefined;
  }

  private visibleRemoteStates(): PresenceState[] {
    return this.runtime.snapshot().awareness
      .filter((state) => state.peer.peerId !== this.runtime.descriptor.localPeer.peerId
        && state.shareCursor !== false
        && !!state.activeFile
        && (state.activeLine !== undefined || state.activeLineAnchor !== undefined)
        && this.invalidPresenceSignatures.get(state.peer.peerId) !== this.presenceSignature(state))
      .sort((left, right) => left.peer.joinOrder - right.peer.joinOrder || left.peer.peerId.localeCompare(right.peer.peerId));
  }

  private decorationFor(peerId: string): vscode.TextEditorDecorationType {
    const existing = this.decorations.get(peerId);
    if (existing) return existing;
    const decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      borderColor: '#4FC3F7',
      backgroundColor: '#4FC3F722',
      overviewRulerColor: '#4FC3F7',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    });
    this.decorations.set(peerId, decoration);
    return decoration;
  }

  private editorLocation(editor: vscode.TextEditor): { key: string; cellId?: string } | undefined {
    if (editor.document.uri.scheme === 'file') {
      const key = this.relativeKey(editor.document.uri);
      return key ? { key } : undefined;
    }
    if (editor.document.uri.scheme !== 'vscode-notebook-cell') return undefined;
    for (const notebook of vscode.workspace.notebookDocuments) {
      const cell = notebook.getCells().find((candidate) => candidate.document.uri.toString() === editor.document.uri.toString());
      if (!cell) continue;
      const key = this.relativeKey(notebook.uri);
      const cellId = this.runtime.notebookCellId(cell);
      return key && cellId ? { key, cellId } : undefined;
    }
    return undefined;
  }

  private presenceSignature(state: PresenceState): string {
    return JSON.stringify({
      activeFile: state.activeFile,
      activeNotebookCellId: state.activeNotebookCellId,
      activeLine: state.activeLine,
      activeLineAnchor: state.activeLineAnchor,
    });
  }

  private blockInvalidPresence(state: PresenceState): void {
    this.invalidPresenceSignatures.set(state.peer.peerId, this.presenceSignature(state));
    this.disposeDecoration(state.peer.peerId);
  }

  private disposeDecoration(peerId: string): void {
    this.decorations.get(peerId)?.dispose();
    this.decorations.delete(peerId);
  }

  private relativeKey(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const relative = path.relative(this.runtime.descriptor.workingFolder, uri.fsPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    try {
      const key = safeRelativePath(relative).split(path.sep).join('/');
      return shouldTrackProjectPath(key) ? key : undefined;
    } catch {
      return undefined;
    }
  }
}
