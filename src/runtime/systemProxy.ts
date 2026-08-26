import { execFile } from 'node:child_process';
import path from 'node:path';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const MAX_REGISTRY_OUTPUT_BYTES = 64 * 1024;

export interface SystemProxyConfiguration {
  proxyUrl?: string | undefined;
  noProxy?: string | undefined;
  autoConfigUrl?: string | undefined;
}

export interface ReadSystemProxyOptions {
  platform?: NodeJS.Platform | undefined;
  queryRegistry?: (() => Promise<string>) | undefined;
}

function normalizeProxyEndpoint(value: string, kind: 'http' | 'socks5'): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `${kind}://${trimmed}`;
}

/** Parses WinINet's `ProxyServer` value, including per-protocol assignments. */
export function proxyUrlFromWindowsValue(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;
  if (!value.includes('=')) return normalizeProxyEndpoint(value, 'http');

  const entries = new Map<string, string>();
  for (const assignment of value.split(';')) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    entries.set(assignment.slice(0, separator).trim().toLowerCase(), assignment.slice(separator + 1).trim());
  }
  // Pair Notebook's signalling and fallback endpoints are WSS. A Windows
  // `https=` entry names the proxy for HTTPS targets, not necessarily an
  // HTTPS connection to the proxy itself, so a bare endpoint is HTTP CONNECT.
  for (const key of ['https', 'http']) {
    const endpoint = entries.get(key);
    if (endpoint) return normalizeProxyEndpoint(endpoint, 'http');
  }
  for (const key of ['socks', 'socks5']) {
    const endpoint = entries.get(key);
    if (endpoint) return normalizeProxyEndpoint(endpoint, 'socks5');
  }
  return undefined;
}

/** Parses the stable values printed by `reg.exe query ... Internet Settings`. */
export function parseWindowsSystemProxyOutput(output: string): SystemProxyConfiguration | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_\w+\s+(.*?)\s*$/i.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1].toLowerCase(), match[2]);
  }
  const enabledValue = values.get('proxyenable');
  const enabled = enabledValue !== undefined && Number(enabledValue) !== 0;
  const proxyUrl = enabled ? proxyUrlFromWindowsValue(values.get('proxyserver') ?? '') : undefined;
  const proxyOverride = values.get('proxyoverride')?.replace(/;/g, ',').trim() || undefined;
  const autoConfigUrl = values.get('autoconfigurl')?.trim() || undefined;
  if (!proxyUrl && !autoConfigUrl) return undefined;
  return {
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(proxyOverride ? { noProxy: proxyOverride } : {}),
    ...(autoConfigUrl ? { autoConfigUrl } : {}),
  };
}

function queryWindowsInternetSettings(): Promise<string> {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(windowsRoot, 'System32', 'reg.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: MAX_REGISTRY_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Reads the current user's WinINet proxy without elevation or mutation. */
export async function readWindowsSystemProxy(
  options: ReadSystemProxyOptions = {},
): Promise<SystemProxyConfiguration | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  try {
    return parseWindowsSystemProxyOutput(await (options.queryRegistry ?? queryWindowsInternetSettings)());
  } catch {
    // System proxy discovery is opportunistic. Explicit settings and
    // environment variables remain usable when the registry is unavailable.
    return undefined;
  }
}
