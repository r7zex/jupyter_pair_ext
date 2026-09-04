import assert from 'node:assert/strict';

describe('bounded lifecycle diagnostics', () => {
  function api(): any {
    // Runtime require keeps this regression executable before the implementation module exists.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/runtime/lifecycleDiagnostics');
  }

  it('keeps one opaque correlation id per recovery cycle and rotates it for the next cycle', () => {
    const { LifecycleDiagnosticRing } = api();
    const ring = new LifecycleDiagnosticRing('session-secret-value', 'local-peer');
    const first = ring.beginRecovery('remote-peer', 'direct', 'route-lost');
    ring.record('recovery-started', { correlationId: first, remotePeerId: 'remote-peer', connectionState: 'recovering', routeKind: 'direct', reason: 'route-lost' });
    ring.record('route-replaced', { correlationId: first, remotePeerId: 'remote-peer', connectionState: 'connected', routeKind: 'relay', reason: 'replacement-authenticated' });
    ring.record('recovery-succeeded', { correlationId: first, remotePeerId: 'remote-peer', connectionState: 'connected', routeKind: 'relay', reason: 'replacement-authenticated' });
    ring.endRecovery('remote-peer', first);
    const second = ring.beginRecovery('remote-peer', 'relay', 'route-lost');
    assert.match(first, /^diag_[A-Za-z0-9_-]+$/);
    assert.notEqual(first, second);
    assert.equal(ring.snapshot().slice(0, 4).every((event: any) => event.correlationId === first), true);
    assert.equal(ring.snapshot().at(-1)?.correlationId, second);
  });

  it('is fixed-size, evicts oldest first, and snapshot reads do not mutate the ring', () => {
    const { LifecycleDiagnosticRing, MAX_LIFECYCLE_DIAGNOSTIC_EVENTS } = api();
    const ring = new LifecycleDiagnosticRing('session-a', 'local-peer');
    for (let i = 0; i < MAX_LIFECYCLE_DIAGNOSTIC_EVENTS + 7; i += 1) {
      ring.record('reconnect-started', { correlationId: ring.newCorrelationId(), connectionState: 'reconnecting', routeKind: 'signalling', reason: 'manual-reconnect', metadata: { attempt: i } });
    }
    const before = ring.snapshot();
    assert.equal(before.length, MAX_LIFECYCLE_DIAGNOSTIC_EVENTS);
    assert.equal(before[0]?.metadata?.attempt, 7);
    const copy = ring.snapshot();
    copy[0]!.metadata!.attempt = 999999;
    assert.equal(ring.snapshot()[0]?.metadata?.attempt, 7);
  });

  it('drops secret-shaped arbitrary fields and never exposes token, proxy credentials, SDP, or notebook code', () => {
    const { LifecycleDiagnosticRing, formatLifecycleDiagnostics } = api();
    const token = 'invite-token-super-secret';
    const key = 'encryption-key-super-secret';
    const password = 'proxy-password-super-secret';
    const sdp = 'v=0\\r\\na=ice-pwd:secret';
    const code = 'print("secret notebook code")';
    const ring = new LifecycleDiagnosticRing('session-secret-value', 'local-peer');
    const correlationId = ring.newCorrelationId();
    ring.record('execution-request-created', {
      correlationId,
      remotePeerId: 'remote-peer', connectionState: 'executing', routeKind: 'direct', reason: 'execution-request',
      metadata: {
        requestId: 'request-1', cellId: 'cell-1', revision: 'rev-1', digest: 'a'.repeat(64), computeEpoch: 3,
        token, encryptionKey: key, proxyPassword: password, sdp, code,
      } as any,
    });
    const text = formatLifecycleDiagnostics(ring.snapshot());
    for (const secret of [token, key, password, sdp, code, 'session-secret-value']) assert.equal(text.includes(secret), false);
    assert.match(text, /session-[a-f0-9]{16}/);
    assert.match(text, /correlation=diag_/);
    assert.match(text, /digest=/);
  });

  it('preserves route-loss -> recovery -> replacement order under one correlation id', () => {
    const { LifecycleDiagnosticRing } = api();
    const ring = new LifecycleDiagnosticRing('session-b', 'local-peer');
    const id = ring.beginRecovery('peer-b', 'direct', 'route-lost');
    ring.record('recovery-started', { correlationId: id, remotePeerId: 'peer-b', connectionState: 'recovering', routeKind: 'direct', reason: 'route-lost' });
    ring.record('candidate-authenticated', { correlationId: id, remotePeerId: 'peer-b', connectionState: 'recovering', routeKind: 'relay', reason: 'candidate-authenticated' });
    ring.record('route-replaced', { correlationId: id, remotePeerId: 'peer-b', connectionState: 'connected', routeKind: 'relay', reason: 'replacement-authenticated' });
    ring.record('recovery-succeeded', { correlationId: id, remotePeerId: 'peer-b', connectionState: 'connected', routeKind: 'relay', reason: 'replacement-authenticated' });
    assert.deepEqual(ring.snapshot().map((event: any) => event.eventType), ['route-lost', 'recovery-started', 'candidate-authenticated', 'route-replaced', 'recovery-succeeded']);
    assert.equal(new Set(ring.snapshot().map((event: any) => event.correlationId)).size, 1);
  });

  it('preserves route-loss -> deadline -> runtime close -> tabs close order with the same correlation id', () => {
    const { LifecycleDiagnosticRing } = api();
    const ring = new LifecycleDiagnosticRing('session-c', 'local-peer');
    const id = ring.beginRecovery('peer-c', 'direct', 'route-lost');
    ring.record('recovery-deadline', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'disconnected', routeKind: 'none', reason: 'recovery-deadline' });
    ring.record('peer-disconnected', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'disconnected', routeKind: 'none', reason: 'recovery-deadline' });
    ring.record('runtime-close-started', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'closing', routeKind: 'none', reason: 'host-unreachable' });
    ring.record('runtime-close-completed', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'closed', routeKind: 'none', reason: 'host-unreachable' });
    ring.record('pair-tabs-close-started', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'closed', routeKind: 'none', reason: 'host-unreachable' });
    ring.record('pair-tabs-close-completed', { correlationId: id, remotePeerId: 'peer-c', connectionState: 'closed', routeKind: 'none', reason: 'host-unreachable', metadata: { tabMatched: 2, tabClosed: 2, tabFailed: 0 } });
    assert.deepEqual(ring.snapshot().map((event: any) => event.eventType), ['route-lost', 'recovery-deadline', 'peer-disconnected', 'runtime-close-started', 'runtime-close-completed', 'pair-tabs-close-started', 'pair-tabs-close-completed']);
    assert.equal(new Set(ring.snapshot().map((event: any) => event.correlationId)).size, 1);
  });

  it('records execution wait/replay metadata without retaining raw code', () => {
    const { LifecycleDiagnosticRing } = api();
    const ring = new LifecycleDiagnosticRing('session-d', 'local-peer');
    const id = ring.newCorrelationId();
    const metadata = { requestId: 'req-1', cellId: 'cell-1', revision: '7:abc', digest: 'b'.repeat(64), computeEpoch: 9 };
    ring.record('execution-request-created', { correlationId: id, remotePeerId: 'peer-d', connectionState: 'executing', routeKind: 'direct', reason: 'execution-request', metadata: { ...metadata, code: 'do_not_log_me()' } as any });
    ring.record('execution-cell-state-wait', { correlationId: id, remotePeerId: 'peer-d', connectionState: 'executing', routeKind: 'direct', reason: 'cell-state-wait', metadata });
    ring.record('execution-cell-state-ready', { correlationId: id, remotePeerId: 'peer-d', connectionState: 'executing', routeKind: 'direct', reason: 'cell-state-ready', metadata });
    ring.record('execution-replayed', { correlationId: id, remotePeerId: 'peer-d', connectionState: 'executing', routeKind: 'direct', reason: 'execution-replay', metadata });
    assert.equal(JSON.stringify(ring.snapshot()).includes('do_not_log_me'), false);
    assert.deepEqual(ring.snapshot().map((event: any) => event.eventType), ['execution-request-created', 'execution-cell-state-wait', 'execution-cell-state-ready', 'execution-replayed']);
  });
});
