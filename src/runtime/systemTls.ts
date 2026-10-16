import * as tls from 'node:tls';
import { isIP } from 'node:net';

let certificates: string[] | undefined;

/** Include explicitly trusted OS roots for LAN servers without changing TLS verification. */
export function systemTlsOptions(origin?: string | URL): Pick<tls.ConnectionOptions, 'ca' | 'servername' | 'checkServerIdentity'> {
  const api = tls as typeof tls & { getCACertificates?: (type: string) => string[] };
  if (api.getCACertificates) certificates ??= [...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system')])];
  const roots = certificates ? { ca: certificates } : {};
  if (!origin) return roots;
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  // CONNECT agents may omit host when wrapping a socket for an IP address.
  // Bind verification to the original endpoint; never trust the proxy hostname.
  return { ...roots, servername: isIP(host) ? '' : host, checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(host, certificate) };
}
