import assert from 'node:assert/strict';
import Module from 'node:module';
import * as Y from 'yjs';
import { encodeRelativeOffset, resolveRelativeOffset } from '../src/core/cursorPosition';
import type { LineComment } from '../src/core/lineComments';
import type { LineCommentBackend } from '../src/vscode/lineComments';

describe('line comment editor interaction', () => {
  it('comments the selected lines through the context command, follows edits, and resolves the visible comment', async () => {
    const doc = new Y.Doc(); const text = doc.getText('content'); text.insert(0, 'first\nsecond\nthird');
    class Position { constructor(public line: number, public character: number) {} }
    class Range { constructor(public start: Position, public end: Position) {} }
    const commands = new Map<string, () => Promise<unknown>>(); const changes: (() => void)[] = [];
    const decorations: { options: any; values: any[] }[] = [];
    const disposable = () => ({ dispose: () => undefined });
    let saved: LineComment[] = [];
    const document = { uri: { toString: () => 'file:///main.py' }, version: 1, get lineCount() { return text.toString().split('\n').length; },
      offsetAt: (position: Position) => text.toString().split('\n').slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) + position.character,
      positionAt: (offset: number) => { const lines = text.toString().slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1)!.length); },
      lineAt: (line: number) => ({ range: new Range(new Position(line, 0), new Position(line, text.toString().split('\n')[line]!.length)) }) };
    const editor = { document, selection: new Range(new Position(1, 0), new Position(2, 0)), setDecorations: (decoration: typeof decorations[number], values: any[]) => { decoration.values = values; } };
    const fake = { Position, Range, MarkdownString: class { value = ''; appendText(value: string) { this.value += value; return this; } }, ThemeColor: class { constructor(public id: string) {} },
      OverviewRulerLane: { Right: 4 }, DecorationRangeBehavior: { ClosedClosed: 1 },
      commands: { registerCommand: (id: string, handler: () => Promise<unknown>) => { commands.set(id, handler); return disposable(); } },
      workspace: { getConfiguration: () => ({ get: () => '#FFB74D' }), onDidChangeTextDocument: (callback: () => void) => { changes.push(callback); return disposable(); } },
      window: { activeTextEditor: editor, visibleTextEditors: [editor], onDidChangeVisibleTextEditors: () => disposable(),
        createTextEditorDecorationType: (options: unknown) => { const value = { options, values: [], ...disposable() }; decorations.push(value); return value; },
        showInputBox: async () => 'Please check this', showQuickPick: async (items: unknown[]) => items[0], showErrorMessage: async (message: string) => { assert.fail(message); } } };
    const backend: LineCommentBackend = { localId: 'alice', location: () => ({ path: 'main.py' }), comments: () => saved,
      anchors: async (_location, start, end) => ({ startAnchor: encodeRelativeOffset(text, start), endAnchor: encodeRelativeOffset(text, end) }),
      resolve: (comment) => ({ start: resolveRelativeOffset(text, comment.startAnchor, undefined)!, end: resolveRelativeOffset(text, comment.endAnchor, undefined)! }),
      change: async (input) => { if (typeof input === 'string') saved = saved.filter((comment) => comment.id !== input); else saved.push({ ...input, id: 'comment', authorId: 'alice', authorName: 'Alice', createdAt: 1 }); } };
    const loader = Module as typeof Module & { _load(request: string, parent: unknown, isMain: boolean): unknown };
    const previous = loader._load; const modulePath = require.resolve('../src/vscode/lineComments'); const cached = require.cache[modulePath];
    let Controller: typeof import('../src/vscode/lineComments').LineCommentController;
    try {
      delete require.cache[modulePath]; loader._load = function (request, parent, isMain) { return request === 'vscode' ? fake : previous.call(this, request, parent, isMain); };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Controller = require('../src/vscode/lineComments').LineCommentController;
    } finally { loader._load = previous; if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath]; }
    const controller = new Controller(() => backend);
    try {
      await commands.get('pairNotebook.addLineComment')!();
      assert.equal(saved[0]!.startLine, 1); assert.equal(saved[0]!.endLine, 1); assert.equal(saved[0]!.color, '#FFB74D');
      assert.equal(decorations[0]!.options.backgroundColor, '#FFB74D22');
      assert.match(decorations[1]!.values[0].renderOptions.after.contentText, /Alice: Please check this/);
      text.insert(0, 'intro\n'); document.version++; changes[0]!();
      assert.equal(decorations[0]!.values[0].range.start.line, 2);
      await commands.get('pairNotebook.resolveLineComment')!(); assert.equal(saved.length, 0); assert.equal(decorations[0]!.values.length, 0);
    } finally { controller.dispose(); doc.destroy(); }
  });
});
