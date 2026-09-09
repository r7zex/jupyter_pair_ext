import { publicKeyFromPrivate, validateIdentityPrivateKey } from './identity';

export interface StoredSessionCredentialsV2 {
  version: 2;
  token: string;
  identityPrivateKey: string;
}

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function encodeSessionCredentials(
  token: string,
  identityPrivateKey: string,
): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('Session token has an unsupported format.');
  const privateKeyError = validateIdentityPrivateKey(identityPrivateKey);
  if (privateKeyError) throw new Error(`Session identity is invalid: ${privateKeyError}.`);
  return JSON.stringify({
    version: 2,
    token,
    identityPrivateKey,
  } satisfies StoredSessionCredentialsV2);
}

export function decodeExactSessionCredentials(value: string): StoredSessionCredentialsV2 | undefined {
  if (value.length > 2_048) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredSessionCredentialsV2>;
    if (parsed.version !== 2
      || typeof parsed.token !== 'string' || !SESSION_TOKEN_PATTERN.test(parsed.token)
      || typeof parsed.identityPrivateKey !== 'string'
      || validateIdentityPrivateKey(parsed.identityPrivateKey)) return undefined;
    return {
      version: 2,
      token: parsed.token,
      identityPrivateKey: parsed.identityPrivateKey,
    };
  } catch {
    return undefined;
  }
}

export function credentialsMatchPublicIdentity(
  credentials: StoredSessionCredentialsV2,
  identityPublicKey: string,
): boolean {
  try {
    return publicKeyFromPrivate(credentials.identityPrivateKey) === identityPublicKey;
  } catch {
    return false;
  }
}
