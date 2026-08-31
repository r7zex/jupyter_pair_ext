import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';
import type { SocketClient } from '@trystero-p2p/core';

import {
  getRelayHealth,
  getRelaySockets,
  joinRoom,
  relaySocketRefreshProgress,
  refreshRelaySockets,
  setNostrSocketFactoryForTesting,
} from '../src/runtime/nostrRoom';
import { MeshTransport } from '../src/runtime/mesh';

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Nostr signalling health transition.');
}

describe('Nostr signalling health', function () {
  this.timeout(15_000);

  it('requires EOSE and OK while redacting CLOSED/NOTICE details', async () => {
    let acceptProtocol = false;
    let subscriptionEncodingObserved = false;
    setNostrSocketFactoryForTesting(((url: string, onMessage: (data: string) => void) => {
      const client: SocketClient = {
        url,
        socket: { readyState: 1 } as WebSocket,
        ready: Promise.resolve(undefined as never),
        send: (data) => {
          const message = JSON.parse(data) as unknown[];
          if (message[0] === 'REQ' && typeof message[1] === 'string') {
            const filter = message[2] as { kinds?: unknown; since?: unknown; '#x'?: unknown } | undefined;
            subscriptionEncodingObserved = Array.isArray(filter?.kinds)
              && typeof filter?.since === 'number'
              && Array.isArray(filter?.['#x']);
            queueMicrotask(() => onMessage(JSON.stringify(acceptProtocol
              ? ['EOSE', message[1]]
              : ['CLOSED', message[1], 'private-topic token=subscription-secret'])));
          } else if (message[0] === 'EVENT') {
            const event = message[1] as { id?: unknown } | undefined;
            if (typeof event?.id === 'string') {
              queueMicrotask(() => onMessage(JSON.stringify([
                'OK', event.id, acceptProtocol, 'token=publication-secret',
              ])));
            }
          }
        },
      };
      client.ready = Promise.resolve(client);
      return client;
    }) as never);

    const endpoint = 'wss://user:relay-secret@nostr.example/private-topic?token=query-secret';
    const config = {
      appId: 'nostr-health-app',
      password: 'room-password-secret',
      rtcPolyfill: WeriftPeerConnection,
      relayConfig: { urls: [endpoint], redundancy: 1, warnOnRelayFailure: false },
    };
    let rejectedRoom: ReturnType<typeof joinRoom> | undefined;
    let acceptedRoom: ReturnType<typeof joinRoom> | undefined;
    let rejectedMesh: MeshTransport | undefined;
    let acceptedMesh: MeshTransport | undefined;
    try {
      rejectedRoom = joinRoom(config as never, 'rejected-room');
      await waitUntil(() => {
        const health = getRelayHealth('nostr-health-app', 'rejected-room')[0];
        return health?.subscription === 'failed' && health.publication === 'failed';
      });
      assert.equal(subscriptionEncodingObserved, true);
      const rejected = getRelayHealth('nostr-health-app', 'rejected-room')[0];
      assert.equal(rejected?.endpoint, 'wss://nostr.example');
      assert.equal(rejected?.lastError?.category, 'protocol');
      assert.ok(rejected?.lastError?.phase === 'subscription'
        || rejected?.lastError?.phase === 'publication');
      assert.doesNotMatch(
        JSON.stringify(rejected),
        /relay-secret|private-topic|query-secret|subscription-secret|publication-secret|room-password-secret/,
      );

      acceptProtocol = true;
      acceptedRoom = joinRoom(config as never, 'accepted-room');
      await waitUntil(() => {
        const health = getRelayHealth('nostr-health-app', 'accepted-room')[0];
        return health?.subscription === 'verified' && health.publication === 'verified';
      });

      acceptProtocol = false;
      rejectedMesh = new MeshTransport({
        sessionId: 'nostr-mesh-rejected',
        token: 'nostr-mesh-rejected-token-is-long-enough',
        localPeer: { peerId: 'nostr-rejected-peer', displayName: 'Nostr Rejected', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'nostr-rejected-peer' }),
        isHost: () => true,
        roomFactory: joinRoom as never,
        disableSecondarySignalling: true,
      });
      await rejectedMesh.start();
      await waitUntil(() => rejectedMesh?.signallingDiagnostics()
        .find((family) => family.family === 'nostr')?.endpoints
        .some((item) => item.subscription === 'failed' && item.publication === 'failed') ?? false);
      assert.ok(!rejectedMesh.activeSignallingFamilies().includes('nostr'));

      acceptProtocol = true;
      acceptedMesh = new MeshTransport({
        sessionId: 'nostr-mesh-accepted',
        token: 'nostr-mesh-accepted-token-is-long-enough',
        localPeer: { peerId: 'nostr-accepted-peer', displayName: 'Nostr Accepted', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'nostr-accepted-peer' }),
        isHost: () => true,
        roomFactory: joinRoom as never,
        disableSecondarySignalling: true,
      });
      await acceptedMesh.start();
      await waitUntil(() => acceptedMesh?.activeSignallingFamilies().includes('nostr') ?? false);
    } finally {
      await rejectedMesh?.stop();
      await acceptedMesh?.stop();
      await Promise.all([rejectedRoom?.leave(), acceptedRoom?.leave()]);
      setNostrSocketFactoryForTesting(undefined);
    }
  });

  it('replaces a half-open socket and revalidates the existing room subscription', async () => {
    let socketGenerations = 0;
    let closedSockets = 0;
    let autoAcknowledge = true;
    let deliverRelayMessage: ((message: unknown[]) => void) | undefined;
    const subscriptionIds = new Map<number, string[]>();
    const publicationIds = new Map<number, string[]>();
    setNostrSocketFactoryForTesting(((url: string, onMessage: (data: string) => void, onReconnect?: () => void) => {
      const client = {} as SocketClient;
      deliverRelayMessage = (message) => onMessage(JSON.stringify(message));
      const installSocket = (): void => {
        socketGenerations += 1;
        const socket = {
          readyState: 1,
          close: () => {
            socket.readyState = 3;
            closedSockets += 1;
            installSocket();
            queueMicrotask(() => onReconnect?.());
          },
        };
        client.socket = socket as never;
      };
      client.url = url;
      client.send = (data) => {
        const message = JSON.parse(data) as unknown[];
        if (message[0] === 'REQ' && typeof message[1] === 'string') {
          const ids = subscriptionIds.get(socketGenerations) ?? [];
          ids.push(message[1]);
          subscriptionIds.set(socketGenerations, ids);
          if (autoAcknowledge) queueMicrotask(() => deliverRelayMessage?.(['EOSE', message[1]]));
        } else if (message[0] === 'EVENT') {
          const event = message[1] as { id?: unknown; content?: unknown } | undefined;
          if (typeof event?.id === 'string') {
            assert.equal(typeof event.content, 'string');
            assert.doesNotThrow(() => JSON.parse(event.content as string));
            const ids = publicationIds.get(socketGenerations) ?? [];
            ids.push(event.id);
            publicationIds.set(socketGenerations, ids);
            if (autoAcknowledge) queueMicrotask(() => deliverRelayMessage?.(['OK', event.id, true, '']));
          }
        }
      };
      installSocket();
      client.ready = Promise.resolve(client);
      return client;
    }) as never);

    const appId = 'nostr-refresh-app';
    const roomId = 'nostr-refresh-room';
    let room: ReturnType<typeof joinRoom> | undefined;
    try {
      room = joinRoom({
        appId,
        password: 'nostr-refresh-room-password',
        rtcPolyfill: WeriftPeerConnection,
        relayConfig: {
          urls: ['wss://nostr-refresh.example/private-path?token=secret'],
          redundancy: 1,
          warnOnRelayFailure: false,
        },
      } as never, roomId);
      await waitUntil(() => {
        const health = getRelayHealth(appId, roomId)[0];
        return health?.subscription === 'verified' && health.publication === 'verified';
      });

      const endpoint = 'wss://nostr-refresh.example/private-path?token=secret';
      const previousSocket = getRelaySockets()[endpoint];
      const oldSubscriptionId = subscriptionIds.get(1)?.[0];
      const oldPublicationId = publicationIds.get(1)?.[0];
      assert.ok(oldSubscriptionId);
      assert.ok(oldPublicationId);
      autoAcknowledge = false;
      const request = refreshRelaySockets(appId, roomId);
      assert.equal(request.targets.length, 1);
      assert.equal(closedSockets, 1);
      assert.equal(socketGenerations, 2);
      assert.notEqual(getRelaySockets()[endpoint], previousSocket);
      const refreshing = getRelayHealth(appId, roomId)[0];
      assert.equal(refreshing?.subscription, 'not-observed');
      assert.equal(refreshing?.publication, 'not-observed');

      await waitUntil(() => (
        (subscriptionIds.get(2)?.length ?? 0) > 0
        && (publicationIds.get(2)?.length ?? 0) > 0
      ), 8_000);
      const newSubscriptionIds = subscriptionIds.get(2) ?? [];
      const newPublicationId = publicationIds.get(2)?.[0];
      assert.ok(newSubscriptionIds.length > 0);
      assert.ok(newPublicationId);
      assert.ok(newSubscriptionIds.every((subId) => subId !== oldSubscriptionId));
      assert.notEqual(newPublicationId, oldPublicationId);

      // Deliver old acknowledgements only after the replacement generation
      // has installed its own pending subscription/publication identifiers.
      deliverRelayMessage?.(['EOSE', oldSubscriptionId]);
      deliverRelayMessage?.(['OK', oldPublicationId, true, 'stale']);
      assert.equal(getRelayHealth(appId, roomId)[0]?.subscription, 'not-observed');
      assert.equal(getRelayHealth(appId, roomId)[0]?.publication, 'not-observed');
      assert.deepEqual(
        relaySocketRefreshProgress(appId, roomId, request),
        { replaced: 1, verified: 0 },
      );
      for (const subId of newSubscriptionIds) deliverRelayMessage?.(['EOSE', subId]);
      autoAcknowledge = true;
      for (const eventId of publicationIds.get(2) ?? []) {
        deliverRelayMessage?.(['OK', eventId, true, '']);
      }

      await waitUntil(() => {
        const health = getRelayHealth(appId, roomId)[0];
        return health?.subscription === 'verified' && health.publication === 'verified';
      }, 8_000);
      assert.deepEqual(
        relaySocketRefreshProgress(appId, roomId, request),
        { replaced: 1, verified: 1 },
      );
      await room.leave();
      room = undefined;
      assert.equal(refreshRelaySockets(appId, roomId).targets.length, 0);
      assert.equal(closedSockets, 1);
    } finally {
      await room?.leave();
      setNostrSocketFactoryForTesting(undefined);
    }
  });
});
