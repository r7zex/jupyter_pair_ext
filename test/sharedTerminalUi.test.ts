import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import type * as vscode from 'vscode';
import type { SessionRuntime } from '../src/runtime/session';

const terminals: Array<{ pty: vscode.Pseudoterminal; disposed: boolean; shown: number; dispose(): void; show(): void }> = [];
let trusted = true;
const boundary = {
  EventEmitter: class {
    public readonly emitter = new EventEmitter();
    public event = (callback: (value: unknown) => void): { dispose(): void } => {
      this.emitter.on('value', callback); return { dispose: () => this.emitter.off('value', callback) };
    };
    public fire(value: unknown): void { this.emitter.emit('value', value); }
    public dispose(): void { this.emitter.removeAllListeners(); }
  },
  workspace: { get isTrusted() { return trusted; } },
  window: { createTerminal: ({ pty }: { pty: vscode.Pseudoterminal }) => {
    const terminal = { pty, disposed: false, shown: 0,
      dispose(): void { this.disposed = true; }, show(): void { this.shown++; } };
    terminals.push(terminal); return terminal;
  } },
};
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
const modulePath = require.resolve('../src/vscode/sharedTerminal');
const cached = require.cache[modulePath];
delete require.cache[modulePath];
loader._load = function (request, parent, isMain): unknown { return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain); };
// Only native window/event APIs are replaced; the production terminal controller handles input.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SharedTerminalController } = require('../src/vscode/sharedTerminal') as typeof import('../src/vscode/sharedTerminal');
loader._load = originalLoad;
if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];

describe('native shared terminal input authority', () => {
  it('blocks guest typing/paste/control keys and permits only current host input', async () => {
    terminals.length = 0; trusted = true;
    let isHost = false;
    const commands: string[] = []; let interrupts = 0;
    const shell = Object.assign(new EventEmitter(), { view: () => ({ text: 'history\n', reset: true }),
      requestSnapshot: () => undefined, execute: async (command: string) => { commands.push(command); }, interrupt: () => { interrupts++; } });
    const runtime = Object.assign(new EventEmitter(), { sharedTerminal: () => shell, coordinator: { isCurrentHost: () => isHost } });
    let current: SessionRuntime | undefined = runtime as unknown as SessionRuntime;
    const controller = new SharedTerminalController(() => current);
    try {
      controller.open();
      const pty = terminals[0]!.pty; pty.open(undefined);
      pty.handleInput?.('echo forbidden\r\x03');
      assert.deepEqual(commands, []); assert.equal(interrupts, 0);
      controller.open(); assert.equal(terminals.length, 1);
      isHost = true; runtime.emit('hostChanged');
      pty.handleInput?.('echo accepted\r'); await Promise.resolve();
      assert.deepEqual(commands, ['echo accepted']);
      pty.handleInput?.('\x1b[A'); pty.handleInput?.('echo second\r'); await Promise.resolve();
      assert.deepEqual(commands, ['echo accepted', 'echo second']);
      pty.handleInput?.('\x03'); assert.equal(interrupts, 1);
      current = undefined; pty.handleInput?.('echo stale\r'); assert.equal(commands.length, 2);
      runtime.emit('terminal'); assert.equal(terminals[0]!.disposed, true);
    } finally { controller.dispose(); }
  });
  it('rejects untrusted workspaces and keeps a delayed old close from detaching a reopened terminal', () => {
    terminals.length = 0;
    const shell = Object.assign(new EventEmitter(), { view: () => ({ text: '', reset: true }), requestSnapshot: () => undefined });
    const runtime = Object.assign(new EventEmitter(), { sharedTerminal: () => shell, coordinator: { isCurrentHost: () => false } });
    const controller = new SharedTerminalController(() => runtime as unknown as SessionRuntime);
    try {
      trusted = false; assert.throws(() => controller.open(), /trusted/);
      trusted = true; controller.open(); const old = terminals[0]!;
      old.pty.close(); controller.open(); old.pty.close(); controller.open();
      assert.equal(terminals.length, 2);
      assert.equal(shell.listenerCount('view'), 1);
    } finally { controller.dispose(); trusted = true; }
  });

  it('ignores a delayed open and execution failure from a closed terminal binding', async () => {
    terminals.length = 0; trusted = true;
    let fail!: (error: Error) => void;
    const commands: string[] = [];
    const shell = Object.assign(new EventEmitter(), { view: () => ({ text: 'history', reset: true }), requestSnapshot: () => undefined,
      execute: (command: string) => { commands.push(command); return commands.length === 1
        ? new Promise<void>((_resolve, reject) => { fail = reject; }) : Promise.resolve(); } });
    const runtime = Object.assign(new EventEmitter(), { sharedTerminal: () => shell, coordinator: { isCurrentHost: () => true } });
    const controller = new SharedTerminalController(() => runtime as unknown as SessionRuntime);
    const output: string[] = [];
    try {
      controller.open(); const old = terminals[0]!.pty; old.open(undefined);
      old.handleInput?.('old command\r'); await Promise.resolve(); old.close();
      controller.open(); const current = terminals[1]!.pty;
      current.onDidWrite((text) => output.push(text)); current.open(undefined);
      current.handleInput?.('echo keep');
      output.length = 0;
      old.open(undefined); fail(new Error('old terminal error')); await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(output, [], 'stale callbacks must not reset current input or print into the new terminal');
      current.handleInput?.(' me\r'); await Promise.resolve();
      assert.deepEqual(commands, ['old command', 'echo keep me']);
    } finally { controller.dispose(); }
  });
});
