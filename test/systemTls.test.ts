import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { systemTlsOptions } from '../src/runtime/systemTls';

describe('Server TLS identity through CONNECT proxies', () => {
  it('validates the original IP even when the proxy supplies localhost as the socket host', () => {
    const options = systemTlsOptions('https://192.0.2.10');
    const certificate = { subjectaltname: 'IP Address:192.0.2.10' } as PeerCertificate;
    assert.equal(options.servername, '');
    assert.equal(options.checkServerIdentity!('localhost', certificate), undefined);
    assert(systemTlsOptions('https://192.0.2.11').checkServerIdentity!('localhost', certificate) instanceof Error);
  });
  it('retains DNS hostname and IPv6 identity validation', () => {
    const certificate = { subjectaltname: 'DNS:pair.example.com' } as PeerCertificate;
    assert.equal(systemTlsOptions('https://pair.example.com').servername, 'pair.example.com');
    assert.equal(systemTlsOptions('https://pair.example.com').checkServerIdentity!('localhost', certificate), undefined);
    assert(systemTlsOptions('https://other.example.com').checkServerIdentity!('localhost', certificate) instanceof Error);
    const ipv6 = new X509Certificate(readFileSync(path.resolve(__dirname, '../../test/server_tls.crt'))).toLegacyObject();
    assert.equal(systemTlsOptions('https://[2001:db8::1]').checkServerIdentity!('localhost', ipv6), undefined);
    assert(systemTlsOptions('https://[2001:db8::2]').checkServerIdentity!('localhost', ipv6) instanceof Error);
    assert(systemTlsOptions('https://[2001:db8::2]').checkServerIdentity!('localhost', { ...ipv6, subjectaltname: 'IP Address:2001:db8::2' }) instanceof Error);
  });
});
