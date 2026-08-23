import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomicFile';
import {
  PEER_ID_PATTERN,
  PeerIdentity,
  SessionDescriptor,
  validateDisplayName,
} from './types';

export const SESSION_TERMINATION_MARKER = '.pair-notebook-ended.json';
export const MAX_SESSION_TERMINATION_BYTES = 64 * 1024;

export interface SessionTermination {
  sessionId: string;
  projectId: string;
  sessionEpoch: number;
  endedAt: number;
  endedByPeerId: string;
  endedByDisplayName: string;
  proof: string;
}

export class SessionTerminatedError extends Error {
  public constructor(public readonly termination: SessionTermination) {
    super(`Pair Notebook session ${termination.sessionId} has already ended.`);
    this.name = 'SessionTerminatedError';
  }
}

export async function writeSessionTermination(
  descriptor: SessionDescriptor,
  token: string,
  endedBy: PeerIdentity,
): Promise<SessionTermination> {
  if (!descriptor.backingFolder) {
    throw new Error('The host must choose a backing folder before ending the session.');
  }
  const marker: SessionTermination = {
    sessionId: descriptor.sessionId,
    projectId: descriptor.projectId,
    sessionEpoch: descriptor.sessionEpoch,
    endedAt: Date.now(),
    endedByPeerId: endedBy.peerId,
    endedByDisplayName: endedBy.displayName,
    proof: '',
  };
  marker.proof = sign(marker, token);
  const target = path.join(descriptor.backingFolder, SESSION_TERMINATION_MARKER);
  await atomicWriteFile(target, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export async function readSessionTermination(
  descriptor: Pick<SessionDescriptor, 'sessionId' | 'projectId' | 'sessionEpoch' | 'backingFolder'>,
  token: string,
): Promise<SessionTermination | undefined> {
  if (!descriptor.backingFolder) return undefined;
  let parsed: unknown;
  try {
    const markerPath = path.join(descriptor.backingFolder, SESSION_TERMINATION_MARKER);
    const linkInfo = await lstat(markerPath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size > MAX_SESSION_TERMINATION_BYTES) {
      return undefined;
    }
    const handle = await open(markerPath, 'r');
    try {
      const bytes = Buffer.allocUnsafe(MAX_SESSION_TERMINATION_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_SESSION_TERMINATION_BYTES) return undefined;
      parsed = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isTermination(parsed)
    || parsed.sessionId !== descriptor.sessionId
    || parsed.projectId !== descriptor.projectId
    || parsed.sessionEpoch !== descriptor.sessionEpoch) return undefined;
  const expected = Buffer.from(sign(parsed, token), 'hex');
  const actual = Buffer.from(parsed.proof, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return parsed;
}

function sign(marker: Omit<SessionTermination, 'proof'> | SessionTermination, token: string): string {
  const canonical = [
    marker.sessionId,
    marker.projectId,
    marker.sessionEpoch,
    marker.endedAt,
    marker.endedByPeerId,
    marker.endedByDisplayName,
  ].join('\u0000');
  return createHmac('sha256', token).update(canonical).digest('hex');
}

function isTermination(value: unknown): value is SessionTermination {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<SessionTermination>;
  return typeof marker.sessionId === 'string' && PEER_ID_PATTERN.test(marker.sessionId)
    && typeof marker.projectId === 'string' && PEER_ID_PATTERN.test(marker.projectId)
    && Number.isSafeInteger(marker.sessionEpoch) && (marker.sessionEpoch ?? 0) > 0
    && Number.isSafeInteger(marker.endedAt) && (marker.endedAt ?? -1) >= 0
    && typeof marker.endedByPeerId === 'string' && PEER_ID_PATTERN.test(marker.endedByPeerId)
    && typeof marker.endedByDisplayName === 'string' && !validateDisplayName(marker.endedByDisplayName)
    && /^[0-9a-f]{64}$/i.test(marker.proof ?? '');
}
