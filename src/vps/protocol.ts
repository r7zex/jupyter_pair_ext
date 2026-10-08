import { createHash } from 'node:crypto';

export const VPS_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_JOB_BYTES = 4 * 1024 * 1024;
export const MAX_JOB_FILES = 256;
export const MAX_LOG_CHUNK = 64 * 1024;
export const LOG_RETENTION_BYTES = 1024 * 1024;
export const AGENT_ONLINE_MS = 30_000;
export const GPU_UUID = /^GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type VpsDevice = 'cpu' | `gpu:${number}`;
export interface AgentResources {
  cpuCount: number;
  python: string;
  gpus: Array<{ index: number; name: string; memoryMb: number; uuid?: string }>;
}
export interface VpsAgent {
  id: string;
  name: string;
  instanceId: string;
  resources: AgentResources;
  lastSeen: number;
  online: boolean;
}
export interface JobSubmission {
  id: string;
  agentId: string;
  title: string;
  device: VpsDevice;
  /** Stable owner-reported GPU identity; older agents/jobs can use index alone. */
  gpuUuid?: string;
  entrypoint: string;
  files: Record<string, string>;
  args: string[];
}
export interface VpsJob extends JobSubmission {
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  instanceId?: string;
  exitCode?: number;
  cancelRequested: boolean;
  logStart: number;
  logEnd: number;
  /** Base64 retained log bytes; offsets refer to the full stream. */
  log: string;
}
export type JobSummary = Omit<VpsJob, 'files' | 'args' | 'log'>;

export function terminalJob(status: JobStatus): boolean {
  return !['queued', 'running'].includes(status);
}

/** Credentials belong to this exact endpoint; HTTP is only allowed on loopback. */
export function normalizeVpsUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS VPS URL without credentials, query or fragment (HTTP is allowed only on localhost).');
  }
  return url.toString().replace(/\/+$/, '');
}

export function vpsSecretKey(endpoint: string): string {
  return `pairNotebook.vpsToken.${createHash('sha256').update(normalizeVpsUrl(endpoint)).digest('hex')}`;
}

export function safeJobPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\\:*?"<>|\uD800-\uDFFF]/u.test(value) && [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    && value.split('/').every((part) => part.length > 0 && Buffer.byteLength(part) <= 255 && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part.normalize('NFKC')));
}

export function visibleVpsText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && [...value].every((character) => character.charCodeAt(0) > 31 && (character.charCodeAt(0) < 127 || character.charCodeAt(0) > 159))
    && !/[\uD800-\uDFFF\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u.test(value);
}

export function validateSubmission(raw: unknown): JobSubmission {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid job.');
  const job = raw as JobSubmission;
  if (typeof job.id !== 'string' || !VPS_ID.test(job.id) || typeof job.agentId !== 'string' || !VPS_ID.test(job.agentId)
    || !visibleVpsText(job.title, 200)
    || typeof job.device !== 'string' || !/^(cpu|gpu:(?:0|[1-9]\d{0,2}))$/.test(job.device) || !safeJobPath(job.entrypoint)
    || (job.gpuUuid !== undefined && (job.device === 'cpu' || typeof job.gpuUuid !== 'string'
      || !GPU_UUID.test(job.gpuUuid)))
    || !job.entrypoint.endsWith('.py') || !job.files || typeof job.files !== 'object' || Array.isArray(job.files)
    || !Object.hasOwn(job.files, job.entrypoint) || !Array.isArray(job.args) || job.args.length > 100
    || job.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || /[\uD800-\uDFFF]/u.test(arg))) {
    throw new Error('Invalid job target, Python entrypoint or arguments.');
  }
  const files = Object.entries(job.files);
  if (files.length > MAX_JOB_FILES || files.some(([key, value]) => !safeJobPath(key) || typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value))) throw new Error('Invalid or oversized source snapshot.');
  const names = files.map(([key]) => key.normalize('NFC').toLocaleUpperCase('en-US').toLocaleLowerCase('en-US'));
  if (new Set(names).size !== names.length || names.some((key) => names.some((other) => other.startsWith(`${key}/`)))) {
    throw new Error('Source snapshot contains conflicting file paths.');
  }
  const input = { id: job.id, agentId: job.agentId, title: job.title.trim(), device: job.device,
    ...(job.gpuUuid ? { gpuUuid: job.gpuUuid } : {}),
    entrypoint: job.entrypoint, files: { ...job.files }, args: [...job.args] };
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_JOB_BYTES) throw new Error('Invalid or oversized source snapshot.');
  return input;
}

export function jobSummary(job: VpsJob | JobSummary): JobSummary {
  const summary: JobSummary & Partial<Pick<VpsJob, 'files' | 'args' | 'log'>> = { ...job };
  delete summary.files;
  delete summary.args;
  delete summary.log;
  return summary;
}

/** File insertion order is not part of the immutable input identity. */
export function submissionDigest(raw: unknown): string {
  const input = validateSubmission(raw);
  return createHash('sha256').update(JSON.stringify({ ...input,
    files: Object.fromEntries(Object.entries(input.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  })).digest('hex');
}
