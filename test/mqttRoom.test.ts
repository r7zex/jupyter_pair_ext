import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'mocha';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';

import {
  getRelayHealth,
  joinRoom,
  setMqttConnectForTesting,
} from '../src/runtime/mqttRoom';
import { MeshTransport } from '../src/runtime/mesh';

type SubscriptionMode = 'success' | 'reject' | 'missing-suback' | 'hang';
type PublicationMode = 'success' | 'failure';

class FakeMqttClient extends EventEmitter {
  public connected = true;
  public readonly stream = { socket: { readyState: 1 } };
  public subscriptionMode: SubscriptionMode = 'success';
  public publicationMode: PublicationMode = 'success';
  public readonly subscribedTopics: string[] = [];
  public readonly subscriptionResults: SubscriptionMode[] = [];

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
    setImmediate(() => callback(this.publicationMode === 'failure'
      ? new Error('publish rejected token=publication-secret')
      : undefined));
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
      client.emit('packetreceive', {
        cmd: 'suback',
        messageId: 77,
        granted: healthyTopics.map(() => 1),
      });
      assert.equal(getRelayHealth('health-app', 'healthy-room')[0]?.subscription, 'verified');

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
});
