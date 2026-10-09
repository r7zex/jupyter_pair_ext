import * as vscode from 'vscode';
import type { SessionRuntime } from '../runtime/session';
import type { TerminalView } from '../core/sharedTerminal';

/** One persistent host shell, presented as a native terminal in every participant's window. */
export class SharedTerminalController implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private bound: SessionRuntime | undefined;
  private input = '';
  private inputOverflow = false;
  private outputEndedWithCarriageReturn = false;
  private lastRuntimeState: string | undefined;
  private connectionRecovering = false;
  private binding = 0;
  private readonly write = new vscode.EventEmitter<string>();
  private readonly closeEvent = new vscode.EventEmitter<number>();

  public constructor(private readonly currentRuntime: () => SessionRuntime | undefined) {}
  private readonly render = (view: TerminalView): void => {
    if (view.reset) {
      this.clearInput();
      this.outputEndedWithCarriageReturn = false;
      this.write.fire('\x1b[2J\x1b[H');
    }
    // stdout chunks may split CRLF between events. Preserve that pair instead
    // of inserting a second carriage return at the next chunk boundary.
    let text = view.text.replace(/\r?\n/g, '\r\n');
    if (this.outputEndedWithCarriageReturn && view.text.startsWith('\n')) text = text.slice(1);
    if (view.text) this.outputEndedWithCarriageReturn = view.text.endsWith('\r');
    this.write.fire(text);
    if (view.reset) this.writeRoleNotice();
  };
  private readonly ended = (): void => { this.terminal?.dispose(); this.unbind(); };
  private readonly changedHost = (): void => {
    this.clearInput();
    this.write.fire('\r\n[Хост изменился. Команды вводит только текущий хост.]\r\n');
    this.bound?.sharedTerminal().requestSnapshot();
  };
  private readonly changedState = (state: string): void => {
    const previous = this.lastRuntimeState;
    this.lastRuntimeState = state;
    if (state === previous) return;
    if (state === 'reconnecting' || state === 'host-unavailable') {
      this.connectionRecovering = true;
      this.clearInput();
      this.write.fire(state === 'reconnecting'
        ? '\r\n[Переподключение: вывод терминала будет восстановлен после соединения с хостом.]\r\n'
        : '\r\n[Хост недоступен. Ожидаем восстановления соединения.]\r\n');
    } else if (state === 'ready' && this.connectionRecovering) {
      this.connectionRecovering = false;
      this.write.fire('\r\n[Соединение восстановлено. Обновляем вывод терминала хоста.]\r\n');
      this.bound?.sharedTerminal().requestSnapshot();
    }
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
    runtime.on('state', this.changedState);
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.write.event, onDidClose: this.closeEvent.event,
      open: () => {
        if (this.bound !== runtime || this.binding !== binding || this.currentRuntime() !== runtime) return;
        this.render(shared.view());
        shared.requestSnapshot();
      },
      close: () => { if (this.bound === runtime && this.binding === binding) this.unbind(); },
      handleInput: (data) => {
        if (this.bound !== runtime || this.binding !== binding || this.currentRuntime() !== runtime || !runtime.coordinator.isCurrentHost() || data.includes('\x1b')) return;
        for (const character of data) {
          if (character === '\x03') { this.clearInput(); shared.interrupt(); }
          else if (character === '\r' || character === '\n') {
            const command = this.input;
            const overflow = this.inputOverflow;
            this.clearInput();
            this.write.fire('\r\n');
            if (overflow) {
              this.write.fire('[Command rejected: enter at most 8192 characters.]\r\n');
              continue;
            }
            if (command.trim()) void shared.execute(command).catch((error: unknown) => {
              if (this.bound === runtime && this.binding === binding && this.currentRuntime() === runtime) this.write.fire(`\r\n${String(error)}\r\n`);
            });
          } else if (character === '\x7f' || character === '\b') {
            if (this.inputOverflow) continue;
            if (this.input) { this.input = [...this.input].slice(0, -1).join(''); this.write.fire('\b \b'); }
          } else if (character >= ' ' && character !== '\x7f') {
            // Once any suffix has been dropped, reject the whole line instead
            // of executing a prefix with different shell semantics.
            if (this.inputOverflow || this.input.length + character.length > 8192) { this.inputOverflow = true; continue; }
            this.input += character;
            this.write.fire(character);
          }
        }
      },
    };
    this.terminal = vscode.window.createTerminal({ name: 'Pair Notebook • Host', pty, isTransient: true });
    this.terminal.show();
  }
  private writeRoleNotice(): void {
    this.write.fire(this.bound?.coordinator.isCurrentHost()
      ? '\r\n[Терминал хоста: вводите команды; Ctrl+C останавливает оболочку и её процессы.]\r\n'
      : '\r\n[Терминал хоста: только просмотр. Команды вводит текущий хост.]\r\n');
  }
  private clearInput(): void { this.input = ''; this.inputOverflow = false; }
  private unbind(): void {
    this.binding++;
    this.bound?.sharedTerminal().off('view', this.render);
    this.bound?.off('terminal', this.ended);
    this.bound?.off('hostChanged', this.changedHost);
    this.bound?.off('state', this.changedState);
    this.bound = undefined;
    this.terminal = undefined;
    this.lastRuntimeState = undefined;
    this.connectionRecovering = false;
    this.outputEndedWithCarriageReturn = false;
    this.clearInput();
  }
  public dispose(): void { this.terminal?.dispose(); this.unbind(); this.write.dispose(); this.closeEvent.dispose(); }
}
