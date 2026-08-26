/**
 * TURN endpoint configuration, validation and live reachability probing.
 *
 * Why this module exists:
 *
 * Trystero 0.25.x accepts `turnConfig` and appends it after its default STUN
 * servers. However the werift ICE stack that Pair Notebook uses as its
 * RTC polyfill picks only the FIRST `turn:`/`turns:` URL from the resulting
 * `iceServers` list (see `parseIceServers` in werift) and resolves a single
 * transport for it. A naive list of UDP+TCP+TLS URLs therefore silently
 * degrades to "TURN over whatever transport appears first".
 *
 * This module models TURN endpoints explicitly with an ordered transport
 * preference (UDP -> TCP -> TLS), validates URLs, and probes each endpoint
 * with a real TURN Allocate round trip using werift's own TURN client so
 * every machine can put a working transport first without weakening the
 * direct-connection-first behaviour of ICE.
 */

export type TurnTransport = 'udp' | 'tcp' | 'tls';

export interface TurnEndpoint {
  /** Canonical URL, e.g. `turn:host:3478?transport=tcp` or `turns:host:443`. */
  url: string;
  host: string;
  port: number;
  transport: TurnTransport;
}

/** Result of one live TURN Allocate probe. Safe to surface in diagnostics. */
export interface TurnProbeResult {
  endpoint: TurnEndpoint;
  ok: boolean;
  /** Milliseconds until Allocate succeeded, when `ok`. */
  latencyMs?: number;
  error?: string;
}

const TRANSPORT_PRIORITY: Record<TurnTransport, number> = { udp: 0, tcp: 1, tls: 2 };

/**
 * There is no built-in TURN service. The former anonymous Metered demo no
 * longer resolves publicly and must not be advertised as a working fallback.
 * Keep this empty export for source compatibility; production endpoints come
 * only from the explicit `pairNotebook.turnUrls` setting.
 */
export const DEFAULT_TURN_URLS: readonly string[] = [];

/**
 * Parses and normalizes a single TURN URL. Rejects anything that is not a
 * syntactically valid turn:/turns: endpoint with udp/tcp/tls semantics.
 */
export function parseTurnEndpoint(rawUrl: string): TurnEndpoint | undefined {
  const trimmed = rawUrl.trim();
  const match = /^(turn|turns):(\/\/)?([^/?#]+)(\?.*)?$/i.exec(trimmed);
  if (!match) return undefined;
  const rawScheme = match[1];
  let hostPort = match[3];
  if (!rawScheme || hostPort === undefined) return undefined;
  const scheme = rawScheme.toLowerCase() as 'turn' | 'turns';
  // Strip IPv6 brackets for the host value while keeping the canonical form.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  let port: number;
  let host: string;
  const bracketedHost = bracketed?.[1];
  const bracketedPort = bracketed?.[2];
  if (bracketed && bracketedHost !== undefined) {
    host = `[${bracketedHost}]`;
    if (bracketedPort === undefined) {
      port = DEFAULT_TURN_PORTS[scheme];
    } else {
      port = Number(bracketedPort);
    }
    hostPort = `[${bracketedHost}]${bracketedPort !== undefined ? `:${bracketedPort}` : ''}`;
  } else {
    // A trailing ":digits" is an explicit port; any other colon suffix
    // (e.g. "host:notaport") makes the URL invalid rather than falling back
    // to the default port with a corrupted host.
    const colonSplit = /^(.+):(\d+)$/.exec(hostPort);
    const colonHost = colonSplit?.[1];
    const colonPort = colonSplit?.[2];
    if (colonSplit && colonHost !== undefined && colonPort !== undefined) {
      host = colonHost;
      port = Number(colonPort);
    } else if (hostPort.includes(':')) {
      return undefined;
    } else {
      host = hostPort;
      port = DEFAULT_TURN_PORTS[scheme];
    }
  }
  const query = new URLSearchParams(match[4] ?? '');
  const transportParam = query.get('transport');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (transportParam !== null && !['udp', 'tcp'].includes(transportParam.toLowerCase())) return undefined;
  if (!host) return undefined;
  let transport: TurnTransport;
  if (scheme === 'turns') {
    // RFC 7065/7064 semantics used by werift: turns is TLS; the only legal
    // query form `?transport=tcp` still resolves to TLS.
    transport = 'tls';
  } else {
    transport = (transportParam?.toLowerCase() as TurnTransport | null) ?? 'udp';
  }
  const canonicalQuery = scheme === 'turn' && transport !== 'udp' ? `?transport=${transport}` : '';
  return { url: `${scheme}:${host}:${port}${canonicalQuery}`, host, port, transport };
}


/** Parses a user-supplied URL list, dropping invalid and duplicate entries. */
export function parseTurnEndpoints(urls: readonly string[]): TurnEndpoint[] {
  const seen = new Set<string>();
  const endpoints: TurnEndpoint[] = [];
  for (const url of urls) {
    const parsed = parseTurnEndpoint(url);
    if (!parsed || seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    endpoints.push(parsed);
  }
  return endpoints;
}

const DEFAULT_TURN_PORTS: Record<'turn' | 'turns', number> = { turn: 3478, turns: 5349 };

/** Stable sort into the preferred fallback order: UDP, then TCP, then TLS. */
export function orderTurnEndpoints(endpoints: readonly TurnEndpoint[]): TurnEndpoint[] {
  return [...endpoints].sort((a, b) =>
    TRANSPORT_PRIORITY[a.transport] - TRANSPORT_PRIORITY[b.transport]
    || a.host.localeCompare(b.host)
    || a.port - b.port);
}

export interface ProbeTurnOptions {
  timeoutMs?: number;
  username?: string;
  password?: string;
  /** Injectable probe implementation; tests replace this with a fake. */
  allocate?: (
    endpoint: TurnEndpoint,
    options: Pick<ProbeTurnOptions, 'timeoutMs' | 'username' | 'password'>,
  ) => Promise<number>;
}

const defaultAllocateTimeoutMs = 4_000;

async function defaultAllocate(
  endpoint: TurnEndpoint,
  options: Pick<ProbeTurnOptions, 'timeoutMs' | 'username' | 'password'>,
): Promise<number> {
  // Imported lazily so pure-logic unit tests never load werift.
  const { createTurnClient } = await import('werift');
  const startedAt = Date.now();
  const client = await createTurnClient(
    { address: [endpoint.host, endpoint.port], username: options.username ?? '', password: options.password ?? '' },
    { transport: endpoint.transport, lifetime: 600 },
  );
  try {
    await client.connectionMade();
    if (!client.relayedAddress) throw new Error('TURN Allocate returned no relayed address');
    return Date.now() - startedAt;
  } finally {
    try { await client.close(); } catch { /* best-effort cleanup */ }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/** Probes every endpoint in parallel, each bounded by the shared timeout. */
export async function probeTurnEndpoints(
  endpoints: readonly TurnEndpoint[],
  options: ProbeTurnOptions = {},
): Promise<TurnProbeResult[]> {
  const timeoutMs = options.timeoutMs ?? defaultAllocateTimeoutMs;
  return Promise.all(endpoints.map(async (endpoint): Promise<TurnProbeResult> => {
    try {
      const latencyMs = await withTimeout(
        (options.allocate ?? defaultAllocate)(endpoint, { ...options }),
        timeoutMs,
        `TURN ${endpoint.transport.toUpperCase()} ${endpoint.host}:${endpoint.port}`,
      );
      return { endpoint, ok: true, latencyMs };
    } catch (error) {
      return { endpoint, ok: false, error: sanitizeErrorText(error instanceof Error ? error.message : String(error)) };
    }
  }));
}

export interface TurnSelection {
  /** Endpoints ordered so locally reachable transports come first. */
  ordered: TurnEndpoint[];
  probes: TurnProbeResult[];
}

/**
 * Chooses the final endpoint ordering: among locally reachable endpoints,
 * transport-class priority wins (UDP before TCP before TLS, matching the
 * documented fallback architecture) and measured Allocate latency breaks
 * ties within a class. Unreachable endpoints keep their configured relative
 * order at the end so ICE can still attempt them if everything else failed.
 */
export function selectTurnEndpoints(
  endpoints: readonly TurnEndpoint[],
  probes: readonly TurnProbeResult[],
): TurnSelection {
  const probeByUrl = new Map(probes.map((probe) => [probe.endpoint.url, probe]));
  const reachable = orderTurnEndpoints(endpoints.filter((endpoint) => probeByUrl.get(endpoint.url)?.ok));
  const unreachable = endpoints.filter((endpoint) => !probeByUrl.get(endpoint.url)?.ok);
  const orderedReachable = [...reachable].sort((a, b) =>
    TRANSPORT_PRIORITY[a.transport] === TRANSPORT_PRIORITY[b.transport]
      ? (probeByUrl.get(a.url)?.latencyMs ?? Infinity) - (probeByUrl.get(b.url)?.latencyMs ?? Infinity)
      : 0);
  const ordered = [...orderedReachable, ...unreachable];
  return { ordered: ordered.length > 0 ? ordered : orderTurnEndpoints(endpoints), probes: [...probes] };
}

/** Defence in depth: strips anything credential-like from surfaced errors. */
function sanitizeErrorText(text: string): string {
  return text.replace(/\/\/[^@/\s]+@/g, '//').replace(/\b(secret|password|credential)=\S+/gi, '$1=[redacted]');
}


