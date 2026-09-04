import path from 'node:path';
import * as vscode from 'vscode';
import { safeRelativePath } from '../core/persistence';
import { shouldTrackProjectPath } from '../core/projectFiles';
import type { PresenceState, SessionRuntime } from '../runtime/session';

const HIDDEN_CURSORS = 'pairNotebook.hiddenCursorPeers';
const HIDDEN_NAMES = 'pairNotebook.hiddenCursorNames';
const COLOR_OVERRIDES = 'pairNotebook.cursorColorOverrides';

export const CURSOR_COLOR_PRESETS = [
  { label: 'Красный', value: '#F44336' },
  { label: 'Оранжевый', value: '#FF9800' },
  { label: 'Жёлтый', value: '#FFEB3B' },
  { label: 'Зелёный', value: '#4CAF50' },
  { label: 'Голубой', value: '#4FC3F7' },
  { label: 'Синий', value: '#2196F3' },
  { label: 'Фиолетовый', value: '#9C27B0' },
  { label: 'Розовый', value: '#E91E63' },
  { label: 'Белый', value: '#FFFFFF' },
  { label: 'Серый', value: '#9E9E9E' },
] as const;

export class PresenceRenderer implements vscode.Disposable, vscode.NotebookCellStatusBarItemProvider {
  private readonly decorations = new Map<string, { color: string; type: vscode.TextEditorDecorationType }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCellStatusBarItems = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[];
  private cursorSignature = '';
  private cellStatusSignature = '';
  private readonly invalidPresenceSignatures = new Map<string, string>();

  public constructor(private readonly runtime: SessionRuntime, private readonly context: vscode.ExtensionContext) {
    const updatePresence = () => {
      const hadInvalid = this.invalidPresenceSignatures.size > 0;
      this.invalidPresenceSignatures.clear();
      this.render(hadInvalid);
    };
    const forceUpdate = () => this.render(true);
    runtime.on('presence', updatePresence);
    this.disposables = [
      this.changeEmitter,
      vscode.window.onDidChangeVisibleTextEditors(forceUpdate),
      vscode.window.onDidChangeTextEditorVisibleRanges(forceUpdate),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (vscode.window.visibleTextEditors.some((editor) =>
          editor.document.uri.toString() === event.document.uri.toString())) forceUpdate();
      }),
      vscode.workspace.onDidChangeNotebookDocument(forceUpdate),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pairNotebook.showRemoteCursors')
          || event.affectsConfiguration('pairNotebook.showRemoteCursorNames')) forceUpdate();
      }),
      vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', this),
      { dispose: () => runtime.off('presence', updatePresence) },
    ];
    this.render(true);
  }

  public provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    if (!this.showCursors()) return [];
    const key = this.relativeKey(cell.notebook.uri);
    const cellId = this.runtime.notebookCellId(cell);
    if (!key || !cellId) return [];
    return this.visibleRemoteStates()
      .filter((state) => state.activeFile === key && state.activeNotebookCellId === cellId)
      .filter((state) => this.renderedLine(state, cell.document) !== undefined)
      .map((state) => {
        const showName = this.showName(state.peer.peerId);
        const item = new vscode.NotebookCellStatusBarItem(
          showName ? `$(account) ${state.peer.displayName}` : '$(account)',
          vscode.NotebookCellStatusBarAlignment.Left,
        );
        item.tooltip = showName ? `${state.peer.displayName} is active in this cell` : 'A collaborator is active in this cell';
        item.priority = 100;
        return item;
      });
  }

  public async manageParticipant(): Promise<void> {
    const peers = this.runtime.snapshot().awareness
      .filter((state) => state.peer.peerId !== this.runtime.descriptor.localPeer.peerId)
      .map((state) => ({ label: state.peer.displayName, description: state.peer.peerId, peerId: state.peer.peerId }));
    const peer = await vscode.window.showQuickPick(peers, { title: 'Настройки чужих курсоров', placeHolder: 'Выберите участника' });
    if (!peer) return;
    const hidden = this.hiddenCursorPeers().has(peer.peerId);
    const hiddenName = this.hiddenNamePeers().has(peer.peerId);
    const action = await vscode.window.showQuickPick([
      { label: hidden ? '$(eye) Показать курсор' : '$(eye-closed) Скрыть курсор у меня', action: 'cursor' },
      { label: hiddenName ? '$(tag) Показать имя' : '$(close) Скрыть имя у меня', action: 'name' },
      { label: '$(symbol-color) Задать локальный цвет', action: 'color' },
      { label: '$(discard) Сбросить локальный цвет', action: 'resetColor' },
    ], { title: peer.label });
    if (!action) return;
    if (action.action === 'cursor') await this.toggleSet(HIDDEN_CURSORS, peer.peerId);
    else if (action.action === 'name') await this.toggleSet(HIDDEN_NAMES, peer.peerId);
    else if (action.action === 'resetColor') {
      const colors = { ...this.colorOverrides() };
      delete colors[peer.peerId];
      await this.context.workspaceState.update(COLOR_OVERRIDES, colors);
    } else {
      const current = this.colorFor(peer.peerId, '#4FC3F7');
      const color = await pickCursorColor(`Цвет курсора: ${peer.label}`, current);
      if (!color) return;
      await this.context.workspaceState.update(COLOR_OVERRIDES, { ...this.colorOverrides(), [peer.peerId]: color });
    }
    this.rebuildDecorations();
    this.render(true);
  }

  public refresh(): void {
    this.rebuildDecorations();
    this.render(true);
  }

  public dispose(): void {
    for (const decoration of this.decorations.values()) decoration.type.dispose();
    this.decorations.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private render(force: boolean): void {
    const visibleStates = this.showCursors() ? this.visibleRemoteStates() : [];
    const cursorSignature = JSON.stringify(visibleStates
      .map((state) => ({
        peerId: state.peer.peerId,
        displayName: state.peer.displayName,
        activeFile: state.activeFile,
        activeNotebookCellId: state.activeNotebookCellId,
        activeLine: state.activeLine,
        cursor: state.cursor,
        cursorColor: this.colorFor(state.peer.peerId, state.cursorColor),
        showName: this.showName(state.peer.peerId),
      }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)));
    if (!force && cursorSignature === this.cursorSignature) return;
    this.cursorSignature = cursorSignature;

    const currentPeerIds = new Set(visibleStates.map((state) => state.peer.peerId));
    for (const peerId of [...this.decorations.keys()]) {
      if (!currentPeerIds.has(peerId)) this.disposeDecoration(peerId);
    }

    for (const editor of vscode.window.visibleTextEditors) {
      for (const decoration of this.decorations.values()) editor.setDecorations(decoration.type, []);
      const location = this.editorLocation(editor);
      if (!location) continue;
      for (const state of visibleStates) {
        if (state.activeFile !== location.key) continue;
        if (location.cellId !== undefined) {
          if (state.activeNotebookCellId !== location.cellId) continue;
          if (!this.findNotebookCell(location.key, location.cellId)) {
            this.blockInvalidPresence(state);
            continue;
          }
        } else if (state.activeNotebookCellId !== undefined) {
          continue;
        }
        const line = this.renderedLine(state, editor.document);
        if (line === undefined) continue;
        const color = this.colorFor(state.peer.peerId, state.cursorColor);
        const decoration = this.decorationFor(state.peer.peerId, color);
        const textLine = editor.document.lineAt(line);
        const showName = this.showName(state.peer.peerId);
        const option: vscode.DecorationOptions = {
          range: new vscode.Range(textLine.range.start, textLine.range.end),
          hoverMessage: showName ? `${state.peer.displayName} is editing this line` : 'A collaborator is editing this line',
          ...(showName ? {
            renderOptions: {
              after: {
                contentText: ` ${state.peer.displayName} `,
                color: '#ffffff',
                backgroundColor: color,
                fontWeight: '600',
                margin: '0 0 0 2px',
              },
            },
          } : {}),
        };
        editor.setDecorations(decoration, [option]);
      }
    }

    const cellStatusSignature = JSON.stringify(visibleStates
      .filter((state) => {
        if (!state.activeFile || !state.activeNotebookCellId) return false;
        const notebook = this.notebookForKey(state.activeFile);
        if (!notebook) return false;
        const cell = notebook.getCells().find((candidate) =>
          this.runtime.notebookCellId(candidate) === state.activeNotebookCellId);
        if (!cell) {
          this.blockInvalidPresence(state);
          return false;
        }
        return this.renderedLine(state, cell.document) !== undefined;
      })
      .map((state) => ({
        peerId: state.peer.peerId,
        displayName: state.peer.displayName,
        activeFile: state.activeFile,
        activeNotebookCellId: state.activeNotebookCellId,
        cursorColor: this.colorFor(state.peer.peerId, state.cursorColor),
        showName: this.showName(state.peer.peerId),
      }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)));
    if (cellStatusSignature !== this.cellStatusSignature) {
      this.cellStatusSignature = cellStatusSignature;
      this.changeEmitter.fire();
    }
  }

  private renderedLine(state: PresenceState, document: vscode.TextDocument): number | undefined {
    if (state.activeLine !== undefined) {
      if (!Number.isSafeInteger(state.activeLine)
        || state.activeLine < 0
        || state.activeLine >= document.lineCount) {
        this.blockInvalidPresence(state);
        return undefined;
      }
      return state.activeLine;
    }
    if (!state.cursor) return undefined;
    const resolved = this.runtime.resolvePresenceCursor(state);
    if (!resolved || !Number.isSafeInteger(resolved.active) || resolved.active < 0) {
      this.blockInvalidPresence(state);
      return undefined;
    }
    try {
      const position = document.positionAt(resolved.active);
      if (!Number.isSafeInteger(position.line) || position.line < 0 || position.line >= document.lineCount) {
        this.blockInvalidPresence(state);
        return undefined;
      }
      return position.line;
    } catch {
      this.blockInvalidPresence(state);
      return undefined;
    }
  }

  private notebookForKey(key: string): vscode.NotebookDocument | undefined {
    return vscode.workspace.notebookDocuments.find((notebook) => this.relativeKey(notebook.uri) === key);
  }

  private findNotebookCell(key: string, cellId: string): vscode.NotebookCell | undefined {
    const notebook = this.notebookForKey(key);
    return notebook?.getCells().find((cell) => this.runtime.notebookCellId(cell) === cellId);
  }

  private presenceSignature(state: PresenceState): string {
    return JSON.stringify({
      activeFile: state.activeFile,
      activeNotebookCellId: state.activeNotebookCellId,
      activeLine: state.activeLine,
      cursor: state.cursor,
      shareCursor: state.shareCursor,
      cursorColor: state.cursorColor,
      displayName: state.peer.displayName,
    });
  }

  private blockInvalidPresence(state: PresenceState): void {
    this.invalidPresenceSignatures.set(state.peer.peerId, this.presenceSignature(state));
    this.disposeDecoration(state.peer.peerId);
  }

  private disposeDecoration(peerId: string): void {
    this.decorations.get(peerId)?.type.dispose();
    this.decorations.delete(peerId);
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

  private visibleRemoteStates(): PresenceState[] {
    const hidden = this.hiddenCursorPeers();
    return this.runtime.snapshot().awareness
      .filter((state) => {
        if (state.peer.peerId === this.runtime.descriptor.localPeer.peerId
          || state.shareCursor === false
          || !state.activeFile
          || (state.activeLine === undefined && state.cursor === undefined)
          || hidden.has(state.peer.peerId)) return false;
        return this.invalidPresenceSignatures.get(state.peer.peerId) !== this.presenceSignature(state);
      })
      .sort((left, right) => {
        const joinOrder = left.peer.joinOrder - right.peer.joinOrder;
        return joinOrder || left.peer.peerId.localeCompare(right.peer.peerId);
      });
  }

  private decorationFor(peerId: string, color: string): vscode.TextEditorDecorationType {
    const existing = this.decorations.get(peerId);
    if (existing?.color === color) return existing.type;
    existing?.type.dispose();
    const type = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      borderColor: color,
      backgroundColor: `${color}22`,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    });
    this.decorations.set(peerId, { color, type });
    return type;
  }

  private rebuildDecorations(): void {
    for (const decoration of this.decorations.values()) decoration.type.dispose();
    this.decorations.clear();
  }

  private showCursors(): boolean {
    return vscode.workspace.getConfiguration('pairNotebook').get<boolean>('showRemoteCursors', true);
  }

  private showName(peerId: string): boolean {
    return vscode.workspace.getConfiguration('pairNotebook').get<boolean>('showRemoteCursorNames', true)
      && !this.hiddenNamePeers().has(peerId);
  }

  private hiddenCursorPeers(): Set<string> {
    return new Set(this.context.workspaceState.get<string[]>(HIDDEN_CURSORS, []));
  }

  private hiddenNamePeers(): Set<string> {
    return new Set(this.context.workspaceState.get<string[]>(HIDDEN_NAMES, []));
  }

  private colorOverrides(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(COLOR_OVERRIDES, {});
  }

  private colorFor(peerId: string, advertised: string | undefined): string {
    const value = this.colorOverrides()[peerId] ?? advertised ?? '#4FC3F7';
    return validateColor(value) ? '#4FC3F7' : value.trim().toUpperCase();
  }

  private async toggleSet(key: string, peerId: string): Promise<void> {
    const values = new Set(this.context.workspaceState.get<string[]>(key, []));
    if (values.has(peerId)) values.delete(peerId);
    else values.add(peerId);
    await this.context.workspaceState.update(key, [...values]);
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

export function validateColor(value: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? undefined : 'Введите шестизначный HEX-цвет, например #4FC3F7.';
}

export async function pickCursorColor(title: string, current = '#4FC3F7'): Promise<string | undefined> {
  const normalizedCurrent = validateColor(current) ? '#4FC3F7' : current.trim().toUpperCase();
  const choices: Array<vscode.QuickPickItem & { color?: string; custom?: boolean }> = [
    ...CURSOR_COLOR_PRESETS.map((preset) => ({
      label: `${preset.value === normalizedCurrent ? '$(check)' : '$(circle-filled)'} ${preset.label}`,
      description: preset.value,
      color: preset.value,
    })),
    {
      label: '$(edit) Другой HEX…',
      description: 'Введите произвольный шестизначный цвет',
      custom: true,
    },
  ];
  const selected = await vscode.window.showQuickPick(choices, {
    title,
    placeHolder: 'Выберите базовый цвет или укажите другой HEX',
    ignoreFocusOut: true,
  });
  if (!selected) return undefined;
  if (!selected.custom) return selected.color;

  const custom = await vscode.window.showInputBox({
    title,
    value: normalizedCurrent,
    prompt: 'Введите шестизначный CSS-цвет в формате HEX',
    validateInput: validateColor,
    ignoreFocusOut: true,
  });
  return custom ? custom.trim().toUpperCase() : undefined;
}
