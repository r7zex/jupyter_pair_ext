import { randomUUID } from 'node:crypto';
import { AGENT_ONLINE_MS, GPU_UUID, VPS_ID, visibleVpsText } from './protocol';
import type { PersistentConsent, PersistentDevice, PersistentMember, PersistentTarget } from './persistentProtocol';

export interface PersistentDeviceInput {
  id: string; name: string; python: string; cpu: string;
  gpus: { uuid: string; name: string; memoryMb: number }[];
  isolation: string;
  ready?: boolean; cudaAvailable?: boolean; cpuCount?: number; diagnostics?: string[];
  /** Sharing and ownership are established separately by authenticated server operations. */
  enabled?: boolean; ownerId?: string; online?: boolean;
}

export interface PersistentBoundConsent extends PersistentConsent {
  sessionId: string;
  ownerId: string;
  selectionVersion: number;
  requestSequence: number;
}

export interface PersistentComputeState {
  version: 1;
  sessionId: string;
  ownerId: string;
  allowMemberSwitch: boolean;
  ownerBaseline: PersistentTarget;
  generation: number;
  selectionVersion: number;
  requestSequence: number;
  devices: PersistentDevice[];
  consents: PersistentBoundConsent[];
}

export interface PersistentComputeView {
  allowMemberSwitch: boolean;
  ownerBaseline: PersistentTarget;
  devices: PersistentDevice[];
  target: PersistentTarget;
  generation: number;
  consents: PersistentBoundConsent[];
}

export interface PersistentSelection {
  target: PersistentTarget;
  generation: number;
  consent?: PersistentBoundConsent;
}

const VPS_TARGET: PersistentTarget = { deviceId: 'vps' };
const MAX_CONSENTS = 512;
const MAX_DEVICES = 64;
const copyTarget = (target: PersistentTarget): PersistentTarget => ({ deviceId: target.deviceId,
  ...(target.gpuUuid === undefined ? {} : { gpuUuid: target.gpuUuid }) });
const sameTarget = (left: PersistentTarget, right: PersistentTarget): boolean =>
  left.deviceId === right.deviceId && left.gpuUuid === right.gpuUuid;

export class PersistentComputeError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}

/** Server-only authorization policy. It never owns or interrupts an accepted execution. */
export class PersistentComputePolicy {
  private readonly members = new Map<string, PersistentMember>();
  private readonly devices = new Map<string, PersistentDevice>();
  private readonly agentSeen = new Map<string, number>();
  private readonly consents: PersistentBoundConsent[] = [];
  private allowMemberSwitch = false;
  private ownerBaseline: PersistentTarget = { ...VPS_TARGET };
  private target: PersistentTarget = { ...VPS_TARGET };
  private selectedBy: string;
  private selectionMode: 'owner' | 'member' | 'fallback' = 'fallback';
  private generation = 1;
  private selectionVersion = 0;
  private requestSequence = 0;
  private latestPendingId: string | undefined;

  constructor(readonly sessionId: string, readonly ownerId: string, state?: PersistentComputeState,
    private readonly now: () => number = Date.now) {
    if (typeof sessionId !== 'string' || typeof ownerId !== 'string' || !VPS_ID.test(sessionId) || !VPS_ID.test(ownerId)) {
      throw new PersistentComputeError('Invalid compute session identity.', 400);
    }
    this.selectedBy = ownerId;
    this.devices.set('vps', { id: 'vps', ownerId, name: 'VPS CPU', python: 'python3', cpu: 'VPS CPU',
      gpus: [], enabled: true, online: false, isolation: 'server agent' });
    if (!state) return;
    if (state.version !== 1 || state.sessionId !== sessionId || state.ownerId !== ownerId) {
      throw new Error('Compute policy belongs to another session.');
    }
    this.validateState(state);
    this.allowMemberSwitch = state.allowMemberSwitch;
    this.ownerBaseline = copyTarget(state.ownerBaseline);
    // Online presence and pending selection intent never survive a server restart.
    this.generation = state.generation + 1;
    this.selectionVersion = state.selectionVersion + 1;
    this.requestSequence = state.requestSequence;
    for (const device of state.devices) {
      this.validateInventory(device);
      if (device.id === 'vps') {
        this.devices.set('vps', this.copyDevice({ ...device, online: false }));
        continue;
      }
      if (!VPS_ID.test(device.ownerId)) throw new Error('Invalid device owner.');
      this.devices.set(device.id, this.copyDevice({ ...device, online: false }));
    }
    for (const consent of state.consents) {
      if (consent.sessionId !== sessionId || !VPS_ID.test(consent.ownerId) || !VPS_ID.test(consent.requesterId)) {
        throw new Error('Invalid saved compute consent.');
      }
      this.consents.push({ ...consent });
    }
  }

  serialize(): PersistentComputeState {
    this.reconcile();
    return { version: 1, sessionId: this.sessionId, ownerId: this.ownerId,
      allowMemberSwitch: this.allowMemberSwitch, ownerBaseline: copyTarget(this.ownerBaseline),
      generation: this.generation, selectionVersion: this.selectionVersion, requestSequence: this.requestSequence,
      devices: [...this.devices.values()].map((device) => ({ ...this.copyDevice(device), online: false })),
      consents: this.consents.map((consent) => ({ ...consent })) };
  }

  setMembers(members: PersistentMember[]): void {
    const ownerWasOnline = this.members.get(this.ownerId)?.online === true;
    const before = [...this.members.values()].map((member) => `${member.id}:${member.online}`).sort().join(',');
    this.members.clear();
    for (const member of members) {
      if (typeof member.id !== 'string' || !VPS_ID.test(member.id) || member.id === 'vps') {
        throw new PersistentComputeError('Invalid human member identity.', 400);
      }
      this.members.set(member.id, { ...member });
    }
    const after = [...this.members.values()].map((member) => `${member.id}:${member.online}`).sort().join(',');
    if (before !== after) this.invalidatePending();
    if (!ownerWasOnline && this.members.get(this.ownerId)?.online && this.selectionMode === 'member') {
      this.setTarget(this.ownerId, this.ownerBaseline, 'owner');
    }
    this.reconcile();
  }

  view(): PersistentComputeView {
    this.reconcile();
    return { allowMemberSwitch: this.allowMemberSwitch, ownerBaseline: copyTarget(this.ownerBaseline),
      devices: [...this.devices.values()].map((device) => ({ ...this.copyDevice(device), online: this.deviceOnline(device) })),
      target: copyTarget(this.target), generation: this.generation, consents: this.consents.map((consent) => ({ ...consent })) };
  }

  setAllowMemberSwitch(memberId: string, enabled: boolean): void {
    this.requireOwner(memberId);
    if (typeof enabled !== 'boolean') throw new PersistentComputeError('Invalid compute switching setting.', 400);
    if (this.allowMemberSwitch !== enabled) this.invalidatePending();
    this.allowMemberSwitch = enabled;
    this.reconcile();
  }

  registerDevice(memberId: string, input: PersistentDeviceInput): PersistentDevice {
    this.requireMember(memberId);
    this.validateInventory(input);
    if (input.id === 'vps') throw new PersistentComputeError('VPS device registration requires the configured agent credential.');
    const existing = this.devices.get(input.id);
    if (existing && existing.ownerId !== memberId) throw new PersistentComputeError('This device belongs to another member.');
    if (!existing && this.devices.size >= MAX_DEVICES) throw new PersistentComputeError('Compute device limit reached.', 409);
    const device: PersistentDevice = { id: input.id, ownerId: memberId, name: input.name, python: input.python,
      cpu: input.cpu, gpus: input.gpus.map((gpu) => ({ ...gpu })), isolation: input.isolation,
      enabled: existing?.enabled ?? false, online: false, ...this.diagnostics(input) };
    this.devices.set(device.id, device);
    if (existing) {
      for (const consent of this.consents) {
        if (consent.deviceId === device.id && consent.gpuUuid !== undefined && !device.gpus.some((gpu) => gpu.uuid === consent.gpuUuid)) {
          consent.status = 'revoked';
        }
      }
      if (this.ownerBaseline.deviceId === device.id && this.ownerBaseline.gpuUuid !== undefined
        && !device.gpus.some((gpu) => gpu.uuid === this.ownerBaseline.gpuUuid)) this.ownerBaseline = { ...VPS_TARGET };
    }
    // Registration itself is an authenticated agent announcement, never client-supplied online status.
    this.heartbeatDevice(device.id);
    return { ...this.copyDevice(device), online: this.deviceOnline(device) };
  }

  registerVps(input: PersistentDeviceInput): PersistentDevice {
    this.validateInventory(input);
    if (input.id !== 'vps') throw new PersistentComputeError('Expected VPS device.', 400);
    const device: PersistentDevice = { id: 'vps', ownerId: this.ownerId, name: input.name, python: input.python,
      cpu: input.cpu, gpus: [], isolation: input.isolation, enabled: input.ready !== false, online: false, ...this.diagnostics(input) };
    this.devices.set('vps', device);
    this.heartbeatDevice('vps');
    return { ...this.copyDevice(device), online: this.deviceOnline(device) };
  }

  /** The host must authenticate the device owner or VPS agent before calling this method. */
  heartbeatDevice(deviceId: string): void {
    if (!this.devices.has(deviceId)) throw new PersistentComputeError('Unknown compute device.', 404);
    this.agentSeen.set(deviceId, this.now());
    this.reconcile();
  }

  share(memberId: string, deviceId: string, enabled: boolean): void {
    this.requireMember(memberId);
    const device = this.devices.get(deviceId);
    if (!device || device.id === 'vps' || device.ownerId !== memberId) throw new PersistentComputeError('Only the device owner can change sharing.');
    if (typeof enabled !== 'boolean') throw new PersistentComputeError('Invalid device sharing setting.', 400);
    const newlyEnabled = enabled && !device.enabled;
    if (device.enabled !== enabled) this.invalidatePending();
    device.enabled = enabled;
    if (newlyEnabled && memberId === this.ownerId && this.ownerBaseline.deviceId === 'vps') {
      this.ownerBaseline = { deviceId };
      this.setTarget(memberId, this.ownerBaseline, 'owner');
    }
    this.reconcile();
  }

  /** Reclaim revoked memberships without disturbing devices retained for accepted executions. */
  pruneRetiredDevices(protectedDeviceIds: readonly string[], retireOffline = false): void {
    const protectedIds = new Set(protectedDeviceIds);
    const removed = new Set<string>();
    for (const device of this.devices.values()) {
      const owner = this.members.get(device.ownerId);
      if (device.id !== 'vps' && (!owner || retireOffline && !owner.online && !this.deviceOnline(device)) && !protectedIds.has(device.id)) {
        this.devices.delete(device.id);
        this.agentSeen.delete(device.id);
        removed.add(device.id);
      }
    }
    let changed = removed.size > 0;
    for (let index = this.consents.length - 1; index >= 0; index--) {
      const consent = this.consents[index]!;
      if (removed.has(consent.deviceId) || !this.members.has(consent.requesterId) || !this.members.has(consent.ownerId)) {
        this.consents.splice(index, 1);
        changed = true;
      }
    }
    if (removed.has(this.ownerBaseline.deviceId)) this.ownerBaseline = { ...VPS_TARGET };
    if (changed) this.invalidatePending();
    this.reconcile();
  }

  select(memberId: string, target: PersistentTarget): PersistentSelection {
    this.reconcile();
    const device = this.validateTarget(target);
    // Requesting access to the current target never transfers selection authority.
    const executionOnly = memberId !== this.ownerId && sameTarget(target, this.target);
    if (executionOnly) {
      if (!this.requireMember(memberId).online) throw new PersistentComputeError('The requesting member must be online.');
    } else this.requireSwitchPermission(memberId, device);
    this.requireAvailable(device);
    if (!executionOnly) { this.selectionVersion++; this.latestPendingId = undefined; }
    if (device.id !== 'vps' && device.ownerId !== memberId && !this.hasConsent(memberId, target)) {
      this.pruneObsoleteConsents();
      if (this.consents.length >= MAX_CONSENTS) throw new PersistentComputeError('Compute consent limit reached.', 409);
      const consent: PersistentBoundConsent = { id: randomUUID(), sessionId: this.sessionId,
        requesterId: memberId, ownerId: device.ownerId, deviceId: device.id,
        ...(target.gpuUuid === undefined ? {} : { gpuUuid: target.gpuUuid }), status: 'pending',
        selectionVersion: this.selectionVersion, requestSequence: ++this.requestSequence };
      this.consents.push(consent);
      if (!executionOnly) this.latestPendingId = consent.id;
      return { target: copyTarget(this.target), generation: this.generation, consent: { ...consent } };
    }
    if (!executionOnly) this.applySelection(memberId, target);
    return { target: copyTarget(this.target), generation: this.generation };
  }

  decideConsent(memberId: string, consentId: string, approved: boolean): PersistentBoundConsent {
    this.requireMember(memberId);
    if (typeof approved !== 'boolean') throw new PersistentComputeError('Invalid compute consent decision.', 400);
    const consent = this.consents.find((candidate) => candidate.id === consentId);
    if (!consent || consent.ownerId !== memberId || this.devices.get(consent.deviceId)?.ownerId !== memberId) {
      throw new PersistentComputeError('Only the device owner can decide this consent.');
    }
    if (consent.status !== 'pending') throw new PersistentComputeError('Compute consent is no longer pending.', 409);
    if (!this.members.get(memberId)?.online) throw new PersistentComputeError('The device owner must be online to decide consent.');
    consent.status = approved ? 'approved' : 'denied';
    if (approved && this.latestPendingId === consent.id && this.selectionVersion === consent.selectionVersion) {
      const target = copyTarget(consent);
      try {
        const device = this.validateTarget(target);
        this.requireSwitchPermission(consent.requesterId, device);
        this.requireAvailable(device);
        if (this.hasConsent(consent.requesterId, target)) this.applySelection(consent.requesterId, target);
      } catch {
        // Approval grants consent, but a departed requester or expired selection intent cannot switch compute.
      }
    }
    if (this.latestPendingId === consent.id) this.latestPendingId = undefined;
    return { ...consent };
  }

  revokeConsent(memberId: string, consentId: string): void {
    this.requireMember(memberId);
    const consent = this.consents.find((candidate) => candidate.id === consentId);
    if (!consent || consent.ownerId !== memberId) throw new PersistentComputeError('Only the device owner can revoke this consent.');
    consent.status = 'revoked';
    this.invalidatePending();
    this.reconcile();
  }

  executionTarget(requesterId: string): PersistentSelection {
    this.reconcile();
    this.assertExecutionTarget(requesterId, this.target);
    return { target: copyTarget(this.target), generation: this.generation };
  }

  /** Call at admission and again at claim. Running work is deliberately outside this policy. */
  assertExecutionTarget(requesterId: string, target: PersistentTarget, generation?: number): void {
    this.reconcile();
    const device = this.validateTarget(target);
    if (generation !== undefined && (generation !== this.generation || !sameTarget(target, this.target))) {
      throw new PersistentComputeError('Queued execution uses an expired compute selection or kernel generation.', 409);
    }
    this.requireMember(requesterId);
    this.requireAvailable(device);
    if (device.id !== 'vps' && device.ownerId !== requesterId && !this.hasConsent(requesterId, target)) {
      throw new PersistentComputeError('Valid device-owner consent is required before execution.');
    }
  }

  invalidateKernels(): void {
    this.generation++;
    this.invalidatePending();
  }

  private reconcile(): void {
    const online = this.onlineHumans();
    if (online.length === 0) {
      this.setTarget(this.ownerId, VPS_TARGET, 'fallback');
      return;
    }
    try {
      if (this.selectionMode === 'fallback') throw new Error('Restore the owner baseline when it becomes available.');
      const device = this.validateTarget(this.target);
      this.requireAvailable(device);
      // The owner may be offline while their baseline remains valid for other online members.
      if (this.selectedBy !== this.ownerId) this.requireSwitchPermission(this.selectedBy, device);
      if (device.id !== 'vps' && device.ownerId !== this.selectedBy && !this.hasConsent(this.selectedBy, this.target)) {
        throw new Error('Selected compute consent is unavailable.');
      }
      return;
    } catch {
      // Future admissions fall back; generations already attached to accepted work stay untouched.
    }
    try {
      const baseline = this.validateTarget(this.ownerBaseline);
      this.requireAvailable(baseline);
      if (baseline.id !== 'vps' && baseline.ownerId !== this.ownerId && !this.hasConsent(this.ownerId, this.ownerBaseline)) {
        throw new Error('Owner baseline consent is unavailable.');
      }
      this.setTarget(this.ownerId, this.ownerBaseline, 'owner');
    } catch {
      this.setTarget(this.ownerId, VPS_TARGET, 'fallback');
    }
  }

  private applySelection(memberId: string, target: PersistentTarget): void {
    if (memberId === this.ownerId) this.ownerBaseline = copyTarget(target);
    this.setTarget(memberId, target, memberId === this.ownerId ? 'owner' : 'member');
  }

  private setTarget(memberId: string, target: PersistentTarget, mode: 'owner' | 'member' | 'fallback'): void {
    if (!sameTarget(this.target, target)) this.generation++;
    this.target = copyTarget(target);
    this.selectedBy = memberId;
    this.selectionMode = mode;
  }

  private invalidatePending(): void {
    this.selectionVersion++;
    this.latestPendingId = undefined;
  }

  private onlineHumans(): PersistentMember[] {
    return [...this.members.values()].filter((member) => member.online);
  }

  private requireMember(memberId: string): PersistentMember {
    const member = this.members.get(memberId);
    if (!member) throw new PersistentComputeError('Unknown session member.');
    return member;
  }

  private requireOwner(memberId: string): void {
    this.requireMember(memberId);
    if (memberId !== this.ownerId) throw new PersistentComputeError('Only the session owner controls compute settings.');
  }

  private requireSwitchPermission(memberId: string, device: PersistentDevice): void {
    const member = this.requireMember(memberId);
    if (!member.online) throw new PersistentComputeError('The requesting member must be online.');
    if (memberId === this.ownerId) return;
    if (!this.members.get(this.ownerId)?.online) {
      if (device.id === 'vps' || (device.ownerId === memberId && device.enabled)) return;
      throw new PersistentComputeError('Without the session owner, select the VPS or your own shared computer.');
    }
    if (this.allowMemberSwitch) return;
    throw new PersistentComputeError('The session owner has disabled member compute switching.');
  }

  private deviceOnline(device: PersistentDevice): boolean {
    const seen = this.agentSeen.get(device.id);
    return device.ready !== false && seen !== undefined && this.now() - seen <= AGENT_ONLINE_MS
      && (device.id === 'vps' || this.members.get(device.ownerId)?.online === true);
  }

  private requireAvailable(device: PersistentDevice): void {
    if (device.ready === false) throw new PersistentComputeError('The compute agent is not ready; inspect its diagnostics.', 409);
    if (!device.enabled) throw new PersistentComputeError('The device owner has not enabled resource sharing.');
    if (!this.deviceOnline(device)) throw new PersistentComputeError('The compute device or its owner is offline.', 409);
  }

  private validateTarget(raw: PersistentTarget): PersistentDevice {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.deviceId !== 'string' || !VPS_ID.test(raw.deviceId)
      || (raw.gpuUuid !== undefined && (typeof raw.gpuUuid !== 'string' || !GPU_UUID.test(raw.gpuUuid)))) {
      throw new PersistentComputeError('Invalid compute target.', 400);
    }
    const device = this.devices.get(raw.deviceId);
    if (!device || (raw.gpuUuid !== undefined && !device.gpus.some((gpu) => gpu.uuid === raw.gpuUuid))) {
      throw new PersistentComputeError('Unknown compute device or GPU.', 404);
    }
    if (raw.gpuUuid !== undefined && device.cudaAvailable === false) {
      throw new PersistentComputeError('CUDA PyTorch is unavailable on this compute agent; inspect its diagnostics.', 409);
    }
    return device;
  }

  private hasConsent(requesterId: string, target: PersistentTarget): boolean {
    const device = this.devices.get(target.deviceId);
    const latest = [...this.consents].reverse().find((consent) => consent.sessionId === this.sessionId
      && consent.requesterId === requesterId && consent.ownerId === device?.ownerId
      && sameTarget(consent, target));
    return latest?.status === 'approved';
  }

  private pruneObsoleteConsents(): void {
    if (this.consents.length < MAX_CONSENTS) return;
    const latest = new Map<string, PersistentBoundConsent>();
    const identity = (consent: PersistentBoundConsent): string => JSON.stringify([
      consent.requesterId, consent.ownerId, consent.deviceId, consent.gpuUuid ?? null,
    ]);
    for (const consent of this.consents) latest.set(identity(consent), consent);
    for (let index = this.consents.length - 1; index >= 0; index--) {
      const consent = this.consents[index]!;
      if (latest.get(identity(consent)) !== consent || consent.status === 'denied' || consent.status === 'revoked'
        || (consent.status === 'pending' && consent.id !== this.latestPendingId)) this.consents.splice(index, 1);
    }
  }

  private validateInventory(input: PersistentDeviceInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !VPS_ID.test(input.id) || !visibleVpsText(input.name, 200)
      || !visibleVpsText(input.python, 1024) || !visibleVpsText(input.cpu, 200) || !visibleVpsText(input.isolation, 1000)
      || !Array.isArray(input.gpus) || input.gpus.length > 64 || input.gpus.some((gpu) => !gpu || typeof gpu.uuid !== 'string' || !GPU_UUID.test(gpu.uuid)
        || !visibleVpsText(gpu.name, 200) || !Number.isSafeInteger(gpu.memoryMb) || gpu.memoryMb < 0)
      || new Set(input.gpus.map((gpu) => gpu.uuid)).size !== input.gpus.length
      || (input.ready !== undefined && typeof input.ready !== 'boolean')
      || (input.cudaAvailable !== undefined && typeof input.cudaAvailable !== 'boolean')
      || (input.cpuCount !== undefined && (!Number.isSafeInteger(input.cpuCount) || input.cpuCount < 0))
      || (input.diagnostics !== undefined && (!Array.isArray(input.diagnostics) || input.diagnostics.length > 32
        || input.diagnostics.some((diagnostic) => !visibleVpsText(diagnostic, 1000))))) {
      throw new PersistentComputeError('Invalid compute device inventory.', 400);
    }
  }

  private validateState(state: PersistentComputeState): void {
    const counter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
    if (typeof state.allowMemberSwitch !== 'boolean' || !counter(state.generation) || state.generation < 1
      || !counter(state.selectionVersion) || !counter(state.requestSequence)
      || !Array.isArray(state.devices) || state.devices.length < 1 || state.devices.length > MAX_DEVICES
      || !Array.isArray(state.consents) || state.consents.length > MAX_CONSENTS) throw new Error('Invalid saved compute policy.');
    const ids = new Set<string>();
    for (const device of state.devices) {
      this.validateInventory(device);
      if (typeof device.ownerId !== 'string' || !VPS_ID.test(device.ownerId) || typeof device.enabled !== 'boolean'
        || typeof device.online !== 'boolean' || ids.has(device.id)
        || (device.id === 'vps' && (device.ownerId !== this.ownerId || device.gpus.length !== 0))) {
        throw new Error('Invalid saved compute device ownership or sharing.');
      }
      ids.add(device.id);
    }
    if (!ids.has('vps')) throw new Error('Saved compute policy has no VPS device.');
    const baseline = state.ownerBaseline;
    if (!baseline || typeof baseline !== 'object' || typeof baseline.deviceId !== 'string' || !ids.has(baseline.deviceId)
      || (baseline.gpuUuid !== undefined && (typeof baseline.gpuUuid !== 'string' || !GPU_UUID.test(baseline.gpuUuid)
        || baseline.deviceId === 'vps'
        || !state.devices.find((device) => device.id === baseline.deviceId)!.gpus.some((gpu) => gpu.uuid === baseline.gpuUuid)))) {
      throw new Error('Invalid saved owner compute baseline.');
    }
    const consentIds = new Set<string>();
    let previousRequest = 0;
    for (const consent of state.consents) {
      const device = state.devices.find((candidate) => candidate.id === consent?.deviceId);
      if (!consent || typeof consent !== 'object' || typeof consent.id !== 'string' || !VPS_ID.test(consent.id)
        || consentIds.has(consent.id) || consent.sessionId !== this.sessionId || !device || device.id === 'vps'
        || consent.ownerId !== device.ownerId || typeof consent.requesterId !== 'string' || !VPS_ID.test(consent.requesterId)
        || !['pending', 'approved', 'denied', 'revoked'].includes(consent.status)
        || !counter(consent.selectionVersion) || consent.selectionVersion > state.selectionVersion
        || !counter(consent.requestSequence) || consent.requestSequence > state.requestSequence || consent.requestSequence <= previousRequest
        || (consent.gpuUuid !== undefined && (typeof consent.gpuUuid !== 'string' || !GPU_UUID.test(consent.gpuUuid)
          || (consent.status !== 'revoked' && !device.gpus.some((gpu) => gpu.uuid === consent.gpuUuid))))) {
        throw new Error('Invalid saved compute consent.');
      }
      consentIds.add(consent.id);
      previousRequest = consent.requestSequence;
    }
  }

  private diagnostics(input: PersistentDeviceInput): Pick<PersistentDevice, 'ready' | 'cudaAvailable' | 'cpuCount' | 'diagnostics'> {
    return { ...(input.ready === undefined ? {} : { ready: input.ready }),
      ...(input.cudaAvailable === undefined ? {} : { cudaAvailable: input.cudaAvailable }),
      ...(input.cpuCount === undefined ? {} : { cpuCount: input.cpuCount }),
      ...(input.diagnostics === undefined ? {} : { diagnostics: [...input.diagnostics] }) };
  }

  private copyDevice(device: PersistentDevice): PersistentDevice {
    return { ...device, gpus: device.gpus.map((gpu) => ({ ...gpu })),
      ...(device.diagnostics === undefined ? {} : { diagnostics: [...device.diagnostics] }) };
  }
}
