import { createHash } from 'node:crypto';

export interface SignallingEndpointIdentity {
  /** Stable opaque key used to correlate one configured endpoint across health sources. */
  id: string;
  /** Credential-free label safe for diagnostics and logs. */
  label: string;
}

/** Keeps endpoint correlation separate from the redacted, potentially non-unique label. */
export function signallingEndpointIdentity(value: string): SignallingEndpointIdentity {
  let canonical = value;
  let label = 'invalid-endpoint';
  try {
    const endpoint = new URL(value);
    canonical = endpoint.toString();
    endpoint.username = '';
    endpoint.password = '';
    endpoint.pathname = '/';
    endpoint.search = '';
    endpoint.hash = '';
    label = endpoint.toString().replace(/\/$/, '');
  } catch {
    // The raw invalid value is hashed below and must never be returned.
  }
  return {
    id: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    label,
  };
}
