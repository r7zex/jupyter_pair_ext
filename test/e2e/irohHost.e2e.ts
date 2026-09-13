import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadIroh } from '../../src/runtime/irohNative';

suite('Iroh in the real VS Code Extension Host', () => {
  test('loads the bundled native transport and binds an isolated endpoint', async function () {
    if (process.platform === 'darwin' && process.arch === 'x64') { this.skip(); return; }
    const iroh = loadIroh();
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey([...randomBytes(32)]);
    builder.alpns([[112, 110]]);
    builder.bindAddr('127.0.0.1:0');
    const endpoint = await builder.bind();
    try {
      assert.equal(endpoint.id().toBytes().length, 32);
      assert.ok(endpoint.boundSockets().some((address) => address.startsWith('127.0.0.1:')));
    } finally { await endpoint.close(); }
  });
});
