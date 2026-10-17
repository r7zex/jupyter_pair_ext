import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PersistentClient } from '../src/vps/persistentClient';

describe('server dashboard network measurements', () => {
  it('measures actual RPC payload traffic and heartbeat response time without another probe', async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests += 1;
      request.resume();
      request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end('{"state":"running"}'); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new PersistentClient(`http://127.0.0.1:${address.port}`, { kind: 'membership', token: 'a'.repeat(48) });
    try {
      await client.call('heartbeat', { sessionId: 'project' });
      const traffic = client.networkSnapshot();
      assert.ok(traffic.up > 0 && traffic.down > 0);
      assert.ok(traffic.latencyMs !== undefined && traffic.latencyMs >= 0);
      assert.equal(client.networkSnapshot().up, 0);
      assert.equal(client.networkSnapshot().down, 0);
      assert.equal(requests, 1, 'dashboard sampling must not create new network probes');
    } finally { client.dispose(); server.close(); await once(server, 'close'); }
  });
});
