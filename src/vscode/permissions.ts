import * as vscode from 'vscode';
import type { ParticipantPermissions } from '../core/permissions';

/** Build a complete replacement first; cancelling any step leaves authority unchanged. */
export async function editParticipantPermissions(name: string, current: ParticipantPermissions, entries: { path: string; directory: boolean }[], terminal = true): Promise<ParticipantPermissions | undefined> {
  const edit = await vscode.window.showQuickPick([
    { label: 'Все файлы', value: 'all' as const }, { label: 'Только выбранные файлы и папки', value: 'selected' as const }, { label: 'Только чтение', value: 'none' as const },
  ], { title: `${name} · какие файлы можно редактировать`, placeHolder: `Сейчас: ${current.edit}` });
  if (!edit) return undefined;
  let paths = current.paths;
  if (edit.value === 'selected') {
    const candidates = [...new Set([...entries.map((entry) => entry.path + (entry.directory ? '/' : '')), ...current.paths])].sort();
    const selected = await vscode.window.showQuickPick(candidates.map((filename) => ({ label: filename, picked: current.paths.includes(filename) })), {
      title: `${name} · разрешённые файлы`, canPickMany: true, placeHolder: 'Папка с / разрешает все вложенные файлы',
    });
    if (!selected) return undefined;
    paths = selected.map((item) => item.label);
  }
  const capabilities = await vscode.window.showQuickPick([
    { label: 'Запуск Python и управление вычислениями', id: 'execute', picked: current.execute && (edit.value === 'all' || current.edit !== 'all'), description: 'Код может менять файлы в обход ограничений редактора' },
    { label: 'Комментарии к строкам', id: 'comment', picked: current.comment },
  ], { title: `${name} · дополнительные права`, canPickMany: true });
  if (!capabilities) return undefined;
  let mode = current.terminal;
  if (terminal) {
    const picked = await vscode.window.showQuickPick([
      { label: 'Нет доступа', value: 'none' as const }, { label: 'Только просмотр', value: 'read' as const },
      { label: 'Просмотр и ввод команд', value: 'write' as const, description: 'Команды выполняются от имени хоста' },
    ], { title: `${name} · общая консоль`, placeHolder: `Сейчас: ${current.terminal}` });
    if (!picked) return undefined; mode = picked.value;
  }
  return { edit: edit.value, paths, execute: capabilities.some((item) => item.id === 'execute'), comment: capabilities.some((item) => item.id === 'comment'), terminal: mode };
}
