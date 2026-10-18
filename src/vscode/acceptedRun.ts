import path from 'node:path';
import type { PersistentExecution } from '../vps/persistentProtocol';

export interface AcceptedRunReference {
  notebook: string;
  requestId: string;
  id?: string;
  endpoint?: string;
  sessionId?: string;
  memberId?: string;
  projectName?: string;
  createdAt?: number;
  deviceName?: string;
}

export function presentAcceptedRun(reference: AcceptedRunReference, execution: PersistentExecution) {
  const state = execution.state[0]!.toUpperCase() + execution.state.slice(1);
  const time = reference.createdAt ? new Date(reference.createdAt).toLocaleString() : 'Start time unavailable';
  return {
    label: `${path.posix.basename(execution.notebook)} · Cell ${execution.cellIndex + 1} · ${state}`,
    description: `${time} · ${execution.deviceId === 'vps' ? 'VPS' : reference.deviceName ?? 'Computer (name unavailable)'} · ${execution.scope === 'private' ? 'Private' : 'Shared'}`,
    detail: `${reference.projectName ? reference.projectName + ' / ' : ''}${execution.notebook} — Inspect saved outputs in a separate summary; code will not run again.`,
  };
}
