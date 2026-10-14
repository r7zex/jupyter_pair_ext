/** Independent server-hosted sessions. These credentials never authorize the legacy job broker. */
export interface PersistentFileEntry {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  version: number;
  visibility: 'public' | 'private';
}
export interface PersistentSnapshot { revision: number; entries: PersistentFileEntry[] }
export interface PersistentDevice {
  id: string;
  ownerId: string;
  name: string;
  python: string;
  cpu: string;
  gpus: { uuid: string; name: string; memoryMb: number }[];
  enabled: boolean;
  online: boolean;
  isolation: string;
  ready?: boolean;
  cudaAvailable?: boolean;
  cpuCount?: number;
  diagnostics?: string[];
  /** Computed by the Session Host from admitted work; never accepted as agent inventory. */
  usingMemberIds?: string[];
}
export interface PersistentTarget { deviceId: string; gpuUuid?: string }
export interface PersistentMember { id: string; name: string; role: 'owner' | 'admin' | 'member'; online: boolean }
export interface PersistentConsent {
  id: string; requesterId: string; deviceId: string; gpuUuid?: string;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
}
export interface PersistentSessionView {
  id: string; name: string; state: 'running' | 'stopped'; ownerId: string;
  memberId: string; allowMemberSwitch: boolean; members: PersistentMember[];
  devices: PersistentDevice[]; target: PersistentTarget; generation: number;
  consents: PersistentConsent[]; revision: number;
}
export interface PersistentMembership { sessionId: string; memberId: string; token: string; name: string }
export interface PersistentExecution {
  id: string; notebook: string; cellIndex: number; requesterId: string;
  deviceId: string; gpuUuid?: string; generation: number;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  events: Record<string, unknown>[]; error?: string;
  scope?: 'public' | 'private';
  cellId?: string; sourceHash?: string; admittedRevision?: number;
}
export interface PersistentCommand {
  id: string; executionId: string; sessionId: string; kernelId: string;
  generation: number; deviceId: string; gpuUuid?: string;
  files: { path: string; content: string }[];
  command: Record<string, unknown>;
  scope?: 'public' | 'private';
}
/** POST /v1/sessions/rpc, JSON {operation, sessionId?, ...}. Responses are JSON.
 * Operations: create/list (admin bearer), join (password), view/heartbeat/leave,
 * subscribe (authenticated SSE), presence (file/cell relative anchors), notebookSync,
 * snapshot/read/write/mkdir/rename/remove/visibility, lifecycle/password/revoke/role,
 * settings/registerDevice/share/select/consent/revokeConsent, execute/execution/executions,
 * claim/report (device owner bearer; configured VPS agent token for deviceId=vps).
 * Files use base64 content; mutations require expectedRevision, rename also newPath.
 * execute uses notebook, cellIndex, expectedRevision, requestId and optional
 * expectedSourceHash (SHA-256 of the displayed cell) to reject concurrent source changes. report uses commandId,
 * expectedNotebookIdentity + expectedCellId + expectedSourceHash permit admission
 * across unrelated live edits, while expectedGeneration fences compute changes.
 * executionId, events (bridge envelopes), state, optional error/files.
 * notebookSync supports legacy Yjs updates and host-serialized text intents
 * {actor, sequence, cellId, baseline, changes}. Intent sequences are durable per
 * notebook epoch and member. Structural snapshots require snapshotStateVector.
 * compact replies omit the redundant plain-text snapshot; update remains Yjs.
 * Raw notebook replacement resets replica identity. Trusted CRDT/output writes
 * retain it so editing another cell does not discard a running cell's results.
 */
export interface PersistentRpcRequest { operation: string; sessionId?: string; [key: string]: unknown }
