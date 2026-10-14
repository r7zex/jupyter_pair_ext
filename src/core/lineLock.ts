import type { PresenceState } from '../runtime/session';

export interface LineTouchChange { rangeOffset: number; rangeLength: number }

/** Shared form of the original host lineLockMessage policy (dd9fed0). */
export function lineLockMessage(
  states: readonly PresenceState[], localId: string, key: string, cellId: string | undefined,
  changes: readonly LineTouchChange[], source: string,
  resolve: (state: PresenceState) => number | undefined,
): string | undefined {
  const start = (state: PresenceState): number | undefined => {
    const offset = resolve(state);
    return offset === undefined ? undefined : offset <= 0 ? 0 : source.lastIndexOf('\n', offset - 1) + 1;
  };
  const own = states.find((state) => state.peer.peerId === localId);
  const ownStart = own ? start(own) : undefined;
  for (const state of states) {
    if (state.peer.peerId === localId || state.shareCursor === false || state.activeFile !== key || state.activeNotebookCellId !== cellId) continue;
    const lockedStart = start(state); if (lockedStart === undefined) continue;
    if (own && ownStart === lockedStart && (own.peer.joinOrder - state.peer.joinOrder || own.peer.peerId.localeCompare(state.peer.peerId)) < 0) continue;
    const newline = source.indexOf('\n', lockedStart); const lockedEnd = newline < 0 ? source.length : newline + 1;
    // A boundary belongs to the following line, except the final empty position.
    if (changes.some((change) => change.rangeLength === 0
      ? change.rangeOffset >= lockedStart && (change.rangeOffset < lockedEnd || (newline < 0 && change.rangeOffset === lockedEnd))
      : (change.rangeOffset < lockedEnd && change.rangeOffset + change.rangeLength > lockedStart)
        || (lockedStart > 0 && change.rangeOffset < lockedStart && change.rangeOffset + change.rangeLength === lockedStart))) {
      return `Line is currently selected by ${state.peer.displayName}.`;
    }
  }
  return undefined;
}
