import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;

export function deriveRelayFrameKey(token: string, sessionId: string): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(token, 'utf8'),
    Buffer.from(sessionId, 'utf8'),
    'pair-notebook-frame-key',
    32,
  ));
}

export function encryptRelayPacket(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptRelayPacket(key: Buffer, packet: Buffer): Buffer {
  if (packet.length < IV_BYTES + 16) throw new Error('Relay packet is truncated.');
  const iv = packet.subarray(0, IV_BYTES);
  const tag = packet.subarray(IV_BYTES, IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(packet.subarray(IV_BYTES + 16)), decipher.final()]);
}
