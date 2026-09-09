import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomicFile';
import { validateIdentityPrivateKey } from './identity';
import { LaunchBaselineV1 } from './projectBaseline';
import { PEER_ID_PATTERN, SessionDescriptor } from './types';

const CONTROL_DOMAIN = 'pair-notebook-local-launch-control-v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_BASELINE_BYTES = 64 * 1024 * 1024;

export type LaunchControlState = 'pending' | 'committing' | 'established';

export interface SessionLaunchControlV1 {
  version: 1;
  generation: number;
  launchId: string;
  kind: 'start' | 'join';
  state: LaunchControlState;
  sessionId: string;
  projectId: string;
  peerId: string;
  role: 'host' | 'peer';
  workingFolderRealPath: string;
  backingFolderRealPath?: string | undefined;
  markerSha256: string;
  nextMarkerSha256?: string | undefined;
  baselineSha256: string;
  createdAt: number;
  mac: string;
}

export type LaunchRecoveryAction = 'resume-pending' | 'resume-committing' | 'established' | 'integrity-error';

export interface SessionControlPaths {
  root: string;
  control: string;
  baseline: string;
  owner: string;
  workspace: string;
  marker: string;
}

export function sessionControlPaths(globalStorageRoot: string, sessionId: string, peerId: string): SessionControlPaths {
  assertId(sessionId, 'session');
  assertId(peerId, 'peer');
  const root = path.join(globalStorageRoot, 'sessions', sessionId, peerId);
  const workspace = path.join(root, 'workspace');
  return {
    root,
    control: path.join(root, 'control.json'),
    baseline: path.join(root, 'baseline.json'),
    owner: path.join(root, 'runtime-owner.json'),
    workspace,
    marker: path.join(workspace, '.pair-notebook-session.json'),
  };
}

export function serializeSessionDescriptor(descriptor: SessionDescriptor): string {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

export function serializeLaunchBaseline(baseline: LaunchBaselineV1): string {
  return `${JSON.stringify(baseline)}\n`;
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSessionLaunchControl(
  fields: Omit<SessionLaunchControlV1, 'version' | 'mac'>,
  identityPrivateKey: string,
): SessionLaunchControlV1 {
  const control: SessionLaunchControlV1 = { version: 1, ...fields, mac: '' };
  validateUnsignedControl(control);
  control.mac = signControl(control, identityPrivateKey);
  return control;
}

export function verifySessionLaunchControl(value: unknown, identityPrivateKey: string): SessionLaunchControlV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Session launch control is not an object.');
  }
  const control = value as SessionLaunchControlV1;
  validateUnsignedControl(control);
  if (typeof control.mac !== 'string' || !SHA256_PATTERN.test(control.mac)) {
    throw new Error('Session launch control MAC has an unsupported format.');
  }
  const expected = Buffer.from(signControl(control, identityPrivateKey), 'hex');
  const actual = Buffer.from(control.mac, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Session launch control authentication failed.');
  }
  return { ...control };
}

export function classifyLaunchRecovery(control: SessionLaunchControlV1, markerSha256: string): LaunchRecoveryAction {
  if (!SHA256_PATTERN.test(markerSha256)) return 'integrity-error';
  if (control.state === 'pending') {
    return markerSha256 === control.markerSha256 ? 'resume-pending' : 'integrity-error';
  }
  if (control.state === 'committing') {
    if (markerSha256 === control.markerSha256) return 'resume-pending';
    if (control.nextMarkerSha256 && markerSha256 === control.nextMarkerSha256) return 'resume-committing';
    return 'integrity-error';
  }
  return markerSha256 === control.markerSha256 && control.nextMarkerSha256 === undefined
    ? 'established'
    : 'integrity-error';
}

export async function writeLaunchBaseline(target: string, baseline: LaunchBaselineV1): Promise<string> {
  const bytes = serializeLaunchBaseline(baseline);
  await atomicWriteFile(target, bytes);
  return sha256(bytes);
}

export async function writeSessionLaunchControl(target: string, control: SessionLaunchControlV1): Promise<void> {
  await atomicWriteFile(target, `${JSON.stringify(control)}\n`);
}

export async function readSessionLaunchControl(
  target: string,
  identityPrivateKey: string,
): Promise<SessionLaunchControlV1> {
  const bytes = await readBoundedRegularFile(target, MAX_CONTROL_BYTES);
  return verifySessionLaunchControl(JSON.parse(bytes.toString('utf8')), identityPrivateKey);
}

export async function readLaunchBaseline(target: string, expectedSha256: string): Promise<LaunchBaselineV1> {
  const bytes = await readBoundedRegularFile(target, MAX_BASELINE_BYTES);
  if (sha256(bytes) !== expectedSha256) throw new Error('Session launch baseline integrity check failed.');
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<LaunchBaselineV1>;
  if (parsed.version !== 1 || !parsed.working || typeof parsed.working !== 'object') {
    throw new Error('Session launch baseline has an unsupported schema.');
  }
  return parsed as LaunchBaselineV1;
}

export async function assertExactSessionWorkspace(
  currentWorkspace: string,
  expectedWorkspace: string,
  recordedWorkspaceRealPath: string,
): Promise<string> {
  const [currentRealPath, expectedRealPath] = await Promise.all([
    realpath(currentWorkspace),
    realpath(expectedWorkspace),
  ]);
  if (!samePhysicalPath(currentRealPath, expectedRealPath)
    || !samePhysicalPath(currentRealPath, recordedWorkspaceRealPath)) {
    throw new Error('The current workspace is not the physical workspace bound to this launch.');
  }
  return currentRealPath;
}

export async function readBoundedRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error(`Refusing unsafe or oversized control file: ${target}`);
  }
  const handle = await open(target, 'r');
  try {
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Control file exceeds ${maxBytes} bytes: ${target}`);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function signControl(control: SessionLaunchControlV1, identityPrivateKey: string): string {
  const privateKeyError = validateIdentityPrivateKey(identityPrivateKey);
  if (privateKeyError) throw new Error(`Session identity is invalid: ${privateKeyError}.`);
  const key = createHash('sha256')
    .update(CONTROL_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(Buffer.from(identityPrivateKey, 'base64url'))
    .digest();
  return createHmac('sha256', key).update(canonicalControl(control), 'utf8').digest('hex');
}

function canonicalControl(control: SessionLaunchControlV1): string {
  return JSON.stringify({
    version: control.version,
    generation: control.generation,
    launchId: control.launchId,
    kind: control.kind,
    state: control.state,
    sessionId: control.sessionId,
    projectId: control.projectId,
    peerId: control.peerId,
    role: control.role,
    workingFolderRealPath: control.workingFolderRealPath,
    ...(control.backingFolderRealPath !== undefined ? { backingFolderRealPath: control.backingFolderRealPath } : {}),
    markerSha256: control.markerSha256,
    ...(control.nextMarkerSha256 !== undefined ? { nextMarkerSha256: control.nextMarkerSha256 } : {}),
    baselineSha256: control.baselineSha256,
    createdAt: control.createdAt,
  });
}

function validateUnsignedControl(control: SessionLaunchControlV1): void {
  if (control.version !== 1) throw new Error('Session launch control has an unsupported version.');
  if (!Number.isSafeInteger(control.generation) || control.generation < 1) {
    throw new Error('Session launch control generation is invalid.');
  }
  assertId(control.launchId, 'launch');
  assertId(control.sessionId, 'session');
  assertId(control.projectId, 'project');
  assertId(control.peerId, 'peer');
  if (control.kind !== 'start' && control.kind !== 'join') throw new Error('Session launch kind is invalid.');
  if (!['pending', 'committing', 'established'].includes(control.state)) throw new Error('Session launch state is invalid.');
  if (control.role !== 'host' && control.role !== 'peer') throw new Error('Session launch role is invalid.');
  if (!path.isAbsolute(control.workingFolderRealPath) || control.workingFolderRealPath.length > 4_096) {
    throw new Error('Session launch workspace path is invalid.');
  }
  if (control.backingFolderRealPath !== undefined
    && (!path.isAbsolute(control.backingFolderRealPath) || control.backingFolderRealPath.length > 4_096)) {
    throw new Error('Session launch backing path is invalid.');
  }
  if (!SHA256_PATTERN.test(control.markerSha256)
    || !SHA256_PATTERN.test(control.baselineSha256)
    || (control.nextMarkerSha256 !== undefined && !SHA256_PATTERN.test(control.nextMarkerSha256))) {
    throw new Error('Session launch digest is invalid.');
  }
  if (control.state === 'committing' && control.nextMarkerSha256 === undefined) {
    throw new Error('Committing launch control is missing the next marker digest.');
  }
  if (control.state !== 'committing' && control.nextMarkerSha256 !== undefined) {
    throw new Error('Only committing launch control may contain a next marker digest.');
  }
  if (!Number.isSafeInteger(control.createdAt) || control.createdAt < 0) {
    throw new Error('Session launch creation time is invalid.');
  }
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || !PEER_ID_PATTERN.test(value)) {
    throw new Error(`Session ${label} identity is invalid.`);
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
