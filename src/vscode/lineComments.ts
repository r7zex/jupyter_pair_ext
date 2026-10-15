import * as vscode from 'vscode';
import { commentColor, participantColor, type LineComment, type LineCommentInput } from '../core/lineComments';
import type { SessionRuntime } from '../runtime/session';

export interface CommentLocation { path: string; cellId?: string }
export interface LineCommentBackend {
  localId: string;
  location(document: vscode.TextDocument): CommentLocation | undefined;
  comments(): LineComment[];
  anchors(location: CommentLocation, start: number, end: number): Promise<Pick<LineCommentInput, 'startAnchor' | 'endAnchor' | 'epoch'>>;
  resolve(comment: LineComment): { start: number; end: number } | undefined;
  change(input: LineCommentInput | string): Promise<void>;
}

export function peerCommentBackend(runtime: SessionRuntime, document: vscode.TextDocument): LineCommentBackend | undefined {
  const cell = vscode.workspace.notebookDocuments.flatMap((notebook) => notebook.getCells()).find((cell) => cell.document === document);
  const key = runtime.notebookKey(cell?.notebook.uri ?? document.uri);
  const cellId = cell ? runtime.notebookCellId(cell) : undefined;
  if (!key || (cell && !cellId)) return undefined;
  return { localId: runtime.descriptor.localPeer.peerId, location: () => ({ path: key, ...(cellId ? { cellId } : {}) }),
    comments: () => runtime.lineComments(), anchors: async (_location, start, end) => runtime.commentAnchors(key, cellId, runtime.commentOffset(document, start), runtime.commentOffset(document, end)),
    resolve: (comment) => runtime.resolveComment(comment), change: (input) => runtime.changeComment(input) };
}

/** Native decorations work in ordinary editors and the text editors of notebook cells. */
export class LineCommentController implements vscode.Disposable {
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly badges = new Map<string, vscode.TextEditorDecorationType>();
  private readonly listeners: vscode.Disposable[];
  private readonly timer: NodeJS.Timeout;
  private signature = '';
  public constructor(private readonly backend: (document: vscode.TextDocument) => LineCommentBackend | undefined) {
    const run = (action: () => Promise<void>) => action().catch((error: unknown) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
    this.listeners = [vscode.commands.registerCommand('pairNotebook.addLineComment', () => run(() => this.add())),
      vscode.commands.registerCommand('pairNotebook.resolveLineComment', () => run(() => this.remove())),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render(true)),
      vscode.workspace.onDidChangeTextDocument(() => this.render(true))];
    this.timer = setInterval(() => this.render(false), 500); this.timer.unref();
  }
  private async add(): Promise<void> {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const backend = this.backend(editor.document), location = backend?.location(editor.document);
    if (!backend || !location) throw new Error('Откройте файл или ячейку подключённого проекта.');
    const selection = editor.selection;
    const startLine = selection.start.line;
    const endLine = selection.end.character === 0 && selection.end.line > startLine ? selection.end.line - 1 : selection.end.line;
    const anchors = await backend.anchors(location, editor.document.offsetAt(new vscode.Position(startLine, 0)), editor.document.offsetAt(editor.document.lineAt(endLine).range.end));
    const text = await vscode.window.showInputBox({ title: `Комментарий · строки ${startLine + 1}–${endLine + 1}`, ignoreFocusOut: true,
      validateInput: (value) => !value.trim() || value.length > 4000 ? 'Введите от 1 до 4000 символов.' : undefined });
    if (text === undefined) return;
    const configured = vscode.workspace.getConfiguration('pairNotebook').get<string>('cursorColor', '');
    await backend.change({ ...location, ...anchors, startLine, endLine, text, color: configured ? commentColor(configured) : participantColor(backend.localId) });
    this.render(true);
  }
  private async remove(): Promise<void> {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const backend = this.backend(editor.document), location = backend?.location(editor.document); if (!backend || !location) return;
    const comments = backend.comments().filter((comment) => comment.path === location.path && comment.cellId === location.cellId);
    const picked = await vscode.window.showQuickPick(comments.map((comment) => ({ label: `${comment.authorName}: ${comment.text.replace(/\s+/g, ' ').slice(0, 100)}`, description: `Строка ${comment.startLine + 1}`, comment })), { title: 'Закрыть комментарий · автор или хост' });
    if (picked) { await backend.change(picked.comment.id); this.render(true); }
  }
  private render(force: boolean): void {
    const views = vscode.window.visibleTextEditors.map((editor) => { const backend = this.backend(editor.document); return { editor, backend, location: backend?.location(editor.document) }; });
    const signature = JSON.stringify(views.map(({ editor, backend, location }) => [editor.document.uri.toString(), editor.document.version, location, backend?.comments()]));
    if (!force && signature === this.signature) return; this.signature = signature;
    for (const { editor, backend, location } of views) {
      for (const decoration of this.decorations.values()) editor.setDecorations(decoration, []);
      for (const decoration of this.badges.values()) editor.setDecorations(decoration, []);
      if (!backend || !location) continue;
      const byColor = new Map<string, vscode.DecorationOptions[]>();
      const badgeOptions = new Map<string, vscode.DecorationOptions[]>();
      for (const comment of backend.comments()) {
        if (comment.path !== location.path || comment.cellId !== location.cellId) continue;
        const offsets = backend.resolve(comment); if (!offsets) continue;
        const start = editor.document.positionAt(offsets.start).line, end = editor.document.positionAt(offsets.end).line;
        const hover = new vscode.MarkdownString(); hover.appendText(`${comment.authorName}\n\n${comment.text}`);
        const color = commentColor(comment.color);
        const options = byColor.get(color) ?? []; byColor.set(color, options);
        options.push({ range: new vscode.Range(editor.document.lineAt(start).range.start, editor.document.lineAt(Math.min(end, editor.document.lineCount - 1)).range.end), hoverMessage: hover });
        const badges = badgeOptions.get(color) ?? []; badgeOptions.set(color, badges);
        const position = editor.document.lineAt(start).range.end;
        badges.push({ range: new vscode.Range(position, position), hoverMessage: hover,
          renderOptions: { after: { contentText: ` 💬 ${comment.authorName}: ${comment.text.replace(/\s+/g, ' ').slice(0, 72)} `,
            color, backgroundColor: new vscode.ThemeColor('editorHoverWidget.background'), border: `1px solid ${color}`, margin: '0 0 0 24px',
            textDecoration: 'none; vertical-align: super;', fontStyle: 'normal' } },
        });
      }
      for (const [color, options] of byColor) {
        let decoration = this.decorations.get(color);
        if (!decoration) { decoration = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: color + '22', borderColor: color,
          borderStyle: 'solid', borderWidth: '0 0 0 2px', overviewRulerColor: color, overviewRulerLane: vscode.OverviewRulerLane.Right, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }); this.decorations.set(color, decoration); }
        editor.setDecorations(decoration, options);
        let badge = this.badges.get(color);
        if (!badge) { badge = vscode.window.createTextEditorDecorationType({ rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }); this.badges.set(color, badge); }
        editor.setDecorations(badge, badgeOptions.get(color) ?? []);
      }
    }
  }
  public dispose(): void { clearInterval(this.timer); for (const listener of this.listeners) listener.dispose(); for (const decoration of [...this.decorations.values(), ...this.badges.values()]) decoration.dispose(); }
}
