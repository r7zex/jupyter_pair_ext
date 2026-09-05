import { EventEmitter } from 'node:events';
import { HostClock, PeerRuntime, SessionMode, compareClock, normalizeHostClock } from './types';

export interface CoordinatorOptions {

  selfId: string;
  mode: SessionMode;
  clock: HostClock;
  /** Kept for descriptor compatibility; route recovery owns host-loss timing. */
  heartbeatTimeoutMs?: number;
}

export class SessionCoordinator extends EventEmitter {
  public readonly peers = new Map<string, PeerRuntime>();
  public clock: HostClock;
  public closed = false;
  public constructor(private readonly options: CoordinatorOptions) {
    super();
    this.clock = { ...options.clock };
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
  }

  public markDisconnected(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.online = false;
      peer.connectionState = 'disconnected';
    }
  }

  public evaluate(now = Date.now()): HostClock | undefined {
    // Keep the clock argument for deterministic callers; host-loss timing is
    // intentionally owned by MeshTransport rather than this coordinator.
    void now;
    if (this.closed || this.clock.hostId === this.options.selfId) {
      return undefined;
    }
    const host = this.peers.get(this.clock.hostId);
    // MeshTransport owns logical recovery for both a missing heartbeat and a
    // physical route loss. Closing here from a short heartbeat lease races its
    // 30-second recovery window and ejects guests whenever the host is briefly
    // busy (for example, during snapshot materialization on a laptop).
    // `markDisconnected` is reached only from MeshTransport's terminal
    // peerDisconnected event after that bounded recovery is exhausted.
    if (host?.connectionState === 'recovering') {
      return undefined;
    }
    const hardLoss = !host || host.connectionState === 'disconnected' || host.online === false;
    if (!hardLoss) return undefined;

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
