export const SERVER_VERSION = '0.6.13';
export const PERSISTENT_PROTOCOL = 1;
export const persistentCapabilities = {
  version: SERVER_VERSION,
  protocol: PERSISTENT_PROTOCOL,
  minimumClientVersion: '0.6.6',
  features: ['notebook-bootstrap-empty-v1'],
  relayPath: '/v1/temporary-relay',
};

export function isPermanentConnectionError(error: unknown, scope: 'connection' | 'file' = 'connection'): boolean {
  return error instanceof Error && 'status' in error && ([403, 404].includes(Number(error.status))
    ? scope === 'connection' : [401, 426].includes(Number(error.status)));
}
