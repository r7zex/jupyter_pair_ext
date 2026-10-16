import * as tls from 'node:tls';

let certificates: string[] | undefined;

/** Include explicitly trusted OS roots for LAN servers without changing TLS verification. */
export function systemTlsOptions(): { ca?: string[] } {
  const api = tls as typeof tls & { getCACertificates?: (type: string) => string[] };
  if (!api.getCACertificates) return {};
  certificates ??= [...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system')])];
  return { ca: certificates };
}
