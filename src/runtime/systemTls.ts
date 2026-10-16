import * as tls from 'node:tls';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';

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
  return { ...roots, servername: isIP(host) ? '' : host, checkServerIdentity: (_hostname, certificate) => {
    if (isIP(host) && certificate.raw) {
      // Node 22's DNS canonicalization can reject IPv6. Parse the signed IP SAN
      // with OpenSSL rather than trusting the printable subjectaltname string.
      try { if (new X509Certificate(certificate.raw).checkIP(host)) return undefined; }
      catch { return Object.assign(new Error('The server certificate IP identity could not be verified.'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }); }
      return Object.assign(new Error('The server certificate does not match its IP address.'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    }
    return tls.checkServerIdentity(host, certificate);
  } };
}
