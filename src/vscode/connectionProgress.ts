/** Returns the status-bar text for runtime states that need a visible spinner. */
export function statusBarTextForRuntimeState(runtimeState: string): string | undefined {
  if (runtimeState === 'connecting') return '$(sync~spin) Pair: connecting';
  if (runtimeState === 'reconnecting' || runtimeState === 'syncing') {
    return `$(sync~spin) Pair: ${runtimeState}`;
  }
  return undefined;
}
