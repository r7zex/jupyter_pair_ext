import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { createRuntimeProxyAgent } from '../runtime/proxyWebSocket';
import { normalizeVpsUrl } from './protocol';
import type { PersistentLiveEvent } from './persistentLive';
import { PERSISTENT_PROTOCOL, SERVER_VERSION } from './compatibility';
import { systemTlsOptions } from '../runtime/systemTls';

export type PersistentCredential = { kind: 'anonymous' } | { kind: 'admin' | 'membership'; token: string };

export class PersistentHttpError extends Error {
  public constructor(public readonly status: number, detail?: string) {
    super((status === 426 ? 'Client and server are incompatible. Install the matching Pair Notebook release, then reconnect. Unsaved editors and local history are preserved.'
      : status === 409 ? 'The server project changed. Reload its latest version before saving your edit.'
      : status === 401 ? 'Your session credentials expired or were revoked. Connect again.'
        : status === 423 ? 'This line is occupied by another participant.'
        : status === 403 ? 'The server denied this operation for your session identity.'
          : status === 404 ? 'The session, file or execution is unavailable.'
            : status === 429 ? 'Too many requests. Wait before trying again.'
              : `Persistent VPS request failed (HTTP ${status}).`) + (detail ? ` ${detail}` : ''));
  }
}

/** Session credentials are deliberately confined to the persistent RPC endpoint. */
export class PersistentClient {
  private readonly requests = new Set<http.ClientRequest>();
  public readonly endpoint: string;
  private receivedBytes = 0;
  private sentBytes = 0;
  private lastLatencyMs: number | undefined;
  private lastSample = { time: Date.now(), received: 0, sent: 0 };
  public networkSnapshot(): { down: number; up: number; latencyMs?: number } {
    const now = Date.now(), seconds = Math.max((now - this.lastSample.time) / 1000, 0.001);
    const result = { down: (this.receivedBytes - this.lastSample.received) / seconds, up: (this.sentBytes - this.lastSample.sent) / seconds, ...(this.lastLatencyMs !== undefined ? { latencyMs: this.lastLatencyMs } : {}) };
    this.lastSample = { time: now, received: this.receivedBytes, sent: this.sentBytes };
    return result;
  }
  public async checkCompatibility(): Promise<void> {
    let result: { protocol: number; features: string[]; minimumClientVersion?: string };
    try { result = await this.call('compatibility'); }
    catch (error) {
      if (error instanceof PersistentHttpError && [400, 404].includes(error.status)) throw new PersistentHttpError(426, 'Update the server to 0.6.7 or later to enable compatibility checks.');
      throw error;
    }
    if (!result || result.protocol !== PERSISTENT_PROTOCOL || !Array.isArray(result.features) || !result.features.includes('notebook-bootstrap-empty-v1')) throw new PersistentHttpError(426);
    if (result.minimumClientVersion !== undefined) {
      if (!/^\d+\.\d+\.\d+$/.test(result.minimumClientVersion)) throw new PersistentHttpError(426);
      const required = result.minimumClientVersion.split('.').map(Number), current = SERVER_VERSION.split('.').map(Number);
      const difference = current.findIndex((value, index) => value !== required[index]);
      if (difference >= 0 && current[difference]! < required[difference]!) throw new PersistentHttpError(426, `Server requires client ${result.minimumClientVersion} or later.`);
    }
  }
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
    if (!['compatibility', 'create', 'list', 'join', 'discover', 'acceptInvitation'].includes(operation) && this.credential.kind !== 'membership') {
      return Promise.reject(new Error('Join a persistent session before using its API.'));
    }
    if (operation === 'write' && typeof input.content === 'string' && input.content.length > 350_000) return this.writeLarge<T>(input);
    const url = new URL(`${this.endpoint}/v1/sessions/rpc`);
    const bytes = Buffer.from(JSON.stringify({ ...input, operation }));
    const started = Date.now();
    let agent: http.Agent | undefined;
    try { agent = createRuntimeProxyAgent(url.toString()); }
    catch { return Promise.reject(new Error('Cannot configure the VPS connection proxy.')); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        this.requests.delete(request);
        if (!error && operation === 'heartbeat') this.lastLatencyMs = Date.now() - started;
        if (error) reject(error); else resolve(value!);
      };
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', agent, ...(url.protocol === 'https:' ? systemTlsOptions(url) : {}),
        headers: {
          'content-type': 'application/json', 'content-length': bytes.length, 'x-pair-client-version': SERVER_VERSION,
          ...(this.credential.kind === 'anonymous' ? {} : { authorization: `Bearer ${this.credential.token}` }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          this.receivedBytes += chunk.length;
          if (length > 192 * 1024 * 1024) { finish(new Error('Persistent VPS response is too large.')); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('Persistent VPS response was interrupted.')));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            let detail: string | undefined;
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown; requestId?: unknown };
              if (typeof body.error === 'string' && body.error.length <= 2048) detail = body.error;
              if (typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId)) detail = `${detail ?? 'VPS operation failed.'} Server request ID: ${body.requestId}`;
            } catch { /* Non-JSON proxies retain the HTTP status fallback. */ }
            finish(new PersistentHttpError(response.statusCode ?? 0, detail)); return;
          }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { finish(new Error('Persistent VPS returned invalid JSON.')); }
        });
      });
      const deadline = setTimeout(() => {
        finish(new Error('VPS request timed out. Use the same request ID to recover an accepted execution.'));
        request.destroy();
      }, this.deadlineMs);
      deadline.unref();
      this.requests.add(request);
      request.on('error', (error: NodeJS.ErrnoException) => {
        const message = error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'The server certificate does not match its address. Use the domain or IP in its certificate.'
          : ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code ?? '') ? 'The server certificate is not trusted. Install the server root CA on this client or repair its public certificate chain.'
            : ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'].includes(error.code ?? '') ? 'The server certificate is expired or not yet valid. Check certificate renewal and the server clock.'
              : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code ?? '') ? 'Cannot resolve the server address. Check its DNS records and your network.'
                : 'Cannot reach the server. Check its address, HTTPS port, proxy and network connection.';
        finish(new Error(message));
      });
      this.sentBytes += bytes.length;
      request.end(bytes);
    });
  }
  public dispose(): void { for (const request of this.requests) request.destroy(); this.requests.clear(); }

  private async writeLarge<T>(input: Record<string, unknown>): Promise<T> {
    const bytes = Buffer.from(input.content as string, 'base64');
    if (bytes.length > 128 * 1024 * 1024) throw new Error('File exceeds the 128 MiB project limit.');
    const uploadId = createHash('sha256').update(randomUUID()).digest('hex'); const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        const chunk = bytes.subarray(offset, offset + 256 * 1024);
        const reply = await this.call<{ offset: number }>('uploadChunk', { sessionId: input.sessionId, path: input.path, uploadId,
          sha256: hash, size: bytes.length, version: input.expectedRevision, offset, content: chunk.toString('base64') });
        if (reply.offset !== offset + chunk.length) throw new Error('VPS acknowledged an invalid upload offset.');
      }
      const commit = { sessionId: input.sessionId, path: input.path, uploadId, sha256: hash, expectedRevision: input.expectedRevision, ...(input.visibility ? { visibility: input.visibility } : {}) };
      try { return await this.call<T>('commitUpload', commit); }
      catch (error) { if (error instanceof PersistentHttpError) throw error; return await this.call<T>('commitUpload', commit); }
    } finally { await this.call('discardUpload', { sessionId: input.sessionId, uploadId }).catch(() => undefined); }
  }

  public subscribe(sessionId: string, receive: (event: PersistentLiveEvent) => void, disconnected: () => void): { dispose(): void } {
    if (this.credential.kind !== 'membership') throw new Error('Join a persistent session before subscribing.');
    const url = new URL(`${this.endpoint}/v1/sessions/rpc`);
    const bytes = Buffer.from(JSON.stringify({ operation: 'subscribe', sessionId }));
    let closed = false; let connected = false;
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', agent: createRuntimeProxyAgent(url.toString()), ...(url.protocol === 'https:' ? systemTlsOptions(url) : {}),
      headers: { 'content-type': 'application/json', 'content-length': bytes.length, authorization: `Bearer ${this.credential.token}` },
    }, (response) => {
      clearTimeout(deadline);
      if (response.statusCode !== 200) { request.destroy(); finish(); return; }
      connected = true; response.setEncoding('utf8'); let pending = '';
      response.setTimeout(10_000, () => { response.destroy(); finish(); });
      response.on('data', (chunk: string) => {
        this.receivedBytes += Buffer.byteLength(chunk);
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
    request.on('error', finish); this.sentBytes += bytes.length; request.end(bytes);
    return { dispose: () => { closed = true; clearTimeout(deadline); request.destroy(); } };
  }
}
