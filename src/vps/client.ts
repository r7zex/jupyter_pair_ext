import http from 'node:http';
import https from 'node:https';
import { createRuntimeProxyAgent } from '../runtime/proxyWebSocket';
import { type JobSubmission, type JobSummary, type VpsAgent, type VpsJob, normalizeVpsUrl } from './protocol';

export class VpsClient {
  public readonly endpoint: string;
  public constructor(endpoint: string, private readonly token: string) {
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
          if (length > 6 * 1024 * 1024) { request.destroy(); reject(new Error('VPS response is too large.')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('VPS response was interrupted.')));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            // Do not surface proxy HTML, URLs, headers or credential-bearing transport errors.
            reject(new Error(`VPS request failed (HTTP ${response.statusCode ?? 'unknown'}).`)); return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { reject(new Error('VPS returned invalid JSON.')); }
        });
      });
      request.setTimeout(15_000, () => request.destroy());
      request.on('error', () => reject(new Error('Cannot reach the VPS. Check its address, TLS certificate and network connection.')));
      request.end(bytes);
    });
  }
}
