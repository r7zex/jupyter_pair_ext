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
  type TopicPublishContext,
  type TopicSubscriptionContext,
} from '@trystero-p2p/core';
import { proxyAwareMqttOptions } from './mqttProxy';
import { signallingEndpointIdentity } from './signallingEndpoint';

const DEFAULT_REDUNDANCY = 4;
const MAX_RELAY_HEALTH_ENTRIES = 32;
const MAX_ROOM_RELAY_HEALTH_ENTRIES = 128;
const MAX_PENDING_SUBACKS_PER_CLIENT = 128;
const relayManager = createRelayManager<mqtt.MqttClient>(
  (client) => (client.stream as { socket?: WebSocket } | undefined)?.socket,
);
const messageHandlers = relayManager.scoped<(topic: string, data: string) => void>();
const subscriptionTokens = relayManager.scoped<symbol>();
const subscriptionReferences = relayManager.scoped<number>();
const observedClients = new WeakSet<mqtt.MqttClient>();

type MqttSignallingErrorCategory = 'timeout' | 'dns' | 'socket' | 'authentication' | 'protocol' | 'unknown';

interface MqttEndpointHealthState {
  connected: boolean;
  lastError?: {
    category: MqttSignallingErrorCategory;
    phase: 'endpoint';
    at: number;
  } | undefined;
}

interface MqttRoomRelayHealthState {
  appId: string;
  roomId: string;
  endpoint: string;
  subscriptions: Map<symbol, {
    topic: string;
    state: 'pending' | 'verified' | 'failed';
  }>;
  publication: 'verified' | 'failed' | 'not-observed';
  lastError?: {
    category: MqttSignallingErrorCategory;
    phase: 'subscription' | 'publication';
    at: number;
  } | undefined;
}

export interface MqttRelayHealth {
  endpointId: string;
  endpoint: string;
  connected: boolean;
  subscription: 'verified' | 'failed' | 'not-observed';
  publication: 'verified' | 'failed' | 'not-observed';
  lastError?: {
    category: MqttSignallingErrorCategory;
    phase: 'endpoint' | 'subscription' | 'publication';
    at: number;
  } | undefined;
}

const endpointHealth = new Map<string, MqttEndpointHealthState>();
const roomRelayHealth = new Map<string, MqttRoomRelayHealthState>();
const pendingSubacks = new WeakMap<mqtt.MqttClient, Map<number, string[]>>();
let connectMqtt: typeof mqtt.connect = mqtt.connect;

export type MqttRoomConfig = JoinRoomConfig;

export const joinRoom: JoinRoom<MqttRoomConfig> = createTopicStrategy({
  init: (config) => getRelays(config, defaultRelayUrls, DEFAULT_REDUNDANCY).map((url) => {
    const client = relayManager.register(url, () => connectMqtt(url, proxyAwareMqttOptions({
      reconnectOnConnackError: true,
    })));
    const health = endpointHealthFor(url, client.connected);
    const handlers = messageHandlers.forRelay(client);
    if (!observedClients.has(client)) {
      observedClients.add(client);
      client
        .on('message', (topic, buffer) => handlers[topic]?.(topic, buffer.toString()))
        .on('connect', () => {
          health.connected = true;
          health.lastError = undefined;
          resetRoomHealthForEndpoint(url);
        })
        .on('close', () => {
          health.connected = false;
          resetRoomHealthForEndpoint(url);
        })
        .on('offline', () => {
          health.connected = false;
          resetRoomHealthForEndpoint(url);
        })
        .on('error', (error) => recordMqttHealthError(health, error))
        .on('packetsend', (packet) => trackMqttSubscribePacket(client, url, packet))
        .on('packetreceive', (packet) => applyMqttSubackPacket(client, url, packet));
    }
    return client.connected
      ? Promise.resolve(client)
      : new Promise<mqtt.MqttClient>((resolve) => client.once('connect', () => resolve(client)));
  }),

  subscribeTopic: (client, topic, onMessage, context) => {
    const handlers = messageHandlers.forRelay(client);
    const tokens = subscriptionTokens.forRelay(client);
    const references = subscriptionReferences.forRelay(client);
    const token = Symbol(topic);
    const endpoint = relayManager.keyOf(client);
    const health = roomHealthFor(endpoint, context);
    health.subscriptions.set(token, { topic, state: 'pending' });
    const topicHandler = (incomingTopic: string, data: string): void => {
      void onMessage(incomingTopic, data);
    };
    handlers[topic] = topicHandler;
    tokens[topic] = token;
    references[topic] = (references[topic] ?? 0) + 1;
    if (references[topic] === 1) {
      client.subscribe(topic, { qos: 1 }, (error, grants) => {
        if (!health.subscriptions.has(token)) return;
        if (error || !grants?.length || grants.some((grant) => grant.qos === 128)) {
          health.subscriptions.set(token, { topic, state: 'failed' });
          recordMqttRoomHealthError(health, error ?? new Error('MQTT subscription rejected'), 'subscription');
        } else {
          health.subscriptions.set(token, { topic, state: 'verified' });
        }
      });
    }
    return () => {
      references[topic] = Math.max(0, (references[topic] ?? 1) - 1);
      if (references[topic] === 0) {
        client.unsubscribe(topic);
        delete references[topic];
      }
      if (handlers[topic] === topicHandler) delete handlers[topic];
      if (tokens[topic] === token) delete tokens[topic];
      health.subscriptions.delete(token);
      if (health.subscriptions.size === 0) roomRelayHealth.delete(roomHealthKey(context, endpoint));
    };
  },

  publishTopic: (client, topic, message, context) => {
    const health = roomHealthFor(relayManager.keyOf(client), context);
    client.publish(topic, typeof message === 'string' ? message : toJson(message), { qos: 1 }, (error) => {
      if (error) {
        health.publication = 'failed';
        recordMqttRoomHealthError(health, error, 'publication');
      } else {
        health.publication = 'verified';
      }
    });
  },
});

export const getRelaySockets = relayManager.getSockets;
export function getRelayHealth(appId: string, roomId: string): MqttRelayHealth[] {
  return [...endpointHealth].flatMap(([endpoint, health]) => {
    const roomHealth = roomRelayHealth.get(roomHealthKey({ appId, roomId }, endpoint));
    if (!roomHealth) return [];
    const subscription = subscriptionState(roomHealth);
    const lastError = latestMqttHealthError(health.lastError, roomHealth?.lastError);
    const identity = signallingEndpointIdentity(endpoint);
    return [{
      endpointId: identity.id,
      endpoint: identity.label,
      connected: health.connected,
      subscription,
      publication: roomHealth?.publication ?? 'not-observed',
      ...(lastError ? { lastError: { ...lastError } } : {}),
    }];
  });
}

/** Replaces MQTT.js connection creation only for deterministic adapter tests. */
export function setMqttConnectForTesting(factory: typeof mqtt.connect | undefined): void {
  connectMqtt = factory ?? mqtt.connect;
}
export { selfId };

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'public:public@public.cloud.shiftr.io',
  'broker-cn.emqx.io:8084/mqtt',
  'broker.hivemq.com:8884/mqtt',
].map((url) => `wss://${url}`);

function endpointHealthFor(endpoint: string, connected: boolean): MqttEndpointHealthState {
  let health = endpointHealth.get(endpoint);
  if (!health) {
    while (endpointHealth.size >= MAX_RELAY_HEALTH_ENTRIES) {
      const oldest = endpointHealth.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      endpointHealth.delete(oldest);
    }
    health = { connected };
    endpointHealth.set(endpoint, health);
  } else if (connected) {
    health.connected = true;
  }
  return health;
}

function roomHealthFor(
  endpoint: string,
  context: Pick<TopicSubscriptionContext | TopicPublishContext, 'appId' | 'roomId'>,
): MqttRoomRelayHealthState {
  const key = roomHealthKey(context, endpoint);
  let health = roomRelayHealth.get(key);
  if (!health) {
    while (roomRelayHealth.size >= MAX_ROOM_RELAY_HEALTH_ENTRIES) {
      const oldest = roomRelayHealth.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      roomRelayHealth.delete(oldest);
    }
    health = {
      appId: context.appId,
      roomId: context.roomId,
      endpoint,
      subscriptions: new Map(),
      publication: 'not-observed',
    };
    roomRelayHealth.set(key, health);
  }
  return health;
}

function roomHealthKey(
  context: Pick<TopicSubscriptionContext | TopicPublishContext, 'appId' | 'roomId'>,
  endpoint: string,
): string {
  return `${context.appId}\0${context.roomId}\0${endpoint}`;
}

function subscriptionState(
  health: MqttRoomRelayHealthState | undefined,
): MqttRelayHealth['subscription'] {
  const subscriptions = [...(health?.subscriptions.values() ?? [])];
  if (subscriptions.some(({ state }) => state === 'failed')) return 'failed';
  if (subscriptions.length === 0 || subscriptions.some(({ state }) => state === 'pending')) return 'not-observed';
  return 'verified';
}

function resetRoomHealthForEndpoint(endpoint: string): void {
  for (const health of roomRelayHealth.values()) {
    if (health.endpoint !== endpoint) continue;
    for (const subscription of health.subscriptions.values()) subscription.state = 'pending';
    health.publication = 'not-observed';
  }
}

function trackMqttSubscribePacket(client: mqtt.MqttClient, endpoint: string, packet: unknown): void {
  const details = packet as {
    cmd?: unknown;
    messageId?: unknown;
    subscriptions?: Array<{ topic?: unknown }>;
  };
  if (details.cmd !== 'subscribe' || typeof details.messageId !== 'number') return;
  const topics = (details.subscriptions ?? [])
    .map((subscription) => subscription.topic)
    .filter((topic): topic is string => typeof topic === 'string');
  if (topics.length === 0) return;
  let clientPending = pendingSubacks.get(client);
  if (!clientPending) {
    clientPending = new Map();
    pendingSubacks.set(client, clientPending);
  }
  while (clientPending.size >= MAX_PENDING_SUBACKS_PER_CLIENT) {
    const oldest = clientPending.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    clientPending.delete(oldest);
  }
  clientPending.set(details.messageId, topics);
  for (const health of roomRelayHealth.values()) {
    if (health.endpoint !== endpoint) continue;
    for (const subscription of health.subscriptions.values()) {
      if (topics.includes(subscription.topic)) subscription.state = 'pending';
    }
  }
}

function applyMqttSubackPacket(client: mqtt.MqttClient, endpoint: string, packet: unknown): void {
  const details = packet as { cmd?: unknown; messageId?: unknown; granted?: unknown[] };
  if (details.cmd !== 'suback' || typeof details.messageId !== 'number') return;
  const clientPending = pendingSubacks.get(client);
  const topics = clientPending?.get(details.messageId);
  if (!topics) return;
  clientPending!.delete(details.messageId);
  for (const health of roomRelayHealth.values()) {
    if (health.endpoint !== endpoint) continue;
    for (const subscription of health.subscriptions.values()) {
      const index = topics.indexOf(subscription.topic);
      if (index < 0) continue;
      const granted = details.granted?.[index];
      subscription.state = granted === 0 || granted === 1 || granted === 2 ? 'verified' : 'failed';
      if (subscription.state === 'failed') {
        recordMqttRoomHealthError(health, new Error('MQTT subscription rejected'), 'subscription');
      }
    }
  }
}

function recordMqttHealthError(
  health: MqttEndpointHealthState,
  error: unknown,
): void {
  health.lastError = { category: classifyMqttHealthError(error), phase: 'endpoint', at: Date.now() };
}

function recordMqttRoomHealthError(
  health: MqttRoomRelayHealthState,
  error: unknown,
  phase: NonNullable<MqttRoomRelayHealthState['lastError']>['phase'],
): void {
  health.lastError = { category: classifyMqttHealthError(error), phase, at: Date.now() };
}

function latestMqttHealthError(
  endpointError: MqttEndpointHealthState['lastError'],
  roomError: MqttRoomRelayHealthState['lastError'],
): MqttRelayHealth['lastError'] {
  if (!endpointError) return roomError;
  if (!roomError) return endpointError;
  return endpointError.at >= roomError.at ? endpointError : roomError;
}

function classifyMqttHealthError(error: unknown): MqttSignallingErrorCategory {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/dns|getaddrinfo|enotfound|eai_again/.test(message)) return 'dns';
  if (/auth|credential|forbidden|unauthori[sz]ed|connack/.test(message)) return 'authentication';
  if (/websocket|socket|econn|network|closed|disconnect/.test(message)) return 'socket';
  if (/protocol|malformed|invalid|subscribe|publish/.test(message)) return 'protocol';
  return 'unknown';
}
