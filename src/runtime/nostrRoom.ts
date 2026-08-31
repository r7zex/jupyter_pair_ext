/**
 * Nostr topic strategy with room-scoped protocol health.
 *
 * Trystero's public Nostr adapter exposes WebSocket objects but not whether a
 * relay accepted a room subscription or publication. This adapter keeps the
 * same core strategy and message format while retaining only bounded,
 * credential-free EOSE/OK/CLOSED/NOTICE evidence for diagnostics.
 */

import {
  createEvent,
  defaultRelayUrls,
} from 'trystero';
import {
  createRelayManager,
  createTopicStrategy,
  fromJson,
  genId,
  getRelays,
  makeSocket,
  resumeRelayReconnection,
  selfId,
  strToNum,
  toJson,
  type JoinRoom,
  type JoinRoomConfig,
  type SocketClient,
  type StrategyMessage,
  type TopicPublishContext,
  type TopicSubscriptionContext,
} from '@trystero-p2p/core';
import { signallingEndpointIdentity } from './signallingEndpoint';
import { forceSignallingSocketRefresh } from './signallingSocketRefresh';

const DEFAULT_REDUNDANCY = 5;
const MAX_ROOM_RELAY_HEALTH_ENTRIES = 128;
const MAX_PENDING_PUBLICATIONS_PER_RELAY = 128;
const MAX_RELAY_SOCKET_REFRESHES = 32;

type NostrHealthState = 'pending' | 'verified' | 'failed';

interface NostrRoomRelayHealthState {
  endpoint: string;
  subscriptions: Map<symbol, NostrHealthState>;
  publication: NostrHealthState | 'not-observed';
  publicationGeneration: number;
  lastError?: {
    category: 'protocol';
    phase: 'endpoint' | 'subscription' | 'publication';
    at: number;
  } | undefined;
}

interface NostrSubscription {
  topic: string;
  token: symbol;
  health: NostrRoomRelayHealthState;
  onMessage(topic: string, message: StrategyMessage): void | Promise<void>;
}

interface NostrPublication {
  health: NostrRoomRelayHealthState;
  generation: number;
}

export interface NostrRelayHealth {
  endpointId: string;
  endpoint: string;
  subscription: 'verified' | 'failed' | 'not-observed';
  publication: 'verified' | 'failed' | 'not-observed';
  lastError?: NostrRoomRelayHealthState['lastError'];
}

export interface NostrRelaySocketRefreshRequest {
  targets: Array<{
    endpoint: string;
    endpointId: string;
    previousSocket: unknown;
  }>;
}

const relayManager = createRelayManager<SocketClient>((client) => client.socket);
const subscriptions = relayManager.scoped<NostrSubscription>();
const pendingPublications = relayManager.scoped<NostrPublication>();
const roomRelayHealth = new Map<string, NostrRoomRelayHealthState>();
const relayClients = new Map<string, SocketClient>();
let createNostrSocket: typeof makeSocket = makeSocket;
let publicationSequence = 0;

export type NostrRoomConfig = JoinRoomConfig;

export const joinRoom: JoinRoom<NostrRoomConfig> = createTopicStrategy({
  init: (config) => getRelays(config, defaultRelayUrls, DEFAULT_REDUNDANCY, true).map((url) => {
    const client = relayManager.register(url, () => createNostrSocket(
      url,
      (data) => handleRelayMessage(client, data),
      () => resubscribe(client),
    ));
    relayClients.set(url, client);
    return client.ready;
  }),

  subscribeTopic: (client, topic, onMessage, context) => {
    const endpoint = relayManager.keyOf(client);
    const health = roomHealthFor(endpoint, context);
    const token = Symbol(topic);
    const subId = genId(64);
    health.subscriptions.set(token, 'pending');
    subscriptions.forRelay(client)[subId] = { topic, token, health, onMessage };
    client.send(encodeSubscription(subId, topic));
    return () => {
      client.send(toJson(['CLOSE', subId]));
      delete subscriptions.forRelay(client)[subId];
      health.subscriptions.delete(token);
      if (health.subscriptions.size === 0) roomRelayHealth.delete(roomHealthKey(context, endpoint));
    };
  },

  publishTopic: async (client, topic, message, context) => {
    const endpoint = relayManager.keyOf(client);
    const health = roomHealthFor(endpoint, context);
    health.publication = 'pending';
    const generation = ++health.publicationGeneration;
    let encoded: string;
    try {
      const content = typeof message === 'string' ? message : toJson(message);
      encoded = await createEvent(topic, withPublicationSequence(content));
    } catch (error) {
      if (health.publicationGeneration === generation) {
        health.publication = 'failed';
        recordNostrError(health, 'publication');
      }
      throw error;
    }
    // Signing is asynchronous. A refresh may have advanced the room while
    // createEvent was awaiting crypto; never send that old generation through
    // the replacement socket or let its acknowledgement affect new evidence.
    if (health.publicationGeneration !== generation) return;
    const parsed = safeNostrMessage(encoded);
    const event = parsed?.[1];
    const eventId = event && typeof event === 'object' && !Array.isArray(event)
      && typeof (event as { id?: unknown }).id === 'string'
      ? (event as { id: string }).id
      : undefined;
    if (eventId) {
      const pending = pendingPublications.forRelay(client);
      while (Object.keys(pending).length >= MAX_PENDING_PUBLICATIONS_PER_RELAY) {
        const oldest = Object.keys(pending)[0];
        if (!oldest) break;
        delete pending[oldest];
      }
      pending[eventId] = { health, generation };
    }
    client.send(encoded);
  },
});

export const getRelaySockets = relayManager.getSockets;

/** Forces this room's half-open relay sockets through the normal reconnect path. */
export function refreshRelaySockets(appId: string, roomId: string): NostrRelaySocketRefreshRequest {
  const activeEndpoints = activeRoomEndpoints(appId, roomId);
  if (activeEndpoints.size === 0) return { targets: [] };
  resumeRelayReconnection();
  const targets: NostrRelaySocketRefreshRequest['targets'] = [];
  for (const [endpoint, socket] of Object.entries(relayManager.getSockets())
    .filter(([endpoint]) => activeEndpoints.has(endpoint))
    .slice(0, MAX_RELAY_SOCKET_REFRESHES)) {
    if (!forceSignallingSocketRefresh(socket, () => prepareRelayRefresh(endpoint))) continue;
    targets.push({
      endpoint,
      endpointId: signallingEndpointIdentity(endpoint).id,
      previousSocket: socket,
    });
  }
  return { targets };
}

export function relaySocketRefreshProgress(
  appId: string,
  roomId: string,
  request: NostrRelaySocketRefreshRequest,
): { replaced: number; verified: number } {
  const sockets = relayManager.getSockets();
  const healthById = new Map(getRelayHealth(appId, roomId).map((health) => [health.endpointId, health]));
  let replaced = 0;
  let verified = 0;
  for (const target of request.targets) {
    const current = sockets[target.endpoint];
    const isReplacement = Boolean(current && current !== target.previousSocket && current.readyState === 1);
    if (!isReplacement) continue;
    replaced += 1;
    const health = healthById.get(target.endpointId);
    if (health?.subscription === 'verified' && health.publication === 'verified') verified += 1;
  }
  return { replaced, verified };
}

/** Replaces core socket creation only for deterministic adapter tests. */
export function setNostrSocketFactoryForTesting(factory: typeof makeSocket | undefined): void {
  createNostrSocket = factory ?? makeSocket;
}

export function getRelayHealth(appId: string, roomId: string): NostrRelayHealth[] {
  const prefix = roomHealthKeyPrefix(appId, roomId);
  return [...roomRelayHealth]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, health]) => {
      const identity = signallingEndpointIdentity(health.endpoint);
      return {
        endpointId: identity.id,
        endpoint: identity.label,
        subscription: subscriptionState(health),
        publication: health.publication === 'pending' ? 'not-observed' : health.publication,
        ...(health.lastError ? { lastError: { ...health.lastError } } : {}),
      };
    });
}

function handleRelayMessage(client: SocketClient, data: string): void {
  const message = safeNostrMessage(data);
  if (!message || typeof message[0] !== 'string') return;
  const messageType = message[0];
  if (messageType === 'EVENT') {
    const subId = typeof message[1] === 'string' ? message[1] : undefined;
    const event = message[2];
    const content = event && typeof event === 'object' && !Array.isArray(event)
      ? (event as { content?: unknown }).content
      : undefined;
    const subscription = subId ? subscriptions.forRelay(client)[subId] : undefined;
    if (subscription && typeof content === 'string') {
      if (subscription.health.subscriptions.get(subscription.token) !== 'failed') {
        subscription.health.subscriptions.set(subscription.token, 'verified');
      }
      void subscription.onMessage(subscription.topic, content);
    }
    return;
  }
  if (messageType === 'EOSE') {
    const subId = typeof message[1] === 'string' ? message[1] : undefined;
    const subscription = subId ? subscriptions.forRelay(client)[subId] : undefined;
    if (subscription && subscription.health.subscriptions.get(subscription.token) !== 'failed') {
      subscription.health.subscriptions.set(subscription.token, 'verified');
    }
    return;
  }
  if (messageType === 'CLOSED') {
    const subId = typeof message[1] === 'string' ? message[1] : undefined;
    const subscription = subId ? subscriptions.forRelay(client)[subId] : undefined;
    if (subscription) {
      subscription.health.subscriptions.set(subscription.token, 'failed');
      recordNostrError(subscription.health, 'subscription');
    }
    return;
  }
  if (messageType === 'OK') {
    const eventId = typeof message[1] === 'string' ? message[1] : undefined;
    const accepted = message[2] === true;
    const pending = eventId ? pendingPublications.forRelay(client)[eventId] : undefined;
    if (!eventId || !pending) return;
    delete pendingPublications.forRelay(client)[eventId];
    if (pending.health.publicationGeneration !== pending.generation) return;
    pending.health.publication = accepted ? 'verified' : 'failed';
    if (!accepted) recordNostrError(pending.health, 'publication');
    return;
  }
  if (messageType === 'NOTICE') {
    const endpoint = relayManager.keyOf(client);
    for (const health of roomRelayHealth.values()) {
      if (health.endpoint === endpoint) recordNostrError(health, 'endpoint');
    }
  }
}

function resubscribe(client: SocketClient): void {
  const endpoint = relayManager.keyOf(client);
  prepareRelayRefresh(endpoint);
  for (const [subId, subscription] of Object.entries(subscriptions.forRelay(client))) {
    client.send(encodeSubscription(subId, subscription.topic));
  }
}

function prepareRelayRefresh(endpoint: string): void {
  const client = relayClients.get(endpoint);
  if (client) {
    const publications = pendingPublications.forRelay(client);
    for (const eventId of Object.keys(publications)) delete publications[eventId];
    rotateSubscriptions(client);
  }
  for (const health of roomRelayHealth.values()) {
    if (health.endpoint !== endpoint) continue;
    for (const token of health.subscriptions.keys()) health.subscriptions.set(token, 'pending');
    health.publication = 'not-observed';
    health.publicationGeneration += 1;
  }
}

function rotateSubscriptions(client: SocketClient): void {
  const current = subscriptions.forRelay(client);
  for (const [previousSubId, subscription] of Object.entries(current)) {
    delete current[previousSubId];
    const nextSubId = genId(64);
    current[nextSubId] = subscription;
  }
}

function activeRoomEndpoints(appId: string, roomId: string): Set<string> {
  const prefix = roomHealthKeyPrefix(appId, roomId);
  return new Set([...roomRelayHealth]
    .filter(([key, health]) => key.startsWith(prefix) && health.subscriptions.size > 0)
    .map(([, health]) => health.endpoint));
}

function encodeSubscription(subId: string, topic: string): string {
  return toJson([
    'REQ',
    subId,
    {
      kinds: [strToNum(topic, 1e4) + 2e4],
      since: Math.floor(Date.now() / 1e3),
      '#x': [topic],
    },
  ]);
}

/**
 * Nostr event ids include second-resolution time, so identical announcements
 * created in the same second otherwise reuse an id. A fixed-width trailing
 * JSON-whitespace sequence preserves Trystero wire compatibility while making
 * every publication in this process distinct from the generation it replaces.
 */
function withPublicationSequence(content: string): string {
  publicationSequence = (publicationSequence + 1) >>> 0;
  let value = publicationSequence;
  let suffix = '\n';
  for (let bit = 0; bit < 32; bit += 1) {
    suffix += (value & 1) === 1 ? '\t' : ' ';
    value >>>= 1;
  }
  return content + suffix;
}

function roomHealthFor(
  endpoint: string,
  context: Pick<TopicSubscriptionContext | TopicPublishContext, 'appId' | 'roomId'>,
): NostrRoomRelayHealthState {
  const key = roomHealthKey(context, endpoint);
  let health = roomRelayHealth.get(key);
  if (!health) {
    while (roomRelayHealth.size >= MAX_ROOM_RELAY_HEALTH_ENTRIES) {
      const oldest = roomRelayHealth.keys().next().value as string | undefined;
      if (!oldest) break;
      roomRelayHealth.delete(oldest);
    }
    health = {
      endpoint,
      subscriptions: new Map(),
      publication: 'not-observed',
      publicationGeneration: 0,
    };
    roomRelayHealth.set(key, health);
  }
  return health;
}

function roomHealthKey(
  context: Pick<TopicSubscriptionContext | TopicPublishContext, 'appId' | 'roomId'>,
  endpoint: string,
): string {
  return `${roomHealthKeyPrefix(context.appId, context.roomId)}${endpoint}`;
}

function roomHealthKeyPrefix(appId: string, roomId: string): string {
  return `${appId}\0${roomId}\0`;
}

function subscriptionState(health: NostrRoomRelayHealthState): NostrRelayHealth['subscription'] {
  const states = [...health.subscriptions.values()];
  if (states.some((state) => state === 'failed')) return 'failed';
  if (states.length === 0 || states.some((state) => state === 'pending')) return 'not-observed';
  return 'verified';
}

function recordNostrError(
  health: NostrRoomRelayHealthState,
  phase: NonNullable<NostrRoomRelayHealthState['lastError']>['phase'],
): void {
  health.lastError = { category: 'protocol', phase, at: Date.now() };
}

function safeNostrMessage(value: string): unknown[] | undefined {
  try {
    const parsed = fromJson<unknown>(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export { selfId };
