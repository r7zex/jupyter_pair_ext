/**
 * Proxy-aware WebSocket for Trystero signalling.
 *
 * Trystero constructs `new WebSocket(url)` against the global WebSocket. In
 * Node that global is normally `ws`, which ignores every form of proxy
 * configuration. This factory installs a subclass that resolves a proxy for
 * the target URL at construction time (VS Code setting first, then the
 * standard environment variables) and attaches the matching agent, so Nostr
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
import { describeProxy, parseProxyUrl, resolveProxy, type ProxyDescriptor } from './proxy';

export interface ProxyWebSocketRuntimeOptions {
  /** VS Code `http.proxy` value; env vars are used when omitted or empty. */
  vscodeProxy?: string | undefined;
  vscodeProxySupport?: string | undefined;
  env?: Record<string, string | undefined>;
}

export function createProxyAgent(
  targetUrl: string,
  options: ProxyWebSocketRuntimeOptions,
): { agent: Agent; proxy: ProxyDescriptor } | undefined {
  const proxy = resolveProxy(targetUrl, options);
  if (!proxy) return undefined;
  const credentials = proxy.username !== undefined
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  const authority = `${proxy.host}:${proxy.port}`;
  switch (proxy.kind) {
    case 'socks4':
      return { agent: new SocksProxyAgent(`socks4://${credentials}${authority}`), proxy };
    case 'socks5':
    case 'socks5h':
      return {
        agent: new SocksProxyAgent(`socks5${proxy.kind === 'socks5h' ? 'h' : ''}://${credentials}${authority}`),
        proxy,
      };
    case 'https':
      return { agent: new HttpsProxyAgent(`http://${credentials}${authority}`), proxy };
    default:
      return { agent: new HttpProxyAgent(`http://${credentials}${authority}`), proxy };
  }
}

/** Installs the proxy-aware WebSocket as the global used by Trystero. */
export function installProxyAwareWebSocket(options: ProxyWebSocketRuntimeOptions = {}): void {
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
