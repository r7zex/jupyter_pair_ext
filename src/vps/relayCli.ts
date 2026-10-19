import http from 'node:http';
import https from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { VpsServer } from './server';

// Reuse the audited relay implementation. No worker, kernel or session API is exposed.
async function main(): Promise<void> {
  const port = Number(process.env.PAIR_VPS_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port.');
  const temporary = !process.env.PAIR_VPS_DATA;
  const directory = process.env.PAIR_VPS_DATA ?? await mkdtemp(path.join(os.tmpdir(), 'pair-relay-'));
  const broker = new VpsServer({ clientToken: randomBytes(48).toString('base64url'), agentTokens: {}, dataDirectory: directory });
  // The broker listens on an ephemeral loopback port. Only the temporary WS route
  // and health are forwarded through the externally configured listener.
  const upstream = await broker.start(0, '127.0.0.1');
  const instanceId = randomUUID();
  const handler: http.RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', relayOnly: true, version: '0.6.17', instanceId }));
    } else { response.writeHead(404); response.end(); }
  };
  const server = process.env.PAIR_RELAY_TLS_PFX
    ? https.createServer({ pfx: await readFile(process.env.PAIR_RELAY_TLS_PFX), passphrase: process.env.PAIR_RELAY_TLS_PASSWORD }, handler)
    : http.createServer(handler);
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/v1/temporary-relay') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const proxy = http.request({ host: '127.0.0.1', port: upstream, path: request.url, headers: request.headers });
    proxy.on('upgrade', (response, remote, buffered) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head);
      if (buffered.length) socket.write(buffered);
      socket.pipe(remote).pipe(socket);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    proxy.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Relay Unavailable\r\nConnection: close\r\n\r\n`); });
    proxy.on('error', () => socket.destroy()); socket.on('error', () => proxy.destroy()); proxy.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.PAIR_VPS_BIND ?? '127.0.0.1', resolve); });
  console.log(`Pair Notebook relay listening on ${port}. No Python worker required.`);
  let stopping = false;
  const stop = (): void => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections(); void broker.stop().then(async () => { if (temporary) await rm(directory, { recursive: true, force: true }); process.exit(0); }, () => process.exit(1)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (process.env.PAIR_RELAY_CONTROL_STDIN === '1') {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (value: string) => { if (value.trim() === 'stop') stop(); });
    process.stdin.on('end', stop);
  }
}
void main().catch(() => { console.error('Relay could not start. Check its port and private data directory.'); process.exitCode = 1; });
