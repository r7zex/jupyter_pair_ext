/** Relay addresses in invitations carry no credentials. */
export function normalizeRelayEndpoint(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS relay origin without credentials, path, query or fragment.');
  }
  return url.origin;
}
