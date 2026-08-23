import * as Y from 'yjs';

const MAX_ENCODED_POSITION_LENGTH = 1024;

export interface SharedCursorPosition {
  /** Absolute UTF-16 offsets retained for compatibility with older peers. */
  anchor: number;
  active: number;
  /** Base64-encoded Yjs relative positions used by peers that understand them. */
  relativeAnchor?: string;
  relativeActive?: string;
}

export interface ResolvedCursorPosition {
  anchor: number;
  active: number;
}

/**
 * Builds a wire-safe cursor value. Absolute offsets let older extension
 * versions keep rendering the cursor, while relative positions remain stable
 * when another participant concurrently edits before the cursor.
 */
export function createSharedCursorPosition(
  text: Y.Text | undefined,
  anchor: number,
  active: number,
): SharedCursorPosition {
  const fallbackAnchor = normalizeOffset(anchor, text?.length);
  const fallbackActive = normalizeOffset(active, text?.length);
  const result: SharedCursorPosition = {
    anchor: fallbackAnchor ?? 0,
    active: fallbackActive ?? 0,
  };
  if (!text?.doc) return result;

  result.relativeAnchor = encodeRelativeOffset(text, result.anchor);
  result.relativeActive = encodeRelativeOffset(text, result.active);
  return result;
}

/** Resolves relative positions when possible and safely falls back to offsets. */
export function resolveSharedCursorPosition(
  text: Y.Text | undefined,
  cursor: SharedCursorPosition,
): ResolvedCursorPosition | undefined {
  const anchor = resolveRelativeOffset(text, cursor.relativeAnchor, cursor.anchor);
  const active = resolveRelativeOffset(text, cursor.relativeActive, cursor.active);
  return anchor === undefined || active === undefined ? undefined : { anchor, active };
}

export function encodeRelativeOffset(text: Y.Text, offset: number): string | undefined {
  if (!text.doc) return undefined;
  const normalized = normalizeOffset(offset, text.length);
  if (normalized === undefined) return undefined;
  const relative = Y.createRelativePositionFromTypeIndex(text, normalized, 0);
  return Buffer.from(Y.encodeRelativePosition(relative)).toString('base64');
}

export function resolveRelativeOffset(
  text: Y.Text | undefined,
  encoded: string | undefined,
  fallback: unknown,
): number | undefined {
  if (text?.doc && isEncodedPosition(encoded)) {
    try {
      const relative = Y.decodeRelativePosition(Buffer.from(encoded, 'base64'));
      const absolute = Y.createAbsolutePositionFromRelativePosition(relative, text.doc);
      if (absolute?.type === text) return normalizeOffset(absolute.index, text.length);
    } catch {
      // Awareness is ephemeral and may come from an older or malformed peer.
      // The numeric offset below is the backwards-compatible safe fallback.
    }
  }
  return normalizeOffset(fallback, text?.length);
}

function isEncodedPosition(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ENCODED_POSITION_LENGTH
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizeOffset(value: unknown, maximum?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.max(0, Math.trunc(value));
  return maximum === undefined ? integer : Math.min(integer, maximum);
}
