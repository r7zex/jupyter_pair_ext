import { portableRelativePath } from './projectPath';
import type * as Y from 'yjs';
import { resolveRelativeOffset } from './cursorPosition';

export interface LineCommentInput {
  path: string;
  cellId?: string;
  startLine: number;
  endLine: number;
  startAnchor?: string | undefined;
  endAnchor?: string | undefined;
  /** Replica identity prevents attaching an old anchor to a replaced file. */
  epoch?: string;
  text: string;
  color: string;
}
export interface LineComment extends LineCommentInput {
  id: string;
  authorId: string;
  authorName: string;
  createdAt: number;
}
export const MAX_LINE_COMMENTS = 256;
export function participantColor(id: string): string {
  const palette = ['#4FC3F7', '#FFB74D', '#81C784', '#BA68C8', '#F06292', '#4DD0E1', '#DCE775', '#7986CB'];
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}
export function commentColor(value: unknown): string { return typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value) ? value : '#4FC3F7'; }
export function normalizeCommentInput(value: unknown): LineCommentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid line comment.');
  const raw = value as LineCommentInput;
  if (typeof raw.path !== 'string' || portableRelativePath(raw.path) !== raw.path
    || !Number.isSafeInteger(raw.startLine) || raw.startLine < 0 || !Number.isSafeInteger(raw.endLine) || raw.endLine < raw.startLine || raw.endLine > 10_000_000
    || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 4000
    || (raw.cellId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(raw.cellId))
    || [raw.startAnchor, raw.endAnchor, raw.epoch].some((entry) => entry !== undefined && (typeof entry !== 'string' || entry.length > 8192))) throw new Error('Invalid line comment: select project lines and enter up to 4000 characters.');
  return { path: raw.path, startLine: raw.startLine, endLine: raw.endLine, text: raw.text.trim(), color: commentColor(raw.color),
    ...(raw.cellId ? { cellId: raw.cellId } : {}), ...(raw.startAnchor ? { startAnchor: raw.startAnchor } : {}),
    ...(raw.endAnchor ? { endAnchor: raw.endAnchor } : {}), ...(raw.epoch ? { epoch: raw.epoch } : {}) };
}
export function reanchorComment(input: LineCommentInput, text: Y.Text): LineCommentInput {
  const start = resolveRelativeOffset(text, input.startAnchor, undefined), end = resolveRelativeOffset(text, input.endAnchor, undefined);
  if (start === undefined || end === undefined || end < start) throw new Error('The selected text changed. Select its lines again.');
  const source = text.toString();
  return { ...input, startLine: source.slice(0, start).split('\n').length - 1, endLine: source.slice(0, end).split('\n').length - 1 };
}
export function normalizeLineComment(value: unknown): LineComment {
  const input = normalizeCommentInput(value); const raw = value as LineComment;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id) || typeof raw.authorId !== 'string' || raw.authorId.length > 128
    || typeof raw.authorName !== 'string' || !raw.authorName || raw.authorName.length > 120 || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) throw new Error('Invalid saved line comment.');
  return { ...input, id: raw.id, authorId: raw.authorId, authorName: raw.authorName, createdAt: raw.createdAt };
}
