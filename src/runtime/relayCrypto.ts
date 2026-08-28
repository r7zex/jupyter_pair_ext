import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const IV_BYTES = 12;
const READINESS_PREFIX = 'pair-notebook-relay-readiness-v1:';
const ANNOUNCE_CONTEXT = 'pair-notebook-relay-announce-v1';
const ANNOUNCE_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

/** Builds an opaque self-check that proves a relay can publish and deliver ciphertext. */
export function encryptRelayReadinessProbe(key: Buffer, nonce: string): string {
  return encryptRelayPacket(key, Buffer.from(`${READINESS_PREFIX}${nonce}`, 'utf8')).toString('base64');
}

export function verifyRelayReadinessProbe(key: Buffer, nonce: string, encoded: string): boolean {
  try {
    const plaintext = decryptRelayPacket(key, Buffer.from(encoded, 'base64'));
    return plaintext.equals(Buffer.from(`${READINESS_PREFIX}${nonce}`, 'utf8'));
  } catch {
    return false;
  }
}

/** Proves that an announced peer id came from someone holding the session invite. */
export function createRelayAnnounceProof(key: Buffer, sessionId: string, peerId: string): string {
  return createHmac('sha256', key)
    .update(ANNOUNCE_CONTEXT)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(peerId)
    .digest('base64url');
}

export function verifyRelayAnnounceProof(
  key: Buffer,
  sessionId: string,
  peerId: string,
  proof: unknown,
): boolean {
  if (typeof proof !== 'string' || !ANNOUNCE_PROOF_PATTERN.test(proof)) return false;
  const actual = Buffer.from(proof, 'base64url');
  const expected = Buffer.from(createRelayAnnounceProof(key, sessionId, peerId), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
