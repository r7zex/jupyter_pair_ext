import http from 'node:http';
import https from 'node:https';
import { createRuntimeProxyAgent } from '../runtime/proxyWebSocket';
import { type JobSubmission, type JobSummary, type VpsAgent, type VpsJob, normalizeVpsUrl } from './protocol';

export class VpsHttpError extends Error {
  public constructor(public readonly status: number) { super(`VPS request failed (HTTP ${status}).`); }
}

export class VpsClient {
  public readonly endpoint: string;
  public constructor(endpoint: string, private readonly token: string, private readonly deadlineMs = 15_000) {
    this.endpoint = normalizeVpsUrl(endpoint);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('The stored VPS access token is invalid. Connect to VPS again.');
  }

  public agents(): Promise<VpsAgent[]> { return this.request('GET', '/v1/agents'); }
  public jobs(): Promise<JobSummary[]> { return this.request('GET', '/v1/jobs'); }
  public submit(job: JobSubmission): Promise<JobSummary> { return this.request('POST', '/v1/jobs', job); }
  public job(id: string, offset?: number): Promise<Omit<VpsJob, 'files' | 'args'>> {
    return this.request('GET', `/v1/jobs/${encodeURIComponent(id)}${offset === undefined ? '' : `?offset=${offset}`}`);
  }
  public cancel(id: string): Promise<JobSummary> { return this.request('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}); }

  private request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = new URL(this.endpoint + route);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let agent: http.Agent | undefined;
    try { agent = createRuntimeProxyAgent(url.toString()); }
    catch { return Promise.reject(new Error('Cannot configure the VPS connection proxy. Check Pair Notebook network settings.')); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value!);
      };
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, agent,
        headers: { authorization: `Bearer ${this.token}`, ...(bytes ? {
          'content-type': 'application/json', 'content-length': bytes.length,
        } : {}) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 6 * 1024 * 1024) { finish(new Error('VPS response is too large.')); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('VPS response was interrupted.')));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            // Do not surface proxy HTML, URLs, headers or credential-bearing transport errors.
            finish(new VpsHttpError(response.statusCode ?? 0)); return;
          }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { finish(new Error('VPS returned invalid JSON.')); }
        });
      });
      const deadline = setTimeout(() => { finish(new Error('VPS request timed out. Its submission may still have been accepted.')); request.destroy(); }, this.deadlineMs);
      deadline.unref();
      request.setTimeout(this.deadlineMs, () => request.destroy());
      request.on('error', () => finish(new Error('Cannot reach the VPS. Check its address, TLS certificate and network connection.')));
      request.end(bytes);
    });
  }
}
