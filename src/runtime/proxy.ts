/**
 * Proxy resolution for Pair Notebook's signalling WebSockets and relayed
 * HTTPS traffic.
 *
 * Node's `ws` package (used by Trystero through the WebSocket global) does
 * NOT follow the Windows system proxy, VS Code's `http.proxy` setting, or
 * the standard proxy environment variables. On proxy-only networks that
 * made discovery fail even when a perfectly good proxy was available.
 *
 * This module resolves an explicit proxy descriptor from, in priority order:
 *   1. Pair Notebook `proxyUrl`
 *   2. VS Code `http.proxy` (when `http.proxySupport` is not "off")
 *   3. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
 *   4. the Windows system proxy
 * honouring `NO_PROXY`/`no_proxy` exclusions. HTTP(S) CONNECT proxies,
 * authenticated proxies (userinfo), SOCKS5 and SOCKS4 URLs are supported.
 *
 * Proxy credentials are never included in diagnostics or logs; use
 * `describeProxy`/`redactProxyUrl` whenever a value is displayed.
 */

import { URL } from 'node:url';

export type ProxyKind = 'http' | 'https' | 'socks5' | 'socks5h' | 'socks4';

export interface ProxyDescriptor {
  kind: ProxyKind;
  host: string;
  port: number;
  /** Credentials stay out of any string representation of this object. */
  username?: string;
  password?: string;
}

export interface ProxyResolutionInput {
  explicitProxy?: string | undefined;
  vscodeProxy?: string | undefined;
  vscodeProxySupport?: string | undefined;
  vscodeNoProxy?: readonly string[] | undefined;
  systemProxy?: string | undefined;
  systemNoProxy?: string | undefined;
  env?: Record<string, string | undefined>;
}

/** Removes userinfo from a proxy URL before it can reach a log or report. */
export function redactProxyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!url.username && !url.password) return rawUrl;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return rawUrl.replace(/\/\/[^@/]*@/, '//');
  }
}

export function parseProxyUrl(rawUrl: string): ProxyDescriptor | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  let kind: ProxyKind | undefined;
  if (scheme === 'http' || scheme === 'https') kind = scheme;
  else if (scheme === 'socks5') kind = 'socks5';
  else if (scheme === 'socks5h') kind = 'socks5h';
  else if (scheme === 'socks4' || scheme === 'socks4a') kind = 'socks4';
  if (!kind) return undefined;
  const port = url.port ? Number(url.port)
    : kind === 'http' ? 80
      : kind === 'https' ? 443
        : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = url.hostname;
  if (!host) return undefined;
  return {
    kind,
    host,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

function hostMatchesPattern(host: string, port: string, pattern: string): boolean {
  let clean = pattern.trim().toLowerCase();
  if (!clean) return false;
  if (clean === '*') return true;
  if (clean === '<local>') return !host.includes('.');
  if (clean.includes('://')) {
    try {
      const parsed = new URL(clean);
      clean = parsed.hostname + (parsed.port ? `:${parsed.port}` : '');
    } catch {
      return false;
    }
  }
  let patternHost = clean;
  let patternPort = '';
  if (clean.startsWith('[')) {
    const closingBracket = clean.indexOf(']');
    if (closingBracket < 0) return false;
    patternHost = clean.slice(1, closingBracket);
    if (clean[closingBracket + 1] === ':') patternPort = clean.slice(closingBracket + 2);
  } else if (clean.indexOf(':') === clean.lastIndexOf(':')) {
    const colon = clean.lastIndexOf(':');
    if (colon > 0) {
      patternHost = clean.slice(0, colon);
      patternPort = clean.slice(colon + 1);
    }
  }
  if (patternPort && patternPort !== port) return false;
  patternHost = patternHost.replace(/^\*?\./, '');
  if (!patternHost) return false;
  if (patternHost.includes('*')) {
    const wildcard = patternHost
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${wildcard}$`).test(host);
  }
  if (host === patternHost) return true;
  // A suffix entry like "example.com" also covers subdomains per NO_PROXY
  // convention; require a dot boundary so "notexample.com" never matches.
  return host.endsWith(`.${patternHost}`);
}

export function isHostExcluded(host: string, noProxy: string | undefined, port = ''): boolean {
  if (!noProxy) return false;
  const normalizedHost = host.toLowerCase();
  return noProxy.split(/[,;]/).some((pattern) => hostMatchesPattern(normalizedHost, port, pattern));
}

/**
 * Resolves the proxy to use for the given target URL (ws:// or wss://).
 * Secure targets prefer HTTPS_PROXY; plain targets accept HTTP_PROXY too.
 */
export function resolveProxy(
  targetUrl: string,
  input: ProxyResolutionInput = {},
): ProxyDescriptor | undefined {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const env = input.env ?? process.env as Record<string, string | undefined>;
  const targetPort = target.port || ((target.protocol === 'wss:' || target.protocol === 'https:') ? '443' : '80');
  const noProxy = [
    env.NO_PROXY ?? env.no_proxy,
    input.vscodeNoProxy?.join(','),
    input.systemNoProxy,
  ].filter((value): value is string => Boolean(value?.trim())).join(',');
  if (isHostExcluded(target.hostname, noProxy, targetPort)) return undefined;

  const candidates: string[] = [];
  const vscodeSupportOff = input.vscodeProxySupport === 'off';
  if (input.explicitProxy) candidates.push(input.explicitProxy);
  if (input.vscodeProxy && !vscodeSupportOff) candidates.push(input.vscodeProxy);
  if (target.protocol === 'wss:' || target.protocol === 'https:') {
    for (const key of ['HTTPS_PROXY', 'https_proxy']) if (env[key]?.trim()) candidates.push(env[key]!.trim());
    // Many local VPN clients expose one HTTP CONNECT endpoint and set only
    // HTTP_PROXY. CONNECT is valid for secure targets too.
    for (const key of ['HTTP_PROXY', 'http_proxy']) if (env[key]?.trim()) candidates.push(env[key]!.trim());
  } else {
    for (const key of ['HTTP_PROXY', 'http_proxy']) if (env[key]?.trim()) candidates.push(env[key]!.trim());
  }
  for (const key of ['ALL_PROXY', 'all_proxy']) if (env[key]?.trim()) candidates.push(env[key]!.trim());
  if (input.systemProxy) candidates.push(input.systemProxy);

  for (const candidate of candidates) {
    const parsed = parseProxyUrl(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Human-readable, credential-free description used by diagnostics. */
export function describeProxy(proxy: ProxyDescriptor | undefined): string {
  if (!proxy) return 'Direct';
  const auth = proxy.username ? 'authenticated ' : '';
  switch (proxy.kind) {
    case 'socks5': return `${auth}SOCKS5 ${proxy.host}:${proxy.port}`;
    case 'socks5h': return `${auth}SOCKS5 (remote DNS) ${proxy.host}:${proxy.port}`;
    case 'socks4': return `${auth}SOCKS4 ${proxy.host}:${proxy.port}`;
    case 'https': return `${auth}HTTPS CONNECT ${proxy.host}:${proxy.port}`;
    default: return `${auth}HTTP CONNECT ${proxy.host}:${proxy.port}`;
  }
}
