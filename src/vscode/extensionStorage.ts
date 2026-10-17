import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';
import { atomicWriteFile } from '../core/atomicFile';

const cleanups = new WeakMap<vscode.ExtensionContext, () => Promise<void>>();

export async function clearLocalConnections(context: vscode.ExtensionContext): Promise<void> {
  const cleanup = cleanups.get(context);
  if (!cleanup) throw new Error('Pair Notebook local storage is not ready.');
  await cleanup();
}

/** Keep connections and working copies in VS Code's uninstallable extension folder.
 * The extra credential key lives there too: uninstall invalidates retained SecretStorage rows.
 */
export async function prepareExtensionStorage(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  const root = context.globalStorageUri.fsPath;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stateFile = path.join(root, 'state.json');
  let state: Record<string, unknown>;
  let stateExisted = true;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = {}; stateExisted = false; }
  const keyFile = path.join(root, 'credential-key');
  let key: Buffer;
  try { key = await readFile(keyFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32);
    try { await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; key = await readFile(keyFile); }
  }
  if (key.length !== 32 || !state || Array.isArray(state) || typeof state !== 'object') throw new Error('Invalid Pair Notebook local storage.');
  let pending = Promise.resolve();
  const rawState = context.globalState;
  const secretKeysKey = 'pairNotebook.storageSecretKeys';
  const generationKey = 'pairNotebook.storageGeneration';
  const migrationDone = rawState.get<boolean>(generationKey, false);
  const secretKeys = new Set(rawState.get<string[]>(secretKeysKey, []));
  const fresh = !stateExisted;
  let allowLegacySecrets = !migrationDone || state['pairNotebook.legacySecretsPending'] === true;
  if (!migrationDone) state['pairNotebook.legacySecretsPending'] = true;
  if (migrationDone && fresh) {
    for (const name of secretKeys) await context.secrets.delete(name);
    secretKeys.clear();
  }
  const legacyKeys = rawState.keys().filter(name => name.startsWith('pairNotebook.') && name !== secretKeysKey && name !== generationKey);
  for (const name of legacyKeys) {
    if (!migrationDone && !Object.hasOwn(state, name)) state[name] = rawState.get(name);
  }
  await atomicWriteFile(stateFile, JSON.stringify(state));
  for (const name of legacyKeys) await rawState.update(name, undefined);
  await rawState.update(generationKey, true);
  const memento: vscode.Memento & { setKeysForSync(keys: readonly string[]): void } = {
    keys: () => Object.keys(state),
    get: <T>(name: string, fallback?: T) => Object.hasOwn(state, name) ? state[name] as T : fallback,
    update: (name, value) => {
      if (value === undefined) delete state[name]; else state[name] = value;
      const serialized = JSON.stringify(state);
      const write = pending.then(() => atomicWriteFile(stateFile, serialized));
      pending = write.catch(() => undefined);
      return write;
    },
    setKeysForSync: () => undefined,
  };
  const secrets: vscode.SecretStorage = {
    onDidChange: context.secrets.onDidChange,
    async get(name) {
      const value = await context.secrets.get(name);
      if (!value) return undefined;
      if (!value.startsWith('pair-v1:')) { if (!allowLegacySecrets) return undefined; await secrets.store(name, value); return value; }
      try {
        const bytes = Buffer.from(value.slice(8), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
      } catch { return undefined; } // A previous installation's encryption key is intentionally gone.
    },
    async store(name, value) {
      secretKeys.add(name);
      await rawState.update(secretKeysKey, [...secretKeys]);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      await context.secrets.store(name, 'pair-v1:' + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64'));
    },
    async delete(name) { await context.secrets.delete(name); secretKeys.delete(name); await rawState.update(secretKeysKey, [...secretKeys]); },
  };
  // Migrate known legacy credentials while this activation can still read them.
  if (!migrationDone) {
    const connections = Array.isArray(state['pairNotebook.persistentConnections']) ? state['pairNotebook.persistentConnections'] as Array<{endpoint:string; sessionId:string; memberId:string}> : [];
    const { createHash } = await import('node:crypto');
    for (const connection of connections) secretKeys.add('pairNotebook.persistentMembership.' + createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId])).digest('hex'));
    for (const name of ['pairNotebook.turnPassword', 'pairNotebook.proxyPassword', ...secretKeys]) {
      const value = await context.secrets.get(name);
      if (value && !value.startsWith('pair-v1:')) await secrets.store(name, value);
    }
  }
  const registryFile = path.join(context.extensionPath, 'media', 'storage-locations.json');
  let locations: string[] = [];
  try { locations = JSON.parse(await readFile(registryFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!Array.isArray(locations) || locations.some(item => typeof item !== 'string')) throw new Error('Invalid Pair Notebook storage registry.');
  await atomicWriteFile(registryFile, JSON.stringify([...new Set([...locations, root])]));
  const prepared = new Proxy({} as vscode.ExtensionContext, { get(_target, property) {
    if (property === 'globalState') return memento;
    if (property === 'secrets') return secrets;
    const value = Reflect.get(context, property);
    return typeof value === 'function' ? value.bind(context) : value;
  } });
  cleanups.set(prepared, async () => {
    await pending;
    for (const name of [...secretKeys]) await secrets.delete(name);
    state = {};
    allowLegacySecrets = false;
    await atomicWriteFile(stateFile, '{}');
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (item.name === 'state.json' || item.name === 'credential-key') continue;
      const candidate = path.join(root, item.name);
      if (path.dirname(candidate) !== path.resolve(root)) throw new Error('Invalid local cache path.');
      await rm(candidate, { recursive: true, force: true });
    }
  });
  return prepared;
}
