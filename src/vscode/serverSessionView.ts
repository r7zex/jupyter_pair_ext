import type { PersistentSessionView } from '../vps/persistentProtocol';

export type ServerSessionView = PersistentSessionView & {
  presenceColors?: Record<string, string>;
  memberColors?: Record<string, string>;
  network?: { down: number; up: number; latencyMs?: number };
  activeKernel?: { notebook: string; scope: 'public' | 'private'; deviceId: string; gpuUuid?: string; canRestart: boolean };
};
