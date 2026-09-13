import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import dnsPacket from 'dns-packet';
import { generateIdentityCredentials } from '../src/core/identity';
import { irohPublicName, parseIrohAddressHint } from '../src/runtime/irohAddressLookup';

describe('authenticated Iroh HTTPS address records', () => {
  const identity = generateIdentityCredentials();
  const publicKey = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const name = `_iroh.${irohPublicName(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))}`;
  function record(options: { time?: bigint; recordName?: string } = {}) {
    const packet = dnsPacket.encode({ type: 'response', answers: [
      { name: options.recordName ?? name, type: 'TXT', ttl: 30, data: 'relay=https://relay.example.com/' },
      { name, type: 'TXT', ttl: 30, data: 'addr=127.0.0.1:1234' },
    ] });
    const sequence = options.time ?? BigInt(Date.now()) * 1000n;
    const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64BE(sequence);
    const signature = sign(null, Buffer.concat([Buffer.from(`3:seqi${sequence}e1:v${packet.length}:`), packet]), privateKey);
    return Buffer.concat([signature, timestamp, packet]);
  }
  it('uses canonical z-base32 and accepts a signed address packet', () => {
    assert.equal(irohPublicName(Buffer.from('foo')), 'c3zs6');
    assert.equal(irohPublicName(Buffer.alloc(32)).length, 52);
    assert.deepEqual(parseIrohAddressHint(record(), identity.publicKey), {
      relay: 'https://relay.example.com/', addresses: ['127.0.0.1:1234'],
    });
  });
  it('rejects forgery, another key, oversized packets and stale addresses', () => {
    const forged = record(); forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    assert.throws(() => parseIrohAddressHint(forged, identity.publicKey), /signature/);
    assert.throws(() => parseIrohAddressHint(record(), generateIdentityCredentials().publicKey), /signature/);
    assert.throws(() => parseIrohAddressHint(Buffer.alloc(1073), identity.publicKey), /size/);
    assert.throws(() => parseIrohAddressHint(record({ time: 1n }), identity.publicKey), /Stale/);
    assert.equal(parseIrohAddressHint(record({ recordName: '_iroh.foreign' }), identity.publicKey).relay, undefined);
  });
});
