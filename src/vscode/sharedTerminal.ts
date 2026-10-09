import * as vscode from 'vscode';
import type { SessionRuntime } from '../runtime/session';
import type { TerminalView } from '../core/sharedTerminal';

/** One persistent host shell, presented as a native terminal in every participant's window. */
export class SharedTerminalController implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private bound: SessionRuntime | undefined;
  private input = '';
  private binding = 0;
  private readonly write = new vscode.EventEmitter<string>();
  private readonly closeEvent = new vscode.EventEmitter<number>();

  public constructor(private readonly currentRuntime: () => SessionRuntime | undefined) {}
  private readonly render = (view: TerminalView): void => {
    if (view.reset) { this.input = ''; this.write.fire('\x1b[2J\x1b[H'); }
    this.write.fire(view.text.replace(/\r?\n/g, '\r\n'));
  };
  private readonly ended = (): void => { this.terminal?.dispose(); this.unbind(); };
  private readonly changedHost = (): void => {
    this.input = '';
    this.write.fire('\r\n[Host changed. Only the current host can enter commands.]\r\n');
    this.bound?.sharedTerminal().requestSnapshot();
  };
  public open(): void {
    const runtime = this.currentRuntime();
    if (!runtime || !vscode.workspace.isTrusted) throw new Error('Join a trusted Pair Notebook session before opening its terminal.');
    if (runtime === this.bound && this.terminal) { this.terminal.show(); return; }
    this.terminal?.dispose();
    this.unbind();
    this.bound = runtime;
    const binding = ++this.binding;
    const shared = runtime.sharedTerminal();
    shared.on('view', this.render);
    runtime.on('terminal', this.ended);
    runtime.on('hostChanged', this.changedHost);
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.write.event, onDidClose: this.closeEvent.event,
      open: () => {
        if (this.bound !== runtime || this.binding !== binding || this.currentRuntime() !== runtime) return;
        this.render(shared.view());
        this.write.fire(runtime.coordinator.isCurrentHost()
          ? '\r\n[Host shell: enter line commands; Ctrl+C stops the shell.]\r\n'
          : '\r\n[Host shell: view only. The host enters commands.]\r\n');
        shared.requestSnapshot();
      },
      close: () => { if (this.bound === runtime && this.binding === binding) this.unbind(); },
      handleInput: (data) => {
        if (this.bound !== runtime || this.binding !== binding || this.currentRuntime() !== runtime || !runtime.coordinator.isCurrentHost() || data.includes('\x1b')) return;
        for (const character of data) {
          if (character === '\x03') { this.input = ''; shared.interrupt(); }
          else if (character === '\r' || character === '\n') {
            const command = this.input;
            this.input = '';
            this.write.fire('\r\n');
            if (command.trim()) void shared.execute(command).catch((error: unknown) => {
              if (this.bound === runtime && this.binding === binding && this.currentRuntime() === runtime) this.write.fire(`\r\n${String(error)}\r\n`);
            });
          } else if (character === '\x7f' || character === '\b') {
            if (this.input) { this.input = [...this.input].slice(0, -1).join(''); this.write.fire('\b \b'); }
          } else if (character >= ' ' && character !== '\x7f' && this.input.length < 8192) {
            this.input += character;
            this.write.fire(character);
          }
        }
      },
    };
    this.terminal = vscode.window.createTerminal({ name: 'Pair Notebook • Host', pty, isTransient: true });
    this.terminal.show();
  }
  private unbind(): void {
    this.binding++;
    this.bound?.sharedTerminal().off('view', this.render);
    this.bound?.off('terminal', this.ended);
    this.bound?.off('hostChanged', this.changedHost);
    this.bound = undefined;
    this.terminal = undefined;
    this.input = '';
  }
  public dispose(): void { this.terminal?.dispose(); this.unbind(); this.write.dispose(); this.closeEvent.dispose(); }
}
