import type { PersistentSessionView } from '../vps/persistentProtocol';

export type ServerSessionView = PersistentSessionView & {
  activeKernel?: { notebook: string; scope: 'public' | 'private'; deviceId: string; canRestart: boolean };
};
