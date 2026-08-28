import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it } from 'mocha';
import {
  deriveMqttRelayTopic,
  MqttFrameRelay,
  type MqttRelayClient,
} from '../src/runtime/mqttFrameRelay';
import { RedundantFrameRelay } from '../src/runtime/redundantFrameRelay';
import { type FrameRelay } from '../src/runtime/frameRelay';
import {
  createRelayAnnounceProof,
  deriveRelayFrameKey,
} from '../src/runtime/relayCrypto';

class FakeMqttHub {
  public readonly clients = new Set<FakeMqttClient>();
  public readonly published: Array<{ topic: string; payload: string }> = [];

  constructor(public deliverMessages = true) {}

  client(): FakeMqttClient {
    const client = new FakeMqttClient(this);
    this.clients.add(client);
    return client;
  }

  publish(topic: string, payload: string): void {
    this.published.push({ topic, payload });
    if (!this.deliverMessages) return;
    for (const client of this.clients) {
      if (client.subscriptions.has(topic)) client.emit('message', topic, Buffer.from(payload, 'utf8'));
    }
  }
}

class FakeMqttClient extends EventEmitter implements MqttRelayClient {
  public connected = true;
  public readonly subscriptions = new Set<string>();

  constructor(private readonly hub: FakeMqttHub) {
    super();
  }

  public subscribe(
    topic: string,
    _options: { qos: 1 },
    callback: (error?: Error | null, granted?: readonly { topic: string; qos: number }[]) => void,
  ): void {
    this.subscriptions.add(topic);
    callback(undefined, [{ topic, qos: 1 }]);
  }

  public publish(
    topic: string,
    payload: string,
    _options?: unknown,
    callback?: (error?: Error | null) => void,
  ): void {
    this.hub.publish(topic, payload);
    callback?.();
  }

  public end(): void {
    this.connected = false;
    this.hub.clients.delete(this);
    this.emit('close');
  }
}

function buildRelay(hub: FakeMqttHub, localPeerId: string, token = 'mqtt-frame-token-that-is-long-enough'): MqttFrameRelay {
  return new MqttFrameRelay({
    token,
    sessionId: 'mqtt-frame-session',
    localPeerId,
    brokers: ['wss://fake-broker/mqtt'],
    clientFactory: () => hub.client(),
  });
}

describe('emergency MQTT data relay', () => {
  it('accepts either complete relay family and fails only when every family is unavailable', async () => {
    const channel = (result: 'ready' | 'failed'): FrameRelay => ({
      connectedRelayCount: result === 'ready' ? 1 : 0,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      waitUntilReady: async () => {
        if (result === 'failed') throw new Error('family unavailable');
      },
      sendAnnounce: () => undefined,
      send: () => undefined,
    });
    const options = {
      token: 'redundant-readiness-token-that-is-long-enough',
      sessionId: 'redundant-readiness',
      localPeerId: 'redundant-local',
    };
    await new RedundantFrameRelay({
      ...options,
      channels: [channel('failed'), channel('ready')],
    }).waitUntilReady();
    await assert.rejects(
      new RedundantFrameRelay({
        ...options,
        channels: [channel('failed'), channel('failed')],
      }).waitUntilReady(),
      /No emergency relay family became ready/,
    );
  });

  it('does not report an MQTT broker ready when SUBACK rejects or downgrades QoS 1', async () => {
    for (const grantedQos of [0, 128]) {
      const rejectedClient = new FakeMqttClient(new FakeMqttHub());
      rejectedClient.subscribe = (topic, _options, callback): void => {
        (callback as (...args: unknown[]) => void)(undefined, [{ topic, qos: grantedQos }]);
      };
      const relay = new MqttFrameRelay({
        token: 'mqtt-rejected-subscription-token',
        sessionId: `mqtt-rejected-subscription-${grantedQos}`,
        localPeerId: 'mqtt-rejected-local',
        brokers: ['wss://rejecting-broker/mqtt'],
        clientFactory: () => rejectedClient,
      });
      relay.start();
      await assert.rejects(
        relay.waitUntilReady(50),
        /No MQTT emergency broker completed a verified data-path check/,
      );
      relay.stop();
    }
  });

  it('does not report an MQTT broker ready when its publish path drops data', async () => {
    const hub = new FakeMqttHub(false);
    const relay = new MqttFrameRelay({
      token: 'mqtt-frame-token-that-is-long-enough',
      sessionId: 'mqtt-frame-session',
      localPeerId: 'mqtt-dropped-readiness',
      brokers: ['wss://fake-broker/mqtt'],
      clientFactory: () => hub.client(),
      readinessProbeTimeoutMs: 20,
      readinessRetryMs: 5,
    });
    relay.start();
    await assert.rejects(
      relay.waitUntilReady(30),
      /No MQTT emergency broker completed a verified data-path check/,
    );
    hub.deliverMessages = true;
    await relay.waitUntilReady(100);
    assert.equal(relay.connectedRelayCount, 1);
    relay.stop();
  });

  it('retires a verified MQTT path when QoS delivery later fails', () => {
    const hub = new FakeMqttHub();
    const client = hub.client();
    const relay = new MqttFrameRelay({
      token: 'mqtt-later-failure-token',
      sessionId: 'mqtt-later-failure',
      localPeerId: 'mqtt-later-local',
      brokers: ['wss://fake-broker/mqtt'],
      clientFactory: () => client,
    });
    relay.start();
    assert.equal(relay.connectedRelayCount, 1);
    client.publish = (_topic, _payload, _options, callback): void => {
      callback?.(new Error('PUBACK failed'));
    };
    relay.send(Buffer.from('later-data-failure'));
    assert.equal(relay.connectedRelayCount, 0);
    relay.stop();
  });

  it('announces peers and exchanges encrypted frames without WebRTC or Nostr', () => {
    const hub = new FakeMqttHub();
    const first = buildRelay(hub, 'mqtt-a');
    const second = buildRelay(hub, 'mqtt-b');
    const announced: string[] = [];
    const received: Buffer[] = [];
    second.onPeerAnnounce = (peerId) => announced.push(peerId);
    second.onFrame = (_peerId, bytes) => received.push(Buffer.from(bytes));
    first.start();
    second.start();
    first.sendAnnounce();
    const payload = Buffer.from('mqtt-emergency-path');
    first.send(payload, 'mqtt-b');

    assert.deepEqual(announced, ['mqtt-a']);
    assert.equal(received.length, 1);
    assert.ok(received[0]!.equals(payload));
    assert.ok(!hub.published.some((item) => item.payload.includes(payload.toString('utf8'))));
    first.stop();
    second.stop();
  });

  it('rejects forged MQTT announces and accepts a same-session HMAC proof', () => {
    const hub = new FakeMqttHub();
    const relay = buildRelay(hub, 'mqtt-local');
    const announced: string[] = [];
    relay.onPeerAnnounce = (peerId) => announced.push(peerId);
    relay.start();
    const token = 'mqtt-frame-token-that-is-long-enough';
    const sessionId = 'mqtt-frame-session';
    const topic = deriveMqttRelayTopic(sessionId, token);
    const key = deriveRelayFrameKey(token, sessionId);

    hub.publish(topic, JSON.stringify({ v: 1, t: 'a', f: 'missing-proof' }));
    hub.publish(topic, JSON.stringify({
      v: 1,
      t: 'a',
      f: 'wrong-session',
      d: createRelayAnnounceProof(key, 'another-session', 'wrong-session'),
    }));
    hub.publish(topic, JSON.stringify({
      v: 1,
      t: 'a',
      f: 'valid-peer',
      d: createRelayAnnounceProof(key, sessionId, 'valid-peer'),
    }));

    assert.deepEqual(announced, ['valid-peer']);
    relay.stop();
  });

  it('bounds redundant announce deduplication state', () => {
    const channel: FrameRelay = {
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => undefined,
      send: () => undefined,
    };
    const redundant = new RedundantFrameRelay({
      token: 'bounded-announces-token-that-is-long-enough',
      sessionId: 'bounded-announces',
      localPeerId: 'local-peer',
      channels: [channel],
    });
    const accepted: string[] = [];
    redundant.onPeerAnnounce = (peerId) => accepted.push(peerId);

    for (let index = 0; index < 1_100; index += 1) {
      channel.onPeerAnnounce(`peer-${index}`);
    }

    assert.equal(accepted.length, 1_024);
    assert.equal((redundant as unknown as { announcedPeers: Map<string, number> }).announcedPeers.size, 1_024);
    redundant.stop();
  });

  it('chunks a standard snapshot transfer frame and deduplicates QoS-1 delivery', () => {
    const hub = new FakeMqttHub();
    const first = buildRelay(hub, 'mqtt-large-a');
    const second = buildRelay(hub, 'mqtt-large-b');
    const received: Buffer[] = [];
    second.onFrame = (_peerId, bytes) => received.push(Buffer.from(bytes));
    first.start();
    second.start();
    const payload = randomBytes(64 * 1024);
    first.send(payload, 'mqtt-large-b');

    assert.equal(received.length, 1);
    assert.ok(received[0]!.equals(payload));
    // Re-deliver every QoS-1 broker packet. Completed packet ids stay seen.
    const published = [...hub.published];
    for (const item of published) hub.publish(item.topic, item.payload);
    assert.equal(received.length, 1);
    first.stop();
    second.stop();
  });

  it('drops ciphertext from another session secret', () => {
    const hub = new FakeMqttHub();
    const first = buildRelay(hub, 'mqtt-key-a');
    const second = buildRelay(hub, 'mqtt-key-b', 'different-mqtt-frame-token-value');
    let received = 0;
    second.onFrame = () => { received += 1; };
    first.start();
    second.start();
    first.send(Buffer.from('must-not-decrypt'), 'mqtt-key-b');
    assert.equal(received, 0);
    first.stop();
    second.stop();
  });
});
