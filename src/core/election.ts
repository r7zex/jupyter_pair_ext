import { EventEmitter } from 'node:events';
import { HostClock, PeerRuntime, SessionMode, compareClock, normalizeHostClock } from './types';

/**
 * How many heartbeat lease periods may elapse between two `evaluate` calls
 * before the gap is attributed to a local stall rather than to a lost Host.
 */
const STALL_FACTOR = 4;
export interface CoordinatorOptions {

  selfId: string;
  mode: SessionMode;
  clock: HostClock;
  heartbeatTimeoutMs?: number;
}

export class SessionCoordinator extends EventEmitter {
  public readonly peers = new Map<string, PeerRuntime>();
  public clock: HostClock;
  public closed = false;
  private readonly heartbeatTimeoutMs: number;
  /** Wall-clock time of the previous `evaluate` call, used to detect a stall. */
  private lastEvaluateAt = 0;
  /** Guest shutdown is deferred until this instant after a detected local stall. */
  private graceUntil = 0;
  /** First instant at which the host lease was observed as expired. */
  private hostSuspectSince: number | undefined;

  public constructor(private readonly options: CoordinatorOptions) {
    super();
    this.clock = { ...options.clock };
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 1600;
  }

  public upsertPeer(peer: PeerRuntime): void {
    this.peers.set(peer.peerId, { ...peer });
  }

  public markHeartbeat(peerId: string, at = Date.now()): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.lastHeartbeat = at;
    peer.online = true;
    peer.missedHeartbeats = 0;
    if (peerId === this.clock.hostId) this.hostSuspectSince = undefined;
  }

  public markDisconnected(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) peer.online = false;
  }

  public evaluate(now = Date.now()): HostClock | undefined {
    if (this.closed || this.clock.hostId === this.options.selfId) {
      this.lastEvaluateAt = now;
      this.hostSuspectSince = undefined;
      return undefined;
    }
    // A blocked event loop (large notebook render, snapshot, GC pause, laptop
    // sleep) delays both this timer and the inbound heartbeat processing.  In
    // that case every lease looks expired although the Host is perfectly
    // alive, so the observed stall grants a fresh grace period instead of
    // closing the guest session.
    const sinceLastEvaluation = this.lastEvaluateAt ? now - this.lastEvaluateAt : 0;
    this.lastEvaluateAt = now;
    // `evaluate` runs on a sub-second timer, so a gap several times longer than
    // the heartbeat lease means *we* were frozen, not that the Host vanished.
    if (sinceLastEvaluation > this.heartbeatTimeoutMs * STALL_FACTOR) {

      this.graceUntil = now + this.heartbeatTimeoutMs;
      this.hostSuspectSince = undefined;
      return undefined;
    }
    if (now < this.graceUntil) return undefined;

    const host = this.peers.get(this.clock.hostId);
    // The mesh has already retired the physical route and is trying the
    // authenticated alternatives.  Do not race its bounded recovery window:
    // a guest can never infer a replacement host from a local partition.
    if (host?.connectionState === 'recovering') {
      this.hostSuspectSince = undefined;
      return undefined;
    }
    // A WebRTC disconnect can be transient. Guest shutdown starts only after
    // the heartbeat lease expires, which gives route recovery a chance.
    const leaseExpired = !host || now - host.lastHeartbeat > this.heartbeatTimeoutMs;
    if (!leaseExpired) {
      this.hostSuspectSince = undefined;
      return undefined;
    }
    // An observed socket close is authoritative; a merely late heartbeat has to
    // stay expired across a confirmation window before the role is taken away.
    const hardLoss = !host || host.connectionState === 'disconnected' || host.online === false;
    if (!hardLoss) {
      this.hostSuspectSince ??= now;
      if (now - this.hostSuspectSince < this.heartbeatTimeoutMs) return undefined;
    }
    this.hostSuspectSince = undefined;

    // Host authority is never inferred from reachability. A partitioned guest
    // cannot distinguish its own isolation from a failed host, so promoting a
    // locally visible candidate would create two hosts. Only manualTransfer()
    // and an authenticated announcement from the currently trusted host may
    // advance the host clock.
    this.closed = true;
    this.emit('closed', 'host-lost');
    return undefined;
  }

  public manualTransfer(targetPeerId: string): HostClock {
    if (!this.isCurrentHost()) throw new Error('Only the current Session Host can transfer the host role.');
    const target = this.peers.get(targetPeerId);
    if (!target?.online) throw new Error('The selected participant is offline.');
    const next = { ...this.clock, hostEpoch: this.clock.hostEpoch + 1, hostId: targetPeerId };
    this.clock = next;
    this.emit('hostChanged', next, 'manual');
    return next;
  }

  public applyAnnouncement(incoming: HostClock, announcedByPeerId: string): boolean {
    const normalized = normalizeHostClock(incoming, this.clock.sessionEpoch);
    if (announcedByPeerId !== this.clock.hostId
      || !normalized
      || normalized.hostEpoch !== this.clock.hostEpoch + 1
      || compareClock(normalized, this.clock) <= 0) return false;
    this.clock = normalized;
    this.emit('hostChanged', this.clock, 'remote');
    return true;
  }

  public isCurrentHost(): boolean {
    return this.clock.hostId === this.options.selfId && !this.closed;
  }
}
