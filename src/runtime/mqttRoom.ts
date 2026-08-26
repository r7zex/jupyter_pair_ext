/**
 * Proxy-aware form of Trystero's official MQTT topic strategy.
 *
 * @trystero-p2p/mqtt 0.25.3 calls `mqtt.connect(url)` without options. In
 * Node, MQTT.js creates its own imported `ws` constructor and therefore does
 * not use Trystero's global proxy-aware WebSocket. This small adapter keeps
 * the official core strategy while supplying MQTT.js' `createWebsocket` hook.
 */

import mqtt from 'mqtt';
import {
  createRelayManager,
  createTopicStrategy,
  getRelays,
  selfId,
  toJson,
  type JoinRoom,
  type JoinRoomConfig,
} from '@trystero-p2p/core';
import { proxyAwareMqttOptions } from './mqttProxy';

const DEFAULT_REDUNDANCY = 4;
const relayManager = createRelayManager<mqtt.MqttClient>(
  (client) => (client.stream as { socket?: WebSocket } | undefined)?.socket,
);
const messageHandlers = relayManager.scoped<(topic: string, data: string) => void>();
const subscriptionTokens = relayManager.scoped<symbol>();
const subscriptionReferences = relayManager.scoped<number>();

export type MqttRoomConfig = JoinRoomConfig;

export const joinRoom: JoinRoom<MqttRoomConfig> = createTopicStrategy({
  init: (config) => getRelays(config, defaultRelayUrls, DEFAULT_REDUNDANCY).map((url) => {
    const client = relayManager.register(url, () => mqtt.connect(url, proxyAwareMqttOptions({
      reconnectOnConnackError: true,
    })));
    const handlers = messageHandlers.forRelay(client);
    if (client.listenerCount('message') === 0) {
      client
        .on('message', (topic, buffer) => handlers[topic]?.(topic, buffer.toString()))
        .on('error', () => undefined);
    }
    return client.connected
      ? Promise.resolve(client)
      : new Promise<mqtt.MqttClient>((resolve) => client.once('connect', () => resolve(client)));
  }),

  subscribeTopic: (client, topic, onMessage) => {
    const handlers = messageHandlers.forRelay(client);
    const tokens = subscriptionTokens.forRelay(client);
    const references = subscriptionReferences.forRelay(client);
    const token = Symbol(topic);
    const topicHandler = (incomingTopic: string, data: string): void => {
      void onMessage(incomingTopic, data);
    };
    handlers[topic] = topicHandler;
    tokens[topic] = token;
    references[topic] = (references[topic] ?? 0) + 1;
    if (references[topic] === 1) client.subscribe(topic);
    return () => {
      references[topic] = Math.max(0, (references[topic] ?? 1) - 1);
      if (references[topic] === 0) {
        client.unsubscribe(topic);
        delete references[topic];
      }
      if (handlers[topic] === topicHandler) delete handlers[topic];
      if (tokens[topic] === token) delete tokens[topic];
    };
  },

  publishTopic: (client, topic, message) => {
    client.publish(topic, typeof message === 'string' ? message : toJson(message));
  },
});

export const getRelaySockets = relayManager.getSockets;
export { selfId };

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'public:public@public.cloud.shiftr.io',
  'broker-cn.emqx.io:8084/mqtt',
  'broker.hivemq.com:8884/mqtt',
].map((url) => `wss://${url}`);
