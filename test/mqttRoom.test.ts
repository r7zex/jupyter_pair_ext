import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'mocha';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';
import type { SocketClient } from '@trystero-p2p/core';

import {
  getRelayHealth,
  getRelaySockets,
  joinRoom,
  relaySocketRefreshProgress,
  refreshRelaySockets,
  setMqttConnectForTesting,
} from '../src/runtime/mqttRoom';
import {
  MeshTransport,
  TRYSTERO_APP_ID,
} from '../src/runtime/mesh';
import {
  getRelayHealth as getNostrRelayHealth,
  joinRoom as joinNostrRoom,
  setNostrSocketFactoryForTesting,
} from '../src/runtime/nostrRoom';

type SubscriptionMode = 'success' | 'reject' | 'missing-suback' | 'hang';
type PublicationMode = 'success' | 'failure';

class FakeMqttClient extends EventEmitter {
  public connected = true;
  public readonly stream: {
    socket: { readyState: number; terminate: () => void };
  };
  public subscriptionMode: SubscriptionMode = 'success';
  public publicationMode: PublicationMode = 'success';
  public readonly subscribedTopics: string[] = [];
  public readonly subscriptionResults: SubscriptionMode[] = [];
  public holdPublicationCallbacks = false;
  public readonly pendingPublicationCallbacks: Array<() => void> = [];
  public acknowledgeReconnectSubscriptions = true;
  public socketRestarts = 0;

  public constructor() {
    super();
    this.stream = { socket: this.createSocket() };
  }

  private createSocket(): { readyState: number; terminate: () => void } {
    const socket = {
      readyState: 1,
      terminate: () => {
        if (socket.readyState >= 2) return;
        socket.readyState = 3;
        this.socketRestarts += 1;
        this.connected = false;
        this.emit('offline');
        this.stream.socket = this.createSocket();
        queueMicrotask(() => {
          this.connected = true;
          this.emit('connect');
          const topics = [...this.subscribedTopics];
          this.emit('packetsend', {
            cmd: 'subscribe',
            messageId: 900 + this.socketRestarts,
            subscriptions: topics.map((topic) => ({ topic, qos: 1 })),
          });
          if (this.acknowledgeReconnectSubscriptions) {
            this.emit('packetreceive', {
              cmd: 'suback',
              messageId: 900 + this.socketRestarts,
              granted: topics.map(() => 1),
            });
          }
        });
      },
    };
    return socket;
  }

  public subscribe(
    topic: string,
    _options: unknown,
    callback: (error: Error | null, grants?: Array<{ topic: string; qos: number }>) => void,
  ): this {
    this.subscribedTopics.push(topic);
    const mode = this.subscriptionResults.shift() ?? this.subscriptionMode;
    setImmediate(() => {
      if (mode === 'hang') return;
      if (mode === 'reject') callback(null, [{ topic, qos: 128 }]);
      else if (mode === 'missing-suback') callback(null, undefined);
      else callback(null, [{ topic, qos: 1 }]);
    });
    return this;
  }

  public unsubscribe(): this {
    return this;
  }

  public publish(
    _topic: string,
    _message: string,
    _options: unknown,
    callback: (error?: Error) => void,
  ): this {
    const complete = (): void => callback(this.publicationMode === 'failure'
      ? new Error('publish rejected token=publication-secret')
      : undefined);
    if (this.holdPublicationCallbacks) this.pendingPublicationCallbacks.push(complete);
    else setImmediate(complete);
    return this;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for MQTT signalling health transition.');
}

describe('MQTT signalling health', function () {
  this.timeout(15_000);

  it('tracks room-scoped SUBACK/PUBACK failures and redacts endpoint secrets', async () => {
    const client = new FakeMqttClient();
    const endpoint = 'wss://user:broker-secret@broker.example:443/mqtt?token=query-secret#topic-secret';
    setMqttConnectForTesting((() => client) as never);
    const config = {
      appId: 'health-app',
      password: 'room-password-secret',
      rtcPolyfill: WeriftPeerConnection,
      relayConfig: { urls: [endpoint], redundancy: 1, warnOnRelayFailure: false },
    };
    let healthyRoom: ReturnType<typeof joinRoom> | undefined;
    let failingRoom: ReturnType<typeof joinRoom> | undefined;
    let missingSubackRoom: ReturnType<typeof joinRoom> | undefined;
    let mixedRoom: ReturnType<typeof joinRoom> | undefined;
    let mesh: MeshTransport | undefined;
    try {
      healthyRoom = joinRoom(config as never, 'healthy-room');
      await waitUntil(() => {
        const health = getRelayHealth('health-app', 'healthy-room')[0];
        return health?.subscription === 'verified' && health.publication === 'verified';
      });
      const healthy = getRelayHealth('health-app', 'healthy-room')[0];
      assert.equal(healthy?.endpoint, 'wss://broker.example');
      assert.equal(healthy?.connected, true);
      const healthyTopics = [...client.subscribedTopics];

      client.subscriptionMode = 'reject';
      client.publicationMode = 'failure';
      failingRoom = joinRoom(config as never, 'failing-room');
      await waitUntil(() => {
        const health = getRelayHealth('health-app', 'failing-room')[0];
        return health?.subscription === 'failed' && health.publication === 'failed';
      });
      const failing = getRelayHealth('health-app', 'failing-room')[0];
      assert.equal(failing?.lastError?.phase, 'publication');
      assert.equal(failing?.lastError?.category, 'protocol');
      assert.doesNotMatch(JSON.stringify(failing), /publication-secret|room-password-secret/);

      // A failure in another room on the shared MQTT client must not overwrite
      // the successful room's subscription evidence.
      assert.equal(getRelayHealth('health-app', 'healthy-room')[0]?.subscription, 'verified');

      client.subscriptionMode = 'missing-suback';
      client.publicationMode = 'success';
      missingSubackRoom = joinRoom(config as never, 'missing-suback-room');
      await waitUntil(() => getRelayHealth('health-app', 'missing-suback-room')[0]?.subscription === 'failed');
      assert.equal(
        getRelayHealth('health-app', 'missing-suback-room')[0]?.lastError?.phase,
        'subscription',
      );

      client.subscriptionMode = 'success';
      client.subscriptionResults.push('reject', 'hang');
      mixedRoom = joinRoom(config as never, 'mixed-room');
      await waitUntil(() => getRelayHealth('health-app', 'mixed-room')[0]?.subscription === 'failed');

      client.connected = false;
      client.emit('offline');
      client.emit('error', new Error('getaddrinfo ENOTFOUND broker.example token=socket-secret'));
      const endpointFailure = getRelayHealth('health-app', 'healthy-room')[0];
      assert.equal(endpointFailure?.connected, false);
      assert.equal(endpointFailure?.subscription, 'not-observed');
      assert.equal(endpointFailure?.publication, 'not-observed');
      assert.equal(endpointFailure?.lastError?.phase, 'endpoint');
      assert.equal(endpointFailure?.lastError?.category, 'dns');
      assert.doesNotMatch(
        JSON.stringify(endpointFailure),
        /broker-secret|query-secret|topic-secret|socket-secret|room-password-secret/,
      );

      client.connected = true;
      client.emit('connect');
      const reconnecting = getRelayHealth('health-app', 'healthy-room')[0];
      assert.equal(reconnecting?.connected, true);
      assert.equal(reconnecting?.subscription, 'not-observed');
      assert.equal(reconnecting?.publication, 'not-observed');
      client.emit('packetsend', {
        cmd: 'subscribe',
        messageId: 77,
        subscriptions: healthyTopics.map((topic) => ({ topic, qos: 1 })),
      });
      client.publicationMode = 'success';
      const previousSocket = getRelaySockets()[endpoint];
      const listenerCounts = ['connect', 'close', 'offline', 'packetsend', 'packetreceive']
        .map((event) => [event, client.listenerCount(event)] as const);
      const request = refreshRelaySockets('health-app', 'healthy-room');
      assert.equal(request.targets.length, 1);
      assert.equal(client.socketRestarts, 1);
      assert.notEqual(getRelaySockets()[endpoint], previousSocket);
      const manuallyRefreshing = getRelayHealth('health-app', 'healthy-room')[0];
      assert.equal(manuallyRefreshing?.connected, false);
      assert.equal(manuallyRefreshing?.subscription, 'not-observed');
      assert.equal(manuallyRefreshing?.publication, 'not-observed');
      assert.deepEqual(
        relaySocketRefreshProgress('health-app', 'healthy-room', request),
        { replaced: 1, verified: 0 },
      );

      // A SUBACK queued by the replaced socket must not verify the new
      // connection generation.
      client.emit('packetreceive', {
        cmd: 'suback',
        messageId: 77,
        granted: healthyTopics.map(() => 1),
      });
      assert.equal(getRelayHealth('health-app', 'healthy-room')[0]?.subscription, 'not-observed');
      await waitUntil(() => {
        const health = getRelayHealth('health-app', 'healthy-room')[0];
        return health?.connected === true
          && health.subscription === 'verified'
          && health.publication === 'verified';
      }, 8_000);
      assert.deepEqual(
        relaySocketRefreshProgress('health-app', 'healthy-room', request),
        { replaced: 1, verified: 1 },
      );
      assert.deepEqual(
        ['connect', 'close', 'offline', 'packetsend', 'packetreceive']
          .map((event) => [event, client.listenerCount(event)] as const),
        listenerCounts,
      );

      client.subscriptionMode = 'success';
      client.publicationMode = 'failure';
      const deadRoom = {
        makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
        onPeerJoin: () => undefined,
        onPeerLeave: () => undefined,
        getPeers: () => ({}),
        ping: async () => -1,
        leave: async () => undefined,
      };
      mesh = new MeshTransport({
        sessionId: 'mesh-health-room',
        token: 'mesh-health-token-that-is-long-enough',
        localPeer: { peerId: 'mesh-health-peer', displayName: 'Mesh Health', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'mesh-health-peer' }),
        isHost: () => true,
        roomFactory: () => deadRoom as never,
        secondaryRoomFactory: joinRoom as never,
      });
      await mesh.start();
      await waitUntil(() => {
        const mqtt = mesh?.signallingDiagnostics().find((family) => family.family === 'mqtt');
        return mqtt?.endpoints.some((item) => item.subscription === 'verified'
          && item.publication === 'failed') ?? false;
      });
      assert.ok(!mesh.activeSignallingFamilies().includes('mqtt'));

      client.publicationMode = 'success';
      await waitUntil(() => mesh?.activeSignallingFamilies().includes('mqtt') ?? false);
      const mqtt = mesh.signallingDiagnostics().find((family) => family.family === 'mqtt');
      assert.equal(mqtt?.active, true);
      assert.ok(mqtt?.endpoints.some((item) => item.state === 'publish-verified'));

      await healthyRoom.leave();
      healthyRoom = undefined;
      assert.equal(refreshRelaySockets('health-app', 'healthy-room').targets.length, 0);
      assert.equal(client.socketRestarts, 1);
    } finally {
      await mesh?.stop();
      await Promise.all([
        healthyRoom?.leave(),
        failingRoom?.leave(),
        missingSubackRoom?.leave(),
        mixedRoom?.leave(),
      ]);
      setMqttConnectForTesting(undefined);
    }
  });

  it('ignores a publish completion retained by the replaced socket generation', async () => {
    const client = new FakeMqttClient();
    client.holdPublicationCallbacks = true;
    const appId = 'mqtt-publication-generation-app';
    const roomId = 'mqtt-publication-generation-room';
    const endpoint = 'wss://mqtt-publication-generation.example/mqtt?token=private';
    setMqttConnectForTesting((() => client) as never);
    let room: ReturnType<typeof joinRoom> | undefined;
    try {
      room = joinRoom({
        appId,
        password: 'mqtt-publication-generation-password',
        rtcPolyfill: WeriftPeerConnection,
        relayConfig: { urls: [endpoint], redundancy: 1, warnOnRelayFailure: false },
      } as never, roomId);
      await waitUntil(() => (
        getRelayHealth(appId, roomId)[0]?.subscription === 'verified'
        && client.pendingPublicationCallbacks.length > 0
      ));
      assert.equal(getRelayHealth(appId, roomId)[0]?.publication, 'not-observed');

      const stalePublicationCompletion = client.pendingPublicationCallbacks.shift();
      assert.ok(stalePublicationCompletion);
      const request = refreshRelaySockets(appId, roomId);
      assert.equal(request.targets.length, 1);
      assert.deepEqual(
        relaySocketRefreshProgress(appId, roomId, request),
        { replaced: 1, verified: 0 },
      );
      await waitUntil(() => client.pendingPublicationCallbacks.length > 0, 8_000);
      const freshPublicationCompletion = client.pendingPublicationCallbacks.shift();
      assert.ok(freshPublicationCompletion);
      stalePublicationCompletion();
      assert.equal(
        getRelayHealth(appId, roomId)[0]?.publication,
        'not-observed',
        'a stale PUBACK callback verified the replacement generation',
      );

      client.holdPublicationCallbacks = false;
      freshPublicationCompletion();
      await waitUntil(() => {
        const health = getRelayHealth(appId, roomId)[0];
        return health?.connected === true
          && health.subscription === 'verified'
          && health.publication === 'verified';
      }, 8_000);
      assert.deepEqual(
        relaySocketRefreshProgress(appId, roomId, request),
        { replaced: 1, verified: 1 },
      );
    } finally {
      await room?.leave();
      setMqttConnectForTesting(undefined);
    }
  });

  it('reports a bounded partial refresh without tearing down an authenticated route', async () => {
    const sessionId = 'mesh-partial-signalling-refresh';
    const nostrEndpoint = 'wss://user:nostr-secret@partial-nostr.example/path?token=hidden';
    const mqttEndpoint = 'wss://user:mqtt-secret@partial-mqtt.example/mqtt?token=hidden';
    let nostrSocketRestarts = 0;
    const mqttClients: FakeMqttClient[] = [];
    setNostrSocketFactoryForTesting(((
      url: string,
      onMessage: (data: string) => void,
      onReconnect?: () => void,
    ) => {
      const client = {} as SocketClient;
      const installSocket = (): void => {
        const socket = {
          readyState: 1,
          terminate: () => {
            if (socket.readyState >= 2) return;
            socket.readyState = 3;
            nostrSocketRestarts += 1;
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
          queueMicrotask(() => onMessage(JSON.stringify(['EOSE', message[1]])));
        } else if (message[0] === 'EVENT') {
          const event = message[1] as { id?: unknown } | undefined;
          if (typeof event?.id === 'string') {
            queueMicrotask(() => onMessage(JSON.stringify(['OK', event.id, true, ''])));
          }
        }
      };
      installSocket();
      client.ready = Promise.resolve(client);
      return client;
    }) as never);
    setMqttConnectForTesting((() => {
      const client = new FakeMqttClient();
      mqttClients.push(client);
      return client;
    }) as never);
    let nostrRoom: ReturnType<typeof joinNostrRoom> | undefined;
    let mqttRoom: ReturnType<typeof joinRoom> | undefined;
    let transport: MeshTransport | undefined;
    let nostrLeaveCalls = 0;
    let mqttLeaveCalls = 0;
    let originalNostrLeave: (() => Promise<void>) | undefined;
    let originalMqttLeave: (() => Promise<void>) | undefined;
    try {
      nostrRoom = joinNostrRoom({
        appId: TRYSTERO_APP_ID,
        password: 'mesh-partial-refresh-password',
        rtcPolyfill: WeriftPeerConnection,
        relayConfig: { urls: [nostrEndpoint], redundancy: 1, warnOnRelayFailure: false },
      } as never, sessionId);
      mqttRoom = joinRoom({
        appId: TRYSTERO_APP_ID,
        password: 'mesh-partial-refresh-password',
        rtcPolyfill: WeriftPeerConnection,
        relayConfig: { urls: [mqttEndpoint], redundancy: 1, warnOnRelayFailure: false },
      } as never, sessionId);
      await waitUntil(() => {
        const nostr = getNostrRelayHealth(TRYSTERO_APP_ID, sessionId)[0];
        const mqtt = getRelayHealth(TRYSTERO_APP_ID, sessionId)[0];
        return nostr?.subscription === 'verified'
          && nostr.publication === 'verified'
          && mqtt?.subscription === 'verified'
          && mqtt.publication === 'verified';
      });

      originalNostrLeave = nostrRoom.leave.bind(nostrRoom);
      originalMqttLeave = mqttRoom.leave.bind(mqttRoom);
      nostrRoom.leave = async () => {
        nostrLeaveCalls += 1;
        await originalNostrLeave?.();
      };
      mqttRoom.leave = async () => {
        mqttLeaveCalls += 1;
        await originalMqttLeave?.();
      };
      transport = new MeshTransport({
        sessionId,
        token: 'mesh-partial-refresh-token-is-long-enough',
        localPeer: { peerId: 'partial-refresh-host', displayName: 'Host', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'partial-refresh-host' }),
        isHost: () => true,
        signallingRefreshTimeoutMs: 3_000,
      });
      const internals = transport as unknown as {
        primaryUsesProductionSockets: boolean;
        secondaryUsesProductionSockets: boolean;
        room: ReturnType<typeof joinNostrRoom> | undefined;
        mqttRoom: ReturnType<typeof joinRoom> | undefined;
        connections: Map<string, {
          transportPeerId: string;
          identity: { peerId: string; displayName: string; joinOrder: number };
          purpose: 'runtime';
          connectedAt: number;
          lastSeen: number;
          snapshotRequested: boolean;
        }>;
        identityToTransport: Map<string, string>;
      };
      internals.primaryUsesProductionSockets = true;
      internals.secondaryUsesProductionSockets = true;
      internals.room = nostrRoom;
      internals.mqttRoom = mqttRoom;
      const now = Date.now();
      const route = {
        transportPeerId: 'authenticated-route',
        identity: { peerId: 'partial-refresh-peer', displayName: 'Peer', joinOrder: 1 },
        purpose: 'runtime' as const,
        connectedAt: now,
        lastSeen: now,
        snapshotRequested: false,
      };
      internals.connections.set(route.transportPeerId, route);
      internals.identityToTransport.set(route.identity.peerId, route.transportPeerId);
      let disconnected = 0;
      let refreshedEvents = 0;
      transport.on('peerDisconnected', () => { disconnected += 1; });
      transport.on('signallingRefreshed', () => { refreshedEvents += 1; });
      for (const client of mqttClients) client.acknowledgeReconnectSubscriptions = false;

      const result = await transport.refreshSignalling();
      assert.equal(result.status, 'partial');
      assert.deepEqual(result.nostr, {
        requestedSockets: 1,
        replacedSockets: 1,
        verifiedEndpoints: 1,
      });
      assert.deepEqual(result.mqtt, {
        requestedSockets: 1,
        replacedSockets: 1,
        verifiedEndpoints: 0,
      });
      assert.equal(nostrSocketRestarts, 1);
      assert.equal(mqttClients[0]?.socketRestarts, 1);
      assert.strictEqual(internals.connections.get(route.transportPeerId), route);
      assert.equal(internals.identityToTransport.get(route.identity.peerId), route.transportPeerId);
      assert.equal(transport.hasRoute(route.identity.peerId), true);
      assert.equal(disconnected, 0);
      assert.equal(refreshedEvents, 1);
      assert.equal(nostrLeaveCalls, 0);
      assert.equal(mqttLeaveCalls, 0);
      const diagnostics = transport.signallingDiagnostics();
      assert.equal(
        diagnostics.find((family) => family.family === 'nostr')?.lastRefresh?.status,
        'verified',
      );
      assert.equal(
        diagnostics.find((family) => family.family === 'mqtt')?.lastRefresh?.status,
        'timed-out',
      );
      assert.doesNotMatch(
        JSON.stringify({ result, diagnostics }),
        /nostr-secret|mqtt-secret|token=hidden|mesh-partial-refresh-password/,
      );
    } finally {
      await transport?.stop();
      if (nostrRoom && nostrLeaveCalls === 0) {
        await (originalNostrLeave ?? nostrRoom.leave.bind(nostrRoom))();
      }
      if (mqttRoom && mqttLeaveCalls === 0) {
        await (originalMqttLeave ?? mqttRoom.leave.bind(mqttRoom))();
      }
      setNostrSocketFactoryForTesting(undefined);
      setMqttConnectForTesting(undefined);
    }
  });
});
