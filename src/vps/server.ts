import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { atomicWriteFile } from '../core/atomicFile';
import { AGENT_ONLINE_MS, LOG_RETENTION_BYTES, MAX_JOB_BYTES, MAX_LOG_CHUNK, VPS_ID,
  type AgentResources, type JobStatus, type VpsAgent, type VpsJob, jobSummary, terminalJob, validateSubmission } from './protocol';

export interface VpsServerOptions {
  dataDirectory: string;
  clientToken: string;
  /** One independent credential per owner-approved compute machine. */
  agentTokens: Record<string, string>;
}

class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

function equalToken(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

function resources(raw: any): AgentResources {
  if (!raw || !Number.isInteger(raw.cpuCount) || raw.cpuCount < 1 || raw.cpuCount > 65536
    || typeof raw.python !== 'string' || raw.python.length > 512 || !Array.isArray(raw.gpus) || raw.gpus.length > 64
    || raw.gpus.some((gpu: any) => !Number.isInteger(gpu.index) || gpu.index < 0 || gpu.index > 999
      || typeof gpu.name !== 'string' || gpu.name.length > 200 || !Number.isFinite(gpu.memoryMb) || gpu.memoryMb < 0)) {
    throw new HttpError(400, 'Invalid compute inventory.');
  }
  return { cpuCount: raw.cpuCount, python: raw.python,
    gpus: raw.gpus.map((gpu: any) => ({ index: gpu.index, name: gpu.name, memoryMb: gpu.memoryMb })) };
}

/** A single-writer durable job broker and an opaque relay for one trusted team. */
export class VpsServer {
  private readonly jobs = new Map<string, VpsJob>();
  private readonly agents = new Map<string, VpsAgent>();
  private readonly agentTokens: Map<string, string>;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly server = http.createServer((request, response) => { void this.handle(request, response); });
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 * 1024 });
  private readonly rooms = new Map<string, Map<string, { socket: WebSocket; announce?: string }>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private stopPromise: Promise<void> | undefined;

  public constructor(private readonly options: VpsServerOptions) {
    const tokens = [options.clientToken, ...Object.values(options.agentTokens)];
    if (tokens.some((token) => typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
      || new Set(tokens).size !== tokens.length || Object.keys(options.agentTokens).some((id) => !VPS_ID.test(id))) {
      throw new Error('Use distinct random client and agent tokens (32–256 URL-safe characters) and valid agent IDs.');
    }
    this.agentTokens = new Map(Object.entries(options.agentTokens));
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const room = url.searchParams.get('room') ?? '';
      const peer = url.searchParams.get('peer') ?? '';
      if (url.pathname !== '/v1/relay' || !this.authorized(request, this.options.clientToken)
        || !/^[a-f0-9]{64}$/.test(room) || !VPS_ID.test(peer) || this.sockets.clients.size >= 128
        || (this.rooms.get(room)?.has(peer) ?? false)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      this.sockets.handleUpgrade(request, socket, head, (connection) => this.connectRelay(room, peer, connection));
    });
  }

  public async start(port = 0, host = '127.0.0.1'): Promise<number> {
    await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.options.dataDirectory)).filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name));
    if (files.length > 1000) throw new Error('VPS job store exceeds its 1000-job limit. Archive completed jobs first.');
    for (const name of files) {
      const job = JSON.parse(await readFile(path.join(this.options.dataDirectory, name), 'utf8')) as VpsJob;
      validateSubmission(job);
      if (name !== `${job.id}.json` || !Number.isSafeInteger(job.createdAt) || job.createdAt < 0
        || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)
        || !Number.isSafeInteger(job.logStart) || !Number.isSafeInteger(job.logEnd) || job.logStart < 0 || job.logEnd < job.logStart
        || typeof job.log !== 'string' || Buffer.from(job.log, 'base64').length !== job.logEnd - job.logStart
        || (job.status === 'running' && !VPS_ID.test(job.instanceId ?? ''))) throw new Error('VPS job store is inconsistent.');
      this.jobs.set(job.id, job);
    }
    const ordered = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.jobs.clear();
    for (const job of ordered) this.jobs.set(job.id, job);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => { this.server.off('error', reject); resolve(); });
    });
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.clients) {
        if ((socket as WebSocket & { awaitingPong?: boolean }).awaitingPong) { socket.terminate(); continue; }
        (socket as WebSocket & { awaitingPong?: boolean }).awaitingPong = true;
        socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
    return (this.server.address() as { port: number }).port;
  }

  public stop(): Promise<void> {
    return this.stopPromise ??= this.close();
  }

  private async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets.clients) socket.terminate();
    await this.serial;
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private authorized(request: IncomingMessage, token: string): boolean {
    const value = request.headers.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') && equalToken(value.slice(7), token);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const agentRoute = /^\/v1\/agents\/([A-Za-z0-9_-]{1,128})\/(poll|report)$/.exec(url.pathname);
      const token = agentRoute ? this.agentTokens.get(agentRoute[1]!) : this.options.clientToken;
      if (!token || !this.authorized(request, token)) throw new HttpError(401, 'Unauthorized.');
      let body: any;
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += (chunk as Buffer).length;
          if (length > MAX_JOB_BYTES) throw new HttpError(413, 'Request too large.');
          chunks.push(chunk as Buffer);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new HttpError(400, 'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
      }
      const operation = this.serial.then(() => this.dispatch(request.method ?? '', url.pathname, body, agentRoute, url.searchParams.get('offset')));
      this.serial = operation.catch(() => undefined);
      response.end(JSON.stringify(await operation));
    } catch (error) {
      response.statusCode = error instanceof HttpError ? error.status : 500;
      response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : 'VPS operation failed.' }));
    }
  }

  private async save(job: VpsJob): Promise<void> {
    await atomicWriteFile(path.join(this.options.dataDirectory, `${job.id}.json`), JSON.stringify(job));
    this.jobs.set(job.id, job);
  }

  private async dispatch(method: string, route: string, body: any, agentRoute: RegExpExecArray | null, logOffset: string | null): Promise<unknown> {
    if (agentRoute && method === 'POST') {
      const agentId = agentRoute[1]!;
      if (!VPS_ID.test(body.instanceId ?? '')) throw new HttpError(400, 'Invalid agent instance.');
      if (agentRoute[2] === 'report') return this.report(agentId, body);
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 128) throw new HttpError(400, 'Invalid agent name.');
      const running = [...this.jobs.values()].find((job) => job.agentId === agentId && job.status === 'running');
      if (running && running.instanceId !== body.instanceId) {
        throw new HttpError(409, 'A different agent installation owns the running job. Restore its state directory.');
      }
      this.agents.set(agentId, { id: agentId, name: body.name, instanceId: body.instanceId,
        resources: resources(body.resources), lastSeen: Date.now(), online: true });
      if (running) {
        return { job: body.knownJobId === running.id ? jobSummary(running) : running };
      }
      const next = [...this.jobs.values()].find((job) => job.agentId === agentId && job.status === 'queued');
      if (!next) return { job: null };
      if (next.device !== 'cpu' && !this.agents.get(agentId)!.resources.gpus.some((gpu) => `gpu:${gpu.index}` === next.device)) {
        const failure = Buffer.from('The selected GPU is not available on this agent.\n');
        await this.save({ ...next, status: 'failed', finishedAt: Date.now(), exitCode: -1,
          log: failure.toString('base64'), logStart: 0, logEnd: failure.length });
        return { job: null };
      }
      const claimed: VpsJob = { ...next, status: 'running', instanceId: body.instanceId, startedAt: Date.now() };
      await this.save(claimed);
      return { job: claimed };
    }
    if (method === 'GET' && route === '/v1/agents') {
      return [...this.agents.values()].map((agent) => ({ ...agent, online: Date.now() - agent.lastSeen < AGENT_ONLINE_MS }));
    }
    if (method === 'GET' && route === '/v1/jobs') return [...this.jobs.values()].reverse().map(jobSummary);
    if (method === 'POST' && route === '/v1/jobs') {
      let input;
      try { input = validateSubmission(body); } catch { throw new HttpError(400, 'Invalid or oversized Python job.'); }
      if (!this.agentTokens.has(input.agentId)) throw new HttpError(400, 'Unknown compute agent.');
      const existing = this.jobs.get(input.id);
      if (existing) {
        // A retry after a lost HTTP response cannot start the same training twice.
        if (JSON.stringify(validateSubmission(existing)) !== JSON.stringify(input)) throw new HttpError(409, 'Job ID already has different input.');
        return jobSummary(existing);
      }
      if (this.jobs.size >= 1000) throw new HttpError(409, 'Job store is full. Archive completed jobs first.');
      const createdAt = Math.max(Date.now(), ...[...this.jobs.values()].map((job) => job.createdAt + 1));
      const job: VpsJob = { ...input, status: 'queued', createdAt, cancelRequested: false, logStart: 0, logEnd: 0, log: '' };
      await this.save(job);
      return jobSummary(job);
    }
    const match = /^\/v1\/jobs\/([A-Za-z0-9_-]{1,128})(\/cancel)?$/.exec(route);
    if (match) {
      const job = this.jobs.get(match[1]!);
      if (!job) throw new HttpError(404, 'Job not found.');
      if (method === 'GET' && !match[2]) {
        if (logOffset !== null && (!/^\d+$/.test(logOffset) || !Number.isSafeInteger(Number(logOffset)))) throw new HttpError(400, 'Invalid log offset.');
        const start = logOffset === null ? job.logStart : Math.min(job.logEnd, Math.max(job.logStart, Number(logOffset)));
        return { ...jobSummary(job), logStart: start,
          log: Buffer.from(job.log, 'base64').subarray(start - job.logStart).toString('base64') };
      }
      if (method === 'POST' && match[2]) {
        if (terminalJob(job.status)) return jobSummary(job);
        const cancelled: VpsJob = { ...job, cancelRequested: true,
          ...(job.status === 'queued' ? { status: 'cancelled' as const, finishedAt: Date.now() } : {}) };
        await this.save(cancelled);
        return jobSummary(cancelled);
      }
    }
    throw new HttpError(404, 'Route not found.');
  }

  private async report(agentId: string, body: any): Promise<unknown> {
    const current = this.jobs.get(body.jobId);
    if (!current || current.agentId !== agentId || current.instanceId !== body.instanceId) throw new HttpError(403, 'Agent does not own this job.');
    if (!Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > current.logEnd
      || typeof body.log !== 'string' || body.log.length > Math.ceil(MAX_LOG_CHUNK * 4 / 3) + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.log)) {
      throw new HttpError(409, 'Invalid log chunk or offset.');
    }
    const bytes = Buffer.from(body.log, 'base64');
    if (bytes.length > MAX_LOG_CHUNK) throw new HttpError(413, 'Log chunk too large.');
    const append = bytes.subarray(Math.min(bytes.length, current.logEnd - body.offset));
    if (terminalJob(current.status)) return { offset: current.logEnd, cancelRequested: current.cancelRequested };
    let updated: VpsJob = { ...current };
    if (append.length) {
      const all = Buffer.concat([Buffer.from(current.log, 'base64'), append]);
      updated.logEnd += append.length;
      updated.log = all.subarray(Math.max(0, all.length - LOG_RETENTION_BYTES)).toString('base64');
      updated.logStart = updated.logEnd - Math.min(all.length, LOG_RETENTION_BYTES);
    }
    if (body.result !== undefined) {
      const result = body.result;
      const allowed: JobStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];
      if (!result || !allowed.includes(result.status) || !Number.isInteger(result.exitCode)
        || (result.status === 'succeeded' && result.exitCode !== 0)
        || (result.status === 'failed' && result.exitCode === 0)
        || (result.status === 'cancelled' && !current.cancelRequested)) throw new HttpError(400, 'Invalid completion.');
      updated = { ...updated, status: result.status, exitCode: result.exitCode, finishedAt: Date.now() };
    }
    if (append.length || body.result !== undefined) await this.save(updated);
    return { offset: updated.logEnd, cancelRequested: updated.cancelRequested };
  }

  private connectRelay(room: string, peer: string, socket: WebSocket): void {
    const members = this.rooms.get(room) ?? new Map<string, { socket: WebSocket; announce?: string }>();
    this.rooms.set(room, members);
    const member: { socket: WebSocket; announce?: string } = { socket };
    members.set(peer, member);
    socket.on('error', () => undefined);
    socket.on('pong', () => { (socket as WebSocket & { awaitingPong?: boolean }).awaitingPong = false; });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Invalid relay packet.');
        const message = JSON.parse(raw.toString()) as { t: string; f?: string; to?: string; d?: string; proof?: string };
        if (message.t === 'probe' && typeof message.d === 'string' && message.d.length <= 512) {
          socket.send(JSON.stringify({ t: 'probe', d: message.d }));
          for (const existing of members.values()) if (existing !== member && existing.announce) socket.send(existing.announce);
          return;
        }
        if (message.f !== peer || (message.to !== undefined && !VPS_ID.test(message.to))) throw new Error('Invalid relay sender.');
        if (message.t === 'announce' && typeof message.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(message.proof)) {
          member.announce = raw.toString();
        } else if (message.t !== 'data' || typeof message.d !== 'string') throw new Error('Invalid relay packet.');
        for (const [id, target] of members) {
          if (id === peer || (message.to && id !== message.to) || target.socket.readyState !== WebSocket.OPEN) continue;
          if (target.socket.bufferedAmount > 128 * 1024 * 1024) { target.socket.terminate(); continue; }
          target.socket.send(raw.toString());
        }
      } catch { socket.close(1008, 'Invalid relay packet.'); }
    });
    socket.on('close', () => {
      if (members.get(peer) === member) members.delete(peer);
      if (!members.size) this.rooms.delete(room);
    });
  }
}
