import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { assertProxyReachable } from '../src/runtime/proxyReadiness';

describe('selected proxy readiness', () => {
  it('allows networks with no configured proxy', async () => {
    await assertProxyReachable({ env: {} });
  });

  it('probes the selected endpoint without sending credentials and sanitizes refusal', async () => {
    let bytes = 0;
    const server = createServer((socket) => socket.on('data', (chunk) => { bytes += chunk.length; }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = { vscodeProxy: `http://private-user:private-password@127.0.0.1:${address.port}`, env: {} };
    try { await assertProxyReachable(options); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    assert.equal(bytes, 0);
    await assert.rejects(assertProxyReachable(options), (error: Error) => {
      assert.match(error.message, /Configured proxy .*ECONNREFUSED/);
      assert.doesNotMatch(error.message, /private-user|private-password/);
      return true;
    });
  });
});
