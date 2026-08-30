import assert from 'node:assert/strict';
import {
  PROXY_CREDENTIAL_MIGRATION_KEY,
  PROXY_CREDENTIAL_MIGRATION_VERSION,
  PROXY_CREDENTIAL_SECRET_KEY,
  migrateLegacyProxyPassword,
  readBoundProxyPassword,
  shouldMigrateLegacyProxyPassword,
  storeBoundProxyPassword,
  type SecretStorageLike,
} from '../src/vscode/proxyCredentials';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('explicit proxy credentials', () => {
  it('migrates a legacy URL password and binds it to the sanitized endpoint', async () => {
    const secrets = new MemorySecrets();
    let updatedUrl = '';
    const result = await migrateLegacyProxyPassword(
      secrets,
      ' http://alice:p%40ss@proxy.local:3128',
      async (proxyUrl) => { updatedUrl = proxyUrl; },
    );

    assert.equal(result.migrated, true);
    assert.equal(result.discarded, false);
    assert.equal(result.proxyUrl, 'http://alice@proxy.local:3128/');
    assert.equal(updatedUrl, result.proxyUrl);
    assert.equal((await readBoundProxyPassword(secrets, updatedUrl))?.password, 'p@ss');
    assert.equal(await readBoundProxyPassword(secrets, 'http://alice@other.local:3128'), undefined);
    assert.equal(PROXY_CREDENTIAL_MIGRATION_KEY, 'pairNotebook.proxyCredentialMigration');
    assert.equal(PROXY_CREDENTIAL_MIGRATION_VERSION, 1);
    assert.equal(shouldMigrateLegacyProxyPassword(undefined), true);
    assert.equal(shouldMigrateLegacyProxyPassword(0), true);
    assert.equal(shouldMigrateLegacyProxyPassword(1), false);
    assert.equal(shouldMigrateLegacyProxyPassword(2), false);
  });

  it('restores the previous secret when legacy setting sanitization fails', async () => {
    const secrets = new MemorySecrets();
    const previous = '{"version":1,"binding":"previous","password":"previous-secret"}';
    secrets.values.set(PROXY_CREDENTIAL_SECRET_KEY, previous);

    await assert.rejects(
      migrateLegacyProxyPassword(
        secrets,
        'socks5://bob:legacy-secret@proxy.local:1080',
        async () => { throw new Error('settings update failed'); },
      ),
      /settings update failed/,
    );
    assert.equal(secrets.values.get(PROXY_CREDENTIAL_SECRET_KEY), previous);
  });

  it('stores, scopes, and clears a password without accepting embedded credentials', async () => {
    const secrets = new MemorySecrets();
    await storeBoundProxyPassword(secrets, 'socks5h://bob@proxy.local:1080', 'secret');
    assert.equal(
      (await readBoundProxyPassword(secrets, 'socks5h://bob@proxy.local:1080'))?.password,
      'secret',
    );
    assert.equal(await readBoundProxyPassword(secrets, 'socks5h://carol@proxy.local:1080'), undefined);
    await assert.rejects(
      storeBoundProxyPassword(secrets, 'socks5h://bob:in-settings@proxy.local:1080', 'secret'),
      /Remove the password/,
    );
    await storeBoundProxyPassword(secrets, 'socks5h://bob@proxy.local:1080', '');
    assert.equal(secrets.values.has(PROXY_CREDENTIAL_SECRET_KEY), false);
  });

  it('sanitizes unsupported, malformed, and oversized legacy credentials without storing them', async () => {
    const cases = [
      {
        raw: 'ftp://alice:secret@example.test:21',
        sanitized: 'ftp://alice@example.test/',
      },
      {
        raw: 'http://alice:%E0%A4%A@proxy.local:3128',
        sanitized: 'http://alice@proxy.local:3128/',
      },
      {
        raw: 'http://alice:secret@',
        sanitized: '',
      },
      {
        raw: '//alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'ht^tp://alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'ht^tp:/alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'opaque:/alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'opaque:/decoy@alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: '//decoy@alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'invalid@alice:secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: 'alice:/secret@proxy.local:3128',
        sanitized: '',
      },
      {
        raw: `http://alice:${'x'.repeat(16_385)}@proxy.local:3128`,
        sanitized: 'http://alice@proxy.local:3128/',
      },
      {
        raw: `http://${'u'.repeat(4_097)}:secret@proxy.local:3128`,
        sanitized: `http://${'u'.repeat(4_097)}@proxy.local:3128/`,
      },
    ];

    for (const example of cases) {
      const secrets = new MemorySecrets();
      let updatedUrl: string | undefined;
      const result = await migrateLegacyProxyPassword(
        secrets,
        example.raw,
        async (proxyUrl) => { updatedUrl = proxyUrl; },
      );
      assert.equal(result.migrated, false);
      assert.equal(result.discarded, true);
      assert.equal(result.proxyUrl, example.sanitized);
      assert.equal(updatedUrl, example.sanitized);
      assert.equal(secrets.values.has(PROXY_CREDENTIAL_SECRET_KEY), false);
    }
  });

  it('round-trips escape-heavy passwords at the accepted size', async () => {
    const secrets = new MemorySecrets();
    const password = '\\'.repeat(12_000);
    await storeBoundProxyPassword(secrets, 'http://alice@proxy.local:3128', password);
    assert.equal(
      (await readBoundProxyPassword(secrets, 'http://alice@proxy.local:3128'))?.password,
      password,
    );
  });
});
