import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import type * as vscode from 'vscode';
import type { SessionRuntime } from '../src/runtime/session';

describe('shared host terminal viewer recovery', () => {
  function createFixture(host = false) {
    let pty!: vscode.Pseudoterminal;
    let disposed = false;
    const boundary = {
      EventEmitter: class {
        private readonly events = new EventEmitter();
        public event = (listener: (value: string) => void) => {
          this.events.on('value', listener);
          return { dispose: () => this.events.off('value', listener) };
        };
        public fire(value: string): void { this.events.emit('value', value); }
        public dispose(): void { this.events.removeAllListeners(); }
      },
      workspace: { isTrusted: true },
      window: { createTerminal: (options: { pty: vscode.Pseudoterminal }) => {
        pty = options.pty;
        return { show: () => undefined, dispose: () => { disposed = true; pty.close(); } };
      } },
    };
    const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const original = loader._load;
    const modulePath = require.resolve('../src/vscode/sharedTerminal');
    const cached = require.cache[modulePath];
    delete require.cache[modulePath];
    loader._load = function (request, parent, isMain): unknown {
      return request === 'vscode' ? boundary : original.call(this, request, parent, isMain);
    };
    let Controller!: typeof import('../src/vscode/sharedTerminal').SharedTerminalController;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Controller = require('../src/vscode/sharedTerminal').SharedTerminalController as typeof Controller;
    } finally {
      loader._load = original;
      if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    }
    const commands: string[] = [];
    let snapshots = 0;
    const shell = Object.assign(new EventEmitter(), {
      view: () => ({ text: 'host history\n', reset: true }),
      requestSnapshot: () => { snapshots++; },
      execute: async (command: string) => { commands.push(command); },
      interrupt: () => undefined,
    });
    const runtime = Object.assign(new EventEmitter(), { sharedTerminal: () => shell, coordinator: { isCurrentHost: () => host } });
    const controller = new Controller(() => runtime as unknown as SessionRuntime);
    controller.open();
    const output: string[] = [];
    pty.onDidWrite((text) => output.push(text));
    pty.open(undefined);
    return { controller, pty, shell, runtime, commands, output, snapshots: () => snapshots, disposed: () => disposed };
  }

  it('keeps the Russian guest restriction visible after transcript replacement and rejects guest input', async () => {
    const fixture = createFixture();
    try {
      assert.match(fixture.output.join(''), /host history\r\n/);
      assert.match(fixture.output.join(''), /только просмотр/);
      fixture.output.length = 0;
      fixture.shell.emit('view', { text: 'restored\n', reset: true });
      assert.match(fixture.output.join(''), /только просмотр/);
      fixture.pty.handleInput?.('rm -rf anything\r\x03');
      await Promise.resolve();
      assert.deepEqual(fixture.commands, []);
    } finally { fixture.controller.dispose(); }
  });

  it('preserves CRLF split across host output chunks', () => {
    const fixture = createFixture();
    try {
      fixture.output.length = 0;
      fixture.shell.emit('view', { text: 'epoch 1\r', reset: false });
      fixture.shell.emit('view', { text: '\nepoch 2\n', reset: false });
      assert.equal(fixture.output.join(''), 'epoch 1\r\nepoch 2\r\n');
    } finally { fixture.controller.dispose(); }
  });

  it('requests host history after reconnect transitions and releases all listeners when leaving', () => {
    const fixture = createFixture();
    try {
      assert.equal(fixture.snapshots(), 1);
      fixture.runtime.emit('state', 'reconnecting');
      fixture.runtime.emit('state', 'syncing');
      fixture.runtime.emit('state', 'ready');
      assert.equal(fixture.snapshots(), 2);
      assert.match(fixture.output.join(''), /Переподключение/);
      assert.match(fixture.output.join(''), /Соединение восстановлено/);
      fixture.runtime.emit('terminal');
      assert.equal(fixture.disposed(), true);
      assert.equal(fixture.runtime.listenerCount('state'), 0);
      assert.equal(fixture.runtime.listenerCount('hostChanged'), 0);
      assert.equal(fixture.shell.listenerCount('view'), 0);
    } finally { fixture.controller.dispose(); }
  });
});
