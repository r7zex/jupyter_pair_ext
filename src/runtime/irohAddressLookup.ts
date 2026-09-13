import { createPublicKey, verify } from 'node:crypto';
import dnsPacket from 'dns-packet';

const MAX_RELAY_PAYLOAD = 1072;
const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

export function irohPublicName(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; result += Z32[(value >>> bits) & 31]; }
  }
  if (bits) result += Z32[(value << (5 - bits)) & 31];
  return result;
}

export interface IrohAddressHint { relay?: string; addresses: string[] }

/** Verify the standard Pkarr relay envelope before parsing any DNS hints. */
export function parseIrohAddressHint(payload: Buffer, identityKey: string): IrohAddressHint {
  if (payload.length < 84 || payload.length > MAX_RELAY_PAYLOAD) throw new Error('Invalid Pkarr packet size.');
  const key = createPublicKey({ key: Buffer.from(identityKey, 'base64url'), type: 'spki', format: 'der' });
  const sequence = payload.readBigUInt64BE(64);
  const now = BigInt(Date.now()) * 1000n;
  if (sequence > now + 300_000_000n || sequence + 86_400_000_000n < now) throw new Error('Stale Pkarr address record.');
  const packet = payload.subarray(72);
  const signed = Buffer.concat([Buffer.from(`3:seqi${sequence}e1:v${packet.length}:`), packet]);
  if (!verify(null, signed, key, payload.subarray(0, 64))) throw new Error('Invalid Pkarr address signature.');
  const name = `_iroh.${irohPublicName(Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url'))}`;
  const hint: IrohAddressHint = { addresses: [] };
  for (const answer of dnsPacket.decode(packet).answers ?? []) {
    if (answer.type !== 'TXT' || answer.name.replace(/\.$/, '') !== name) continue;
    const parts = Array.isArray(answer.data) ? answer.data : [answer.data];
    const text = parts.map((part) => part.toString()).join('');
    if (text.startsWith('relay=')) {
      const relay = new URL(text.slice(6));
      if (relay.protocol === 'https:' && !relay.username && !relay.password) hint.relay ??= relay.href;
    } else if (text.startsWith('addr=') && hint.addresses.length < 16) {
      const address = text.slice(5);
      if (/^(?:\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.test(address)) hint.addresses.push(address);
    }
  }
  if (!hint.relay && !hint.addresses.length) throw new Error('Pkarr record has no Iroh addresses.');
  return hint;
}

/** HTTPS lookup complements the native DNS resolver on networks blocking TXT. */
export async function lookupIrohAddress(identityKey: string): Promise<IrohAddressHint> {
  const key = createPublicKey({ key: Buffer.from(identityKey, 'base64url'), type: 'spki', format: 'der' });
  const name = irohPublicName(Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url'));
  const response = await fetch(`https://dns.iroh.link/pkarr/${name}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Iroh HTTPS address lookup failed (${response.status}).`);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RELAY_PAYLOAD) throw new Error('Pkarr response exceeds its size limit.');
      parts.push(Buffer.from(next.value));
    }
    return parseIrohAddressHint(Buffer.concat(parts), identityKey);
  } finally { await reader.cancel().catch(() => undefined); }
}
