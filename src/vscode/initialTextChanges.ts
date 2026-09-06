import { diffChars } from 'diff';
import { TextChange } from '../core/crdt';

/** Only edits made after binding are local input; the pre-existing text is not. */
export function rebaseInitialTextChanges(before: string, target: string, changes: readonly TextChange[]): TextChange[] {
  if (before === target) return [...changes];
  // Bound initial reconciliation work for large, unrelated documents. The
  // fallback preserves new typing at the end without deleting remote content.
  const parts = diffChars(before, target, { timeout: 25 })
    ?? [{ value: before, removed: true }, { value: target, added: true }];
  const retained: Array<{ oldStart: number; newStart: number; length: number }> = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) retained.push({ oldStart: oldOffset, newStart: newOffset, length: part.value.length });
    if (!part.added) oldOffset += part.value.length;
    if (!part.removed) newOffset += part.value.length;
  }
  const position = (offset: number): number => {
    for (const run of retained) {
      if (offset < run.oldStart) return run.newStart;
      if (offset < run.oldStart + run.length) return run.newStart + offset - run.oldStart;
    }
    return target.length;
  };
  const result = new Map<number, TextChange>();
  const add = (offset: number, deleteCount: number, insertText: string): void => {
    const previous = result.get(offset);
    result.set(offset, { offset, deleteCount: (previous?.deleteCount ?? 0) + deleteCount,
      insertText: (previous?.insertText ?? '') + insertText });
  };
  for (const change of changes) {
    if (change.insertText) add(position(change.offset), 0, change.insertText);
    for (const run of retained) {
      const start = Math.max(change.offset, run.oldStart);
      const end = Math.min(change.offset + change.deleteCount, run.oldStart + run.length);
      if (end > start) add(run.newStart + start - run.oldStart, end - start, '');
    }
  }
  return [...result.values()].sort((left, right) => left.offset - right.offset);
}
