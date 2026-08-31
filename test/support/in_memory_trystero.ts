import {
  type DataPayload,
  type HandshakePayload,
  type JoinError,
  type JoinRoomCallbacks,
  type JsonValue,
  type MessageAction,
  type NostrRoomConfig,
  type Room,
} from 'trystero';
import { TrysteroRoomFactory } from '../../src/runtime/mesh';

interface TestClient {
  id: string;
  key: string;
  callbacks?: JoinRoomCallbacks | undefined;
  room: Room;
  actions: Map<string, MessageAction<DataPayload>>;
  peers: Set<TestClient>;
  /** Per-peer handles surfaced through getPeers(); close() removes the edge. */
  peerHandles: Map<string, { id: string; close: () => void }>;
  left: boolean;
}

interface Mailbox {
  push(payload: HandshakePayload): void;
  take(): Promise<HandshakePayload>;
}

const clientsByKey = new Map<string, Set<TestClient>>();
let nextPeerId = 1;
let partitioned = false;
let sendObserver: ((namespace: string, payload: DataPayload) => void) | undefined;

export function createInMemoryTrysteroFactory(): TrysteroRoomFactory {
  return (config: NostrRoomConfig, roomId: string, callbacks?: JoinRoomCallbacks): Room => {
    const key = JSON.stringify([config.appId, roomId, config.password ?? '']);
    const client = createClient(key, callbacks);
    const clients = clientsByKey.get(key) ?? new Set<TestClient>();
    clientsByKey.set(key, clients);
    const existing = [...clients];
    clients.add(client);
    queueMicrotask(() => {
      for (const peer of existing) void connect(client, peer);
    });
    return client.room;
  };
}

export function resetInMemoryTrystero(): void {
  for (const clients of clientsByKey.values()) {
    for (const client of clients) client.left = true;
  }
  clientsByKey.clear();
  nextPeerId = 1;
  partitioned = false;
  sendObserver = undefined;
}

export function setInMemoryTrysteroSendObserver(
  observer: ((namespace: string, payload: DataPayload) => void) | undefined,
): void {
  sendObserver = observer;
}

export function partitionInMemoryTrystero(): void {
  partitioned = true;
  for (const clients of clientsByKey.values()) {
    for (const client of clients) {
      for (const peer of [...client.peers]) {
        client.peers.delete(peer);
        peer.peers.delete(client);
        client.room.onPeerLeave?.(peer.id);
        peer.room.onPeerLeave?.(client.id);
      }
    }
  }
}

/**
 * Simulates a peer whose leave event was lost (as happens over the lossy
 * Nostr relay): the client vanishes from the room without any onPeerLeave
 * callback on the surviving peers, leaving zombie identity routes behind.
 */
export function abandonInMemoryTrystero(transportPeerId: string): void {
  for (const clients of clientsByKey.values()) {
    for (const client of [...clients]) {
      if (client.id !== transportPeerId) continue;
      client.left = true;
      clients.delete(client);
      for (const peer of [...client.peers]) {
        client.peers.delete(peer);
        peer.peers.delete(client);
        client.peerHandles.delete(peer.id);
        peer.peerHandles.delete(client.id);
        // Deliberately no peer.room.onPeerLeave: that is the lost event.
      }
    }
  }
}

export function healInMemoryTrystero(): void {
  partitioned = false;
  for (const clients of clientsByKey.values()) {
    const active = [...clients].filter((client) => !client.left);
    for (let left = 0; left < active.length; left += 1) {
      for (let right = left + 1; right < active.length; right += 1) {
        const leftClient = active[left];
        const rightClient = active[right];
        if (!leftClient || !rightClient) continue;
        void connect(leftClient, rightClient);
      }
    }
  }
}

function createClient(key: string, callbacks?: JoinRoomCallbacks): TestClient {
  const actions = new Map<string, MessageAction<DataPayload>>();
  const client = {
    id: `test-peer-${nextPeerId++}`,
    key,
    callbacks,
    actions,
    peers: new Set<TestClient>(),
    peerHandles: new Map<string, { id: string; close: () => void }>(),
    left: false,
    room: undefined as unknown as Room,
  } satisfies TestClient;
  client.room = {
    makeAction: (<T extends DataPayload>(namespace: string): MessageAction<T> => {
      const action: MessageAction<T> = {
        send: async (data, options) => {
          const target = options?.target;
          const targets = target === null || target === undefined
            ? [...client.peers]
            : [...client.peers].filter((peer) => Array.isArray(target)
              ? target.includes(peer.id)
              : peer.id === target);
          await Promise.all(targets.map(async (peer) => {
            const receiver = peer.actions.get(namespace)?.onMessage;
            if (!receiver) return;
            await receiver(clonePayload(data) as T, {
              peerId: client.id,
              ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
            });
          }));
          sendObserver?.(namespace, clonePayload(data));
        },
        onMessage: null,
        onReceiveProgress: null,
      };
      actions.set(namespace, action as MessageAction<DataPayload>);
      return action;
    }) as Room['makeAction'],
    ping: async (peerId: string) => {
      if (![...client.peers].some((peer) => peer.id === peerId)) throw new Error('peer disconnected');
      return 1;
    },
    leave: async () => leave(client),
    isPassive: () => false,
    getPeers: () => Object.fromEntries(
      [...client.peerHandles].map(([peerId, handle]) => [peerId, handle]),
    ) as ReturnType<Room['getPeers']>,
    addStream: () => [],
    removeStream: () => undefined,
    addTrack: () => [],
    removeTrack: () => undefined,
    replaceTrack: () => [],
    onPeerJoin: null,
    onPeerLeave: null,
    onPeerStream: null,
    onPeerTrack: null,
  };
  return client;
}

async function connect(left: TestClient, right: TestClient): Promise<void> {
  if (partitioned || left.left || right.left || left.peers.has(right)) return;
  const leftToRight = mailbox();
  const rightToLeft = mailbox();
  const initiatorIsLeft = left.id.localeCompare(right.id) < 0;
  try {
    await Promise.all([
      left.callbacks?.onPeerHandshake?.(
        right.id,
        async (data, metadata) => leftToRight.push(metadata === undefined ? { data } : { data, metadata }),
        () => rightToLeft.take(),
        initiatorIsLeft,
      ),
      right.callbacks?.onPeerHandshake?.(
        left.id,
        async (data, metadata) => rightToLeft.push(metadata === undefined ? { data } : { data, metadata }),
        () => leftToRight.take(),
        !initiatorIsLeft,
      ),
    ]);
    if (left.left || right.left) return;
    left.peers.add(right);
    right.peers.add(left);
    // Room-level handles: close() removes the edge on both sides and fires
    // the corresponding leave callbacks, mirroring real Trystero semantics.
    const leftHandle = {
      id: right.id,
      close: (): void => {
        left.peers.delete(right);
        right.peers.delete(left);
        left.peerHandles.delete(right.id);
        right.peerHandles.delete(left.id);
        left.room.onPeerLeave?.(right.id);
        right.room.onPeerLeave?.(left.id);
      },
    };
    const rightHandle = { id: left.id, close: leftHandle.close };
    left.peerHandles.set(right.id, leftHandle);
    right.peerHandles.set(left.id, rightHandle);
    left.room.onPeerJoin?.(right.id);
    right.room.onPeerJoin?.(left.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    left.callbacks?.onJoinError?.(joinError(left, right, message));
    right.callbacks?.onJoinError?.(joinError(right, left, message));
  }
}

function leave(client: TestClient): void {
  if (client.left) return;
  client.left = true;
  clientsByKey.get(client.key)?.delete(client);
  for (const peer of [...client.peers]) {
    client.peers.delete(peer);
    peer.peers.delete(client);
    client.peerHandles.delete(peer.id);
    peer.peerHandles.delete(client.id);
    peer.room.onPeerLeave?.(client.id);
  }
}

function mailbox(): Mailbox {
  const pending: HandshakePayload[] = [];
  const waiters: Array<(payload: HandshakePayload) => void> = [];
  return {
    push(payload) {
      const waiter = waiters.shift();
      if (waiter) waiter(payload);
      else pending.push(payload);
    },
    take() {
      const payload = pending.shift();
      if (payload) return Promise.resolve(payload);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function joinError(self: TestClient, peer: TestClient, error: string): JoinError {
  return {
    error,
    appId: 'test',
    roomId: self.key,
    peerId: peer.id,
  };
}

function clonePayload<T extends DataPayload>(value: T): T {
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as T;
  }
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as JsonValue as T;
}
