import http from 'node:http';
import https from 'node:https';
import { createRuntimeProxyAgent } from '../runtime/proxyWebSocket';
import { normalizeVpsUrl } from './protocol';
import type { PersistentLiveEvent } from './persistentLive';

export type PersistentCredential = { kind: 'anonymous' } | { kind: 'admin' | 'membership'; token: string };

export class PersistentHttpError extends Error {
  public constructor(public readonly status: number) {
    super(status === 409 ? 'The server project changed. Reload its latest version before saving your edit.'
      : status === 401 ? 'Your session credentials expired or were revoked. Connect again.'
        : status === 423 ? 'This line is occupied by another participant.'
        : status === 403 ? 'The server denied this operation for your session identity.'
          : status === 404 ? 'The session, file or execution is unavailable.'
            : status === 429 ? 'Too many requests. Wait before trying again.'
              : `Persistent VPS request failed (HTTP ${status}).`);
  }
}

/** Session credentials are deliberately confined to the persistent RPC endpoint. */
export class PersistentClient {
  public readonly endpoint: string;
  public constructor(endpoint: string, private readonly credential: PersistentCredential, private readonly deadlineMs = 15_000) {
    this.endpoint = normalizeVpsUrl(endpoint);
    if (credential.kind !== 'anonymous' && !/^[A-Za-z0-9_-]{32,256}$/.test(credential.token)) {
      throw new Error('Invalid persistent session credential. Connect again.');
    }
  }

  public call<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    if (['create', 'list'].includes(operation) && this.credential.kind !== 'admin') {
      return Promise.reject(new Error('This action requires a VPS administrative credential.'));
    }
    if (!['create', 'list', 'join', 'discover', 'acceptInvitation'].includes(operation) && this.credential.kind !== 'membership') {
      return Promise.reject(new Error('Join a persistent session before using its API.'));
    }
    const url = new URL(`${this.endpoint}/v1/sessions/rpc`);
    const bytes = Buffer.from(JSON.stringify({ ...input, operation }));
    let agent: http.Agent | undefined;
    try { agent = createRuntimeProxyAgent(url.toString()); }
    catch { return Promise.reject(new Error('Cannot configure the VPS connection proxy.')); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value!);
      };
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', agent,
        headers: {
          'content-type': 'application/json', 'content-length': bytes.length,
          ...(this.credential.kind === 'anonymous' ? {} : { authorization: `Bearer ${this.credential.token}` }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 24 * 1024 * 1024) { finish(new Error('Persistent VPS response is too large.')); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('Persistent VPS response was interrupted.')));
        response.on('end', () => {
          if (response.statusCode !== 200) { finish(new PersistentHttpError(response.statusCode ?? 0)); return; }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { finish(new Error('Persistent VPS returned invalid JSON.')); }
        });
      });
      const deadline = setTimeout(() => {
        finish(new Error('VPS request timed out. Use the same request ID to recover an accepted execution.'));
        request.destroy();
      }, this.deadlineMs);
      deadline.unref();
      request.on('error', () => finish(new Error('Cannot reach the VPS. Check its address, TLS certificate and network connection.')));
      request.end(bytes);
    });
  }

  public subscribe(sessionId: string, receive: (event: PersistentLiveEvent) => void, disconnected: () => void): { dispose(): void } {
    if (this.credential.kind !== 'membership') throw new Error('Join a persistent session before subscribing.');
    const url = new URL(`${this.endpoint}/v1/sessions/rpc`);
    const bytes = Buffer.from(JSON.stringify({ operation: 'subscribe', sessionId }));
    let closed = false; let connected = false;
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', agent: createRuntimeProxyAgent(url.toString()),
      headers: { 'content-type': 'application/json', 'content-length': bytes.length, authorization: `Bearer ${this.credential.token}` },
    }, (response) => {
      clearTimeout(deadline);
      if (response.statusCode !== 200) { request.destroy(); finish(); return; }
      connected = true; response.setEncoding('utf8'); let pending = '';
      response.setTimeout(10_000, () => { response.destroy(); finish(); });
      response.on('data', (chunk: string) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > 512 * 1024) { response.destroy(); finish(); return; }
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (!packet.startsWith('data: ')) continue;
          try { receive(JSON.parse(packet.slice(6)) as PersistentLiveEvent); } catch { response.destroy(); finish(); return; }
        }
      });
      response.on('end', finish); response.on('error', finish); response.on('close', finish);
    });
    const finish = (): void => { clearTimeout(deadline); if (!closed) { closed = true; disconnected(); } };
    const deadline = setTimeout(() => { if (!connected) request.destroy(); finish(); }, this.deadlineMs); deadline.unref();
    request.on('error', finish); request.end(bytes);
    return { dispose: () => { closed = true; clearTimeout(deadline); request.destroy(); } };
  }
}
