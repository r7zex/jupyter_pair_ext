/**
 * Proxy-aware WebSocket for Trystero signalling.
 *
 * Trystero constructs `new WebSocket(url)` against the global WebSocket. In
 * Node that global is normally `ws`, which ignores every form of proxy
 * configuration. This factory installs a subclass that resolves a proxy for
 * the target URL at construction time (Pair Notebook/VS Code settings,
 * environment variables, then the Windows system proxy) and attaches the matching agent, so Nostr
 * discovery keeps working on proxy-only networks.
 *
 * Credentials are passed only to the agent; they are never logged and never
 * appear in error messages surfaced to the UI.
 */

import { Agent } from 'node:http';
import NodeWebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  describeProxy,
  parseProxyUrl,
  resolveProxy,
  type BoundProxyPassword,
  type ProxyDescriptor,
} from './proxy';

interface DebugController {
  namespaces?: string;
  enable(namespaces: string): void;
}

// The debug package is a direct runtime dependency without bundled declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyAgentDebug = require('debug') as DebugController;
const PROXY_AGENT_DEBUG_EXCLUSIONS = [
  '-http-proxy-agent*',
  '-https-proxy-agent*',
  '-socks-proxy-agent*',
];

/** Prevent dependency DEBUG output from exposing proxy URLs or auth headers. */
function disableCredentialBearingProxyDebug(): void {
  const current = proxyAgentDebug.namespaces?.trim() ?? '';
  const entries = current ? current.split(',').map((entry) => entry.trim()) : [];
  let changed = false;
  for (const exclusion of PROXY_AGENT_DEBUG_EXCLUSIONS) {
    if (!entries.includes(exclusion)) {
      entries.push(exclusion);
      changed = true;
    }
  }
  if (changed) proxyAgentDebug.enable(entries.join(','));
}

disableCredentialBearingProxyDebug();

function proxyAuthorizationHeaders(
  proxy: ProxyDescriptor,
): (() => Record<string, string>) | undefined {
  if (proxy.username === undefined && proxy.password === undefined) return undefined;
  const encoded = Buffer.from(
    (proxy.username ?? '') + ':' + (proxy.password ?? ''),
    'utf8',
  ).toString('base64');
  return () => ({ 'Proxy-Authorization': 'Basic ' + encoded });
}

export interface ProxyWebSocketRuntimeOptions {
  /** Pair Notebook override; useful for local Karing HTTP/SOCKS listeners. */
  explicitProxy?: string | undefined;
  /** SecretStorage credential bound to the exact explicit endpoint + username. */
  explicitProxyPassword?: BoundProxyPassword | undefined;
  vscodeProxy?: string | undefined;
  vscodeProxySupport?: string | undefined;
  vscodeNoProxy?: readonly string[] | undefined;
  systemProxy?: string | undefined;
  systemNoProxy?: string | undefined;
  env?: Record<string, string | undefined>;
}

export function createProxyAgent(
  targetUrl: string,
  options: ProxyWebSocketRuntimeOptions,
): { agent: Agent; proxy: ProxyDescriptor } | undefined {
  const proxy = resolveProxy(targetUrl, options);
  if (!proxy) return undefined;
  disableCredentialBearingProxyDebug();
  const credentials = proxy.username !== undefined || proxy.password !== undefined
    ? encodeURIComponent(proxy.username ?? '') + ':' + encodeURIComponent(proxy.password ?? '') + '@'
    : '';
  const authority = proxy.host + ':' + proxy.port;
  const credentialFreeProxyUrl = proxy.kind + '://' + authority;
  switch (proxy.kind) {
    case 'socks4':
      return { agent: new SocksProxyAgent(proxy.kind + '://' + credentials + authority), proxy };
    case 'socks5':
    case 'socks5h':
      return { agent: new SocksProxyAgent(proxy.kind + '://' + credentials + authority), proxy };
    case 'https':
    case 'http': {
      const targetProtocol = new URL(targetUrl).protocol;
      const headers = proxyAuthorizationHeaders(proxy);
      const agentOptions = headers ? { headers } : undefined;
      // Secure WebSocket requests need a CONNECT tunnel even when the proxy
      // itself speaks plain HTTP. HttpProxyAgent forwards the request instead,
      // which makes ordinary HTTP proxies reject the WebSocket upgrade with
      // HTTP 400. HttpsProxyAgent supports both HTTP and HTTPS proxy transports
      // and upgrades the established tunnel to target TLS for `wss:`.
      const agent = targetProtocol === 'wss:' || targetProtocol === 'https:'
        ? new HttpsProxyAgent(credentialFreeProxyUrl, agentOptions)
        : new HttpProxyAgent(credentialFreeProxyUrl, agentOptions);
      return { agent, proxy };
    }
  }
}

/** Module-level copy of the active proxy runtime options. */
let activeProxyRuntimeOptions: ProxyWebSocketRuntimeOptions = {};

/**
 * Creates a raw Node WebSocket for first-party channels (e.g. the emergency
 * Nostr data relay) that honours exactly the same proxy resolution as
 * Trystero signalling. Keeping one resolver prevents two divergent proxy
 * implementations; credentials only ever reach the agent.
 */
export function createProxiedNodeWebSocket(
  url: string,
  protocols?: string | string[],
): NodeWebSocket {
  let agent: Agent | undefined;
  try {
    agent = createProxyAgent(url, activeProxyRuntimeOptions)?.agent;
  } catch {
    agent = undefined;
  }
  const socket = protocols === undefined
    ? new NodeWebSocket(url, agent ? { agent } : undefined)
    : new NodeWebSocket(url, protocols, agent ? { agent } : undefined);
  // Same crash-safety rationale as ProxyAwareWebSocket above.
  socket.on('error', () => { /* handled via close/reconnect */ });
  return socket;
}

/** Installs the proxy-aware WebSocket as the global used by Trystero. */
export function installProxyAwareWebSocket(options: ProxyWebSocketRuntimeOptions = {}): void {
  activeProxyRuntimeOptions = { ...options };
  const runtime = globalThis as unknown as { WebSocket?: unknown };

  class ProxyAwareWebSocket extends NodeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const target = url.toString();
      // A malformed configured proxy must never break direct connectivity;
      // fall back to a plain socket instead of throwing from the constructor.
      let resolved: ReturnType<typeof createProxyAgent>;
      try {
        resolved = createProxyAgent(target, options);
      } catch {
        resolved = undefined;
      }
      super(url, protocols, resolved ? { agent: resolved.agent } : undefined);
      // An unhandled 'error' event crashes Node by default (`ws` semantics).
      // Relay failures are routine on filtered networks; Trystero reacts to
      // the subsequent 'close' with per-relay reconnection, so a single bad
      // relay must never take down the whole extension host.
      this.on('error', () => { /* handled via close/reconnect */ });
    }
  }

  runtime.WebSocket = ProxyAwareWebSocket;
}

/** Credential-free description of what signalling would use for `url`. */
export function describeSignallingPath(url: string, options: ProxyWebSocketRuntimeOptions = {}): string {
  try {
    return `Signalling ${describeProxy(resolveProxy(url, options))}`;
  } catch {
    return 'Signalling Direct';
  }
}

export { parseProxyUrl };
