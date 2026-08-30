import {
  inspectExplicitProxyPassword,
  inspectExplicitProxyUrl,
  type BoundProxyPassword,
} from '../runtime/proxy';

export const PROXY_CREDENTIAL_SECRET_KEY = 'pairNotebook.proxyCredential.v1';
export const PROXY_CREDENTIAL_MIGRATION_KEY = 'pairNotebook.proxyCredentialMigration';
export const PROXY_CREDENTIAL_MIGRATION_VERSION = 1;

export function shouldMigrateLegacyProxyPassword(storedVersion: unknown): boolean {
  return typeof storedVersion !== 'number'
    || !Number.isInteger(storedVersion)
    || storedVersion < PROXY_CREDENTIAL_MIGRATION_VERSION;
}

interface ProxyCredentialRecord extends BoundProxyPassword {
  version: 1;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const MAX_BINDING_LENGTH = 4_096;
const MAX_PASSWORD_LENGTH = 16_384;
const MAX_SERIALIZED_RECORD_LENGTH = (MAX_BINDING_LENGTH + MAX_PASSWORD_LENGTH) * 6 + 256;

function parseRecord(serialized: string | undefined): ProxyCredentialRecord | undefined {
  if (!serialized || serialized.length > MAX_SERIALIZED_RECORD_LENGTH) return undefined;
  try {
    const value = JSON.parse(serialized) as Partial<ProxyCredentialRecord>;
    if (value.version !== 1
      || typeof value.binding !== 'string'
      || !value.binding
      || value.binding.length > MAX_BINDING_LENGTH
      || typeof value.password !== 'string'
      || !value.password
      || value.password.length > MAX_PASSWORD_LENGTH) return undefined;
    return { version: 1, binding: value.binding, password: value.password };
  } catch {
    return undefined;
  }
}

function createRecord(binding: string, password: string): ProxyCredentialRecord {
  if (!binding || binding.length > MAX_BINDING_LENGTH) {
    throw new Error('Proxy endpoint or username is too long to store securely.');
  }
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Proxy password must contain between 1 and 16384 characters.');
  }
  return { version: 1, binding, password };
}

function serializeRecord(record: ProxyCredentialRecord): string {
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_SERIALIZED_RECORD_LENGTH) {
    throw new Error('Proxy credential record is too large to store securely.');
  }
  return serialized;
}

function recordForProxy(proxyUrl: string, password: string): ProxyCredentialRecord {
  const details = inspectExplicitProxyUrl(proxyUrl);
  if (!details) throw new Error('Configure a valid pairNotebook.proxyUrl before storing its password.');
  if (details.passwordPresent) {
    throw new Error('Remove the password from pairNotebook.proxyUrl before storing it securely.');
  }
  return createRecord(details.binding, password);
}

/** Reads a credential only when it belongs to the exact current endpoint + username. */
export async function readBoundProxyPassword(
  secrets: SecretStorageLike,
  proxyUrl: string,
): Promise<BoundProxyPassword | undefined> {
  const details = inspectExplicitProxyUrl(proxyUrl);
  if (!details || details.passwordPresent) return undefined;
  const record = parseRecord(await secrets.get(PROXY_CREDENTIAL_SECRET_KEY));
  if (!record || record.binding !== details.binding) return undefined;
  return { binding: record.binding, password: record.password };
}

/** Stores or clears the password bound to the current explicit proxy. */
export async function storeBoundProxyPassword(
  secrets: SecretStorageLike,
  proxyUrl: string,
  password: string,
): Promise<void> {
  if (!password) {
    await secrets.delete(PROXY_CREDENTIAL_SECRET_KEY);
    return;
  }
  await secrets.store(PROXY_CREDENTIAL_SECRET_KEY, serializeRecord(recordForProxy(proxyUrl, password)));
}

export interface LegacyProxyMigrationResult {
  proxyUrl: string;
  migrated: boolean;
  /** True when an unsafe/oversized legacy credential was removed but not stored. */
  discarded: boolean;
}

/**
 * Moves one legacy embedded password into SecretStorage. Settings replacement
 * is transactional with the secret write so a failed update restores the
 * previous bound credential.
 */
export async function migrateLegacyProxyPassword(
  secrets: SecretStorageLike,
  proxyUrl: string,
  updateProxyUrl: (passwordFreeUrl: string) => PromiseLike<void>,
): Promise<LegacyProxyMigrationResult> {
  const credential = inspectExplicitProxyPassword(proxyUrl);
  if (!credential?.passwordPresent) return { proxyUrl, migrated: false, discarded: false };
  const details = inspectExplicitProxyUrl(proxyUrl);
  let record: ProxyCredentialRecord | undefined;
  if (details && credential.password !== undefined) {
    try {
      record = createRecord(details.binding, credential.password);
    } catch {
      // Oversized legacy values are sanitized without copying them into SecretStorage.
    }
  }
  if (!record) {
    await updateProxyUrl(credential.passwordFreeUrl);
    return { proxyUrl: credential.passwordFreeUrl, migrated: false, discarded: true };
  }
  const previousSecret = await secrets.get(PROXY_CREDENTIAL_SECRET_KEY);
  await secrets.store(PROXY_CREDENTIAL_SECRET_KEY, serializeRecord(record));
  try {
    await updateProxyUrl(credential.passwordFreeUrl);
  } catch (error) {
    if (previousSecret === undefined) await secrets.delete(PROXY_CREDENTIAL_SECRET_KEY);
    else await secrets.store(PROXY_CREDENTIAL_SECRET_KEY, previousSecret);
    throw error;
  }
  return { proxyUrl: credential.passwordFreeUrl, migrated: true, discarded: false };
}
