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

export interface BoundProxyPassword {
  binding: string;
  password: string;
}

export interface ExplicitProxyUrlDetails {
  /** Password-free URL safe to keep in VS Code settings. */
  proxyUrl: string;
  /** Stable endpoint + username identity used to bind SecretStorage data. */
  binding: string;
  /** True when the supplied setting contained a non-empty password. */
  passwordPresent: boolean;
  /** Present only when the supplied URL embedded a non-empty password. */
  password?: string | undefined;
}

export interface ExplicitProxyPasswordInspection {
  /** Password-free replacement, or an empty string when an invalid URL must be cleared. */
  passwordFreeUrl: string;
  passwordPresent: boolean;
  /** Omitted when the embedded password has malformed percent encoding. */
  password?: string | undefined;
}

export interface ProxyResolutionInput {
  explicitProxy?: string | undefined;
  /** SecretStorage credential, accepted only for its exact explicit proxy binding. */
  explicitProxyPassword?: BoundProxyPassword | undefined;
  vscodeProxy?: string | undefined;
  vscodeProxySupport?: string | undefined;
  vscodeNoProxy?: readonly string[] | undefined;
  systemProxy?: string | undefined;
  systemNoProxy?: string | undefined;
  env?: Record<string, string | undefined>;
}

export const EXPLICIT_PROXY_PASSWORD_ERROR =
  'pairNotebook.proxyUrl must not contain a password. Remove it and run Pair Notebook: Set Proxy Password.';

function hasExplicitProxyPasswordShape(rawUrl: string): boolean {
  const withoutPrefix = rawUrl
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/+/, '')
    .replace(/^\/+/, '');
  const at = withoutPrefix.lastIndexOf('@');
  if (at < 0) return false;
  const userInfo = withoutPrefix.slice(0, at);
  const separator = userInfo.lastIndexOf(':');
  return separator >= 0 && separator < userInfo.length - 1;
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
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    return undefined;
  }
  return {
    kind,
    host,
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** Stable non-secret identity for one explicit proxy endpoint and username. */
export function proxyCredentialBinding(proxy: ProxyDescriptor): string {
  return JSON.stringify([
    proxy.kind,
    proxy.host.toLowerCase(),
    proxy.port,
    proxy.username ?? '',
  ]);
}

/** Detects and removes embedded passwords independently from proxy support. */
export function inspectExplicitProxyPassword(
  rawUrl: string,
): ExplicitProxyPasswordInspection | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  const passwordShape = hasExplicitProxyPasswordShape(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return passwordShape
      ? { passwordFreeUrl: '', passwordPresent: true }
      : undefined;
  }
  if (!url.password) {
    if (passwordShape) return { passwordFreeUrl: '', passwordPresent: true };
    return { passwordFreeUrl: url.toString(), passwordPresent: false };
  }
  let password: string | undefined;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    // The setting must still be sanitized even when the secret cannot be decoded.
  }
  url.password = '';
  return {
    passwordFreeUrl: url.toString(),
    passwordPresent: true,
    ...(password !== undefined ? { password } : {}),
  };
}

/** Parses an explicit setting and returns the exact password-free replacement. */
export function inspectExplicitProxyUrl(rawUrl: string): ExplicitProxyUrlDetails | undefined {
  const credential = inspectExplicitProxyPassword(rawUrl);
  if (!credential) return undefined;
  const descriptor = parseProxyUrl(credential.passwordFreeUrl);
  if (!descriptor) return undefined;
  return {
    proxyUrl: credential.passwordFreeUrl,
    binding: proxyCredentialBinding(descriptor),
    passwordPresent: credential.passwordPresent,
    ...(credential.password !== undefined ? { password: credential.password } : {}),
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

  if (input.explicitProxy) {
    const credential = inspectExplicitProxyPassword(input.explicitProxy);
    if (credential?.passwordPresent) throw new Error(EXPLICIT_PROXY_PASSWORD_ERROR);
    const explicit = parseProxyUrl(input.explicitProxy);
    if (explicit) {
      const secret = input.explicitProxyPassword;
      if (secret && secret.binding === proxyCredentialBinding(explicit)) {
        return { ...explicit, password: secret.password };
      }
      return explicit;
    }
  }

  const candidates: string[] = [];
  const vscodeSupportOff = input.vscodeProxySupport === 'off';
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
  const auth = proxy.username !== undefined || proxy.password !== undefined ? 'authenticated ' : '';
  switch (proxy.kind) {
    case 'socks5': return `${auth}SOCKS5 ${proxy.host}:${proxy.port}`;
    case 'socks5h': return `${auth}SOCKS5 (remote DNS) ${proxy.host}:${proxy.port}`;
    case 'socks4': return `${auth}SOCKS4 ${proxy.host}:${proxy.port}`;
    case 'https': return `${auth}HTTPS CONNECT ${proxy.host}:${proxy.port}`;
    default: return `${auth}HTTP CONNECT ${proxy.host}:${proxy.port}`;
  }
}
