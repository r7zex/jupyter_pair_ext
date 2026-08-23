import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

const PUBLIC_KEY_MAX_BYTES = 128;
const PRIVATE_KEY_MAX_BYTES = 256;
const SIGNATURE_BYTES = 64;
const NONCE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PUBLIC_KEY_TEXT_LENGTH = 192;
const MAX_PRIVATE_KEY_TEXT_LENGTH = 384;

export interface IdentityCredentials {
  publicKey: string;
  privateKey: string;
}

export function generateIdentityCredentials(): IdentityCredentials {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

export function publicKeyFromPrivate(privateKey: string): string {
  const key = importPrivateKey(privateKey);
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function validateIdentityPublicKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PUBLIC_KEY_TEXT_LENGTH
    || !BASE64URL_PATTERN.test(value)) {
    return 'identity key has an unsupported format';
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    return 'identity key has an unsupported format';
  }
  if (!bytes.length || bytes.length > PUBLIC_KEY_MAX_BYTES
    || bytes.toString('base64url') !== value) {
    return 'identity key has an unsupported format';
  }
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519'
      || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) {
      return 'identity key must be a canonical Ed25519 public key';
    }
  } catch {
    return 'identity key is not a valid Ed25519 public key';
  }
  return undefined;
}

export function validateIdentityPrivateKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PRIVATE_KEY_TEXT_LENGTH
    || !BASE64URL_PATTERN.test(value)) {
    return 'identity private key has an unsupported format';
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    return 'identity private key has an unsupported format';
  }
  if (!bytes.length || bytes.length > PRIVATE_KEY_MAX_BYTES
    || bytes.toString('base64url') !== value) {
    return 'identity private key has an unsupported format';
  }
  try {
    importPrivateKey(value);
  } catch {
    return 'identity private key is not a valid Ed25519 private key';
  }
  return undefined;
}

export function newIdentityNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

export function validateIdentityNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 43 || !BASE64URL_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === NONCE_BYTES && bytes.toString('base64url') === value;
}

export function signIdentityTranscript(privateKey: string, transcript: Uint8Array): string {
  return sign(null, transcript, importPrivateKey(privateKey)).toString('base64url');
}

export function verifyIdentityTranscript(
  publicKey: string,
  transcript: Uint8Array,
  signature: unknown,
): boolean {
  if (validateIdentityPublicKey(publicKey)
    || typeof signature !== 'string'
    || signature.length !== 86
    || !BASE64URL_PATTERN.test(signature)) return false;
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== SIGNATURE_BYTES
    || signatureBytes.toString('base64url') !== signature) return false;
  try {
    return verify(
      null,
      transcript,
      createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }),
      signatureBytes,
    );
  } catch {
    return false;
  }
}

function importPrivateKey(value: string) {
  if (typeof value !== 'string' || value.length > MAX_PRIVATE_KEY_TEXT_LENGTH
    || !BASE64URL_PATTERN.test(value)) {
    throw new Error('Identity private key has an unsupported format.');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > PRIVATE_KEY_MAX_BYTES
    || bytes.toString('base64url') !== value) {
    throw new Error('Identity private key has an unsupported format.');
  }
  const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519'
    || key.export({ format: 'der', type: 'pkcs8' }).toString('base64url') !== value) {
    throw new Error('Identity private key must be canonical Ed25519 PKCS8.');
  }
  return key;
}
