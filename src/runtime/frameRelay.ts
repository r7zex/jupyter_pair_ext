export type FrameRelayHandler = (fromPeerId: string, bytes: Buffer) => void;
export type FrameRelayAnnounceHandler = (peerId: string) => void;

export interface FrameRelayOptions {
  token: string;
  sessionId: string;
  localPeerId: string;
}

/** Minimal transport contract used by the authenticated emergency route. */
export interface FrameRelay {
  readonly connectedRelayCount: number;
  onFrame: FrameRelayHandler;
  onPeerAnnounce: FrameRelayAnnounceHandler;
  start(): void;
  stop(): void;
  /** Resolves only after this relay has at least one usable external path. */
  waitUntilReady?(timeoutMs?: number): Promise<void>;
  sendAnnounce(): void;
  send(bytes: Buffer, toPeerId?: string): void;
}
