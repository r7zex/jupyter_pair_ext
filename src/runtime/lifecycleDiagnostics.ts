import { createHash, randomBytes } from 'node:crypto';

export const MAX_LIFECYCLE_DIAGNOSTIC_EVENTS = 256;

export type DiagnosticCorrelationId = string & { readonly __diagnosticCorrelationId: unique symbol };

export type LifecycleDiagnosticEventType =
  | 'route-lost'
  | 'half-open-detected'
  | 'recovery-started'
  | 'relay-negotiation-started'
  | 'direct-reconnect-started'
  | 'candidate-authenticated'
  | 'route-replaced'
  | 'recovery-succeeded'
  | 'recovery-deadline'
  | 'peer-disconnected'
  | 'runtime-close-started'
  | 'runtime-close-completed'
  | 'pair-tabs-close-started'
  | 'pair-tabs-close-completed'
  | 'recent-session-saved'
  | 'reconnect-started'
  | 'reconnect-succeeded'
  | 'reconnect-failed'
  | 'execution-request-created'
  | 'execution-request-sent'
  | 'execution-cell-state-wait'
  | 'execution-cell-state-ready'
  | 'execution-accepted'
  | 'execution-started'
  | 'execution-completed'
  | 'execution-replayed';

export type DiagnosticConnectionState =
  | 'connecting'
  | 'connected'
  | 'recovering'
  | 'reconnecting'
  | 'disconnected'
  | 'executing'
  | 'closing'
  | 'closed';

export type DiagnosticRouteKind = 'direct' | 'relay' | 'candidate' | 'signalling' | 'none' | 'unknown';

/**
 * Reasons are closed tokens rather than arbitrary exception text. This is a
 * deliberate sanitization boundary: credentials, SDP, invite data and code
 * cannot enter the ring through an error/message string.
 */
export type DiagnosticReason =
  | 'route-lost'
  | 'half-open'
  | 'recovery-started'
  | 'relay-fallback'
  | 'direct-reconnect'
  | 'candidate-authenticated'
  | 'replacement-authenticated'
  | 'recovery-deadline'
  | 'peer-disconnected'
  | 'host-unreachable'
  | 'local-route-failed'
  | 'explicit-leave'
  | 'session-ended'
  | 'manual-reconnect'
  | 'manual-reconnect-succeeded'
  | 'manual-reconnect-failed'
  | 'execution-request'
  | 'execution-send'
  | 'cell-state-wait'
  | 'cell-state-ready'
  | 'execution-accepted'
  | 'execution-started'
  | 'execution-completed'
  | 'execution-replay'
  | 'tab-cleanup'
  | 'recent-session-saved';

export interface LifecycleDiagnosticMetadata {
  requestId?: string | undefined;
  cellId?: string | undefined;
  revision?: string | undefined;
  digest?: string | undefined;
  computeEpoch?: number | undefined;
  attempt?: number | undefined;
  eventSequence?: number | undefined;
  tabMatched?: number | undefined;
  tabClosed?: number | undefined;
  tabFailed?: number | undefined;
  routeFrom?: string | undefined;
  routeTo?: string | undefined;
  result?: string | undefined;
  status?: string | undefined;
}

export interface LifecycleDiagnosticEvent {
  timestamp: number;
  correlationId: DiagnosticCorrelationId;
  /** One-way session fingerprint; never the raw session id or invite token. */
  sessionIdentifier: string;
  localPeerId: string;
  remotePeerId?: string | undefined;
  eventType: LifecycleDiagnosticEventType;
  connectionState: DiagnosticConnectionState;
  routeKind: DiagnosticRouteKind;
  reason: DiagnosticReason;
  metadata?: LifecycleDiagnosticMetadata | undefined;
}

export interface RecordLifecycleDiagnosticOptions {
  correlationId: DiagnosticCorrelationId;
  remotePeerId?: string | undefined;
  connectionState: DiagnosticConnectionState;
  routeKind: DiagnosticRouteKind;
  reason: DiagnosticReason;
  metadata?: LifecycleDiagnosticMetadata | Record<string, unknown> | undefined;
}

export function newDiagnosticCorrelationId(): DiagnosticCorrelationId {
  // Independent CSPRNG bytes: no session token, encryption key or peer secret participates.
  return `diag_${randomBytes(18).toString('base64url')}` as DiagnosticCorrelationId;
}

export function isDiagnosticCorrelationId(value: unknown): value is DiagnosticCorrelationId {
  return typeof value === 'string' && /^diag_[A-Za-z0-9_-]{20,80}$/.test(value);
}

export class LifecycleDiagnosticRing {
  private readonly events: LifecycleDiagnosticEvent[] = [];
  private readonly recoveryCorrelations = new Map<string, DiagnosticCorrelationId>();
  private readonly sessionIdentifier: string;
  private lastTimestamp = 0;

  public constructor(sessionId: string, private readonly localPeerId: string) {
    this.sessionIdentifier = sanitizeSessionIdentifier(sessionId);
  }

  public newCorrelationId(): DiagnosticCorrelationId {
    return newDiagnosticCorrelationId();
  }

  public beginRecovery(
    remotePeerId: string,
    routeKind: DiagnosticRouteKind,
    reason: DiagnosticReason = 'route-lost',
    trigger: 'route-lost' | 'half-open-detected' = 'route-lost',
  ): DiagnosticCorrelationId {
    const existing = this.recoveryCorrelations.get(remotePeerId);
    if (existing) return existing;
    const correlationId = this.newCorrelationId();
    this.recoveryCorrelations.set(remotePeerId, correlationId);
    if (trigger === 'half-open-detected') {
      this.record('half-open-detected', {
        correlationId, remotePeerId, connectionState: 'recovering', routeKind, reason: 'half-open',
      });
    }
    this.record('route-lost', {
      correlationId, remotePeerId, connectionState: 'recovering', routeKind, reason,
    });
    return correlationId;
  }

  public correlationForPeer(remotePeerId: string): DiagnosticCorrelationId | undefined {
    return this.recoveryCorrelations.get(remotePeerId);
  }

  public endRecovery(remotePeerId: string, correlationId: DiagnosticCorrelationId): void {
    if (this.recoveryCorrelations.get(remotePeerId) === correlationId) {
      this.recoveryCorrelations.delete(remotePeerId);
    }
  }

  public record(eventType: LifecycleDiagnosticEventType, options: RecordLifecycleDiagnosticOptions): void {
    const now = Date.now();
    const timestamp = Math.max(now, this.lastTimestamp);
    this.lastTimestamp = timestamp;
    const metadata = sanitizeDiagnosticMetadata(options.metadata);
    this.events.push({
      timestamp,
      correlationId: options.correlationId,
      sessionIdentifier: this.sessionIdentifier,
      localPeerId: this.localPeerId,
      ...(safePeerId(options.remotePeerId) ? { remotePeerId: options.remotePeerId } : {}),
      eventType,
      connectionState: options.connectionState,
      routeKind: options.routeKind,
      reason: options.reason,
      ...(metadata ? { metadata } : {}),
    });
    if (this.events.length > MAX_LIFECYCLE_DIAGNOSTIC_EVENTS) {
      this.events.splice(0, this.events.length - MAX_LIFECYCLE_DIAGNOSTIC_EVENTS);
    }
  }

  /**
   * Runtime disposal deliberately does not clear this ring. The extension may
   * append tab-close / Recent Sessions evidence after SessionRuntime teardown;
   * retention remains bounded by MAX_LIFECYCLE_DIAGNOSTIC_EVENTS and by the
   * lifetime of the detached runtime object/snapshot.
   */
  public snapshot(): LifecycleDiagnosticEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
    }));
  }
}

export function sanitizeSessionIdentifier(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16)}`;
}

export function formatLifecycleDiagnostics(events: readonly LifecycleDiagnosticEvent[]): string {
  return events.map((event) => {
    const meta = event.metadata
      ? Object.entries(event.metadata).map(([key, value]) => `${key}=${String(value)}`).join(' ')
      : '';
    return [
      new Date(event.timestamp).toISOString(),
      `correlation=${event.correlationId}`,
      `session=${event.sessionIdentifier}`,
      `local=${event.localPeerId}`,
      ...(event.remotePeerId ? [`remote=${event.remotePeerId}`] : []),
      `event=${event.eventType}`,
      `state=${event.connectionState}`,
      `route=${event.routeKind}`,
      `reason=${event.reason}`,
      ...(meta ? [meta] : []),
    ].join(' ');
  }).join('\n');
}

function sanitizeDiagnosticMetadata(value: unknown): LifecycleDiagnosticMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: LifecycleDiagnosticMetadata = {};
  for (const key of ['requestId', 'cellId', 'revision', 'digest', 'routeFrom', 'routeTo', 'result', 'status'] as const) {
    const cleaned = safeDiagnosticString(raw[key]);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  for (const key of ['computeEpoch', 'attempt', 'eventSequence', 'tabMatched', 'tabClosed', 'tabFailed'] as const) {
    const numeric = raw[key];
    if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0) result[key] = numeric;
  }
  return Object.keys(result).length ? result : undefined;
}

function safeDiagnosticString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function safePeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n]/.test(value);
}
