import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  assessUdpAvailability,
  buildNetworkDiagnostics,
  classifyAdapters,
  type AdapterObservation,
} from '../src/runtime/diagnostics';
import { inspectExplicitProxyUrl } from '../src/runtime/proxy';
import type { TurnProbeResult, TurnTransport } from '../src/runtime/turn';

function probe(transport: TurnTransport, ok: boolean): TurnProbeResult {
  return {
    endpoint: { url: `turn:x.example.com:${transport}`, host: 'x.example.com', port: 3478, transport },
    ok,
    ...(ok ? { latencyMs: 50 } : { error: 'blocked' }),
  };
}

describe('passive diagnostics', () => {
  it('classifies UDP availability from TURN probes with calibrated confidence', () => {
    const udpBlocked = assessUdpAvailability([probe('udp', false), probe('tcp', true), probe('tls', true)]);
    assert.equal(udpBlocked.state, 'unavailable');
    assert.equal(udpBlocked.confidence, 'high');

    const everythingDown = assessUdpAvailability([probe('udp', false), probe('tls', false)]);
    assert.equal(everythingDown.state, 'unknown');
    assert.equal(everythingDown.confidence, 'low', 'must not infer UDP blocking when nothing works');

    const udpFine = assessUdpAvailability([probe('udp', true)]);
    assert.equal(udpFine.state, 'available');

    const unknown = assessUdpAvailability([]);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.confidence, 'low');
  });

  it('detects VPN/TUN adapters by name without privileged APIs', () => {
    const adapters = classifyAdapters({
      'Ethernet': [{ address: '192.168.1.10', family: 'IPv4', internal: false } as never],
      'WireGuard Tunnel': [{ address: '10.8.0.2', family: 'IPv4', internal: false } as never],
      'Loopback Pseudo-Interface': [],
    });
    const vpn = adapters.find((adapter) => adapter.name === 'WireGuard Tunnel');
    assert.equal(vpn?.kind, 'vpn-tun');
    assert.equal(vpn?.hasIp, true);
    assert.equal(adapters.find((adapter) => adapter.name === 'Ethernet')?.kind, 'physical');
  });

  it('labels speculation correctly and never leaks proxy credentials', async () => {
    const adapters: AdapterObservation[] = [
      { name: 'TAP-Windows Adapter V9', kind: 'vpn-tun', hasIp: true },
      { name: 'Ethernet', kind: 'physical', hasIp: true },
    ];
    const explicitProxy = inspectExplicitProxyUrl('http://alice@proxy.corp.example:8080')!;
    const report = await buildNetworkDiagnostics({
      turnProbes: [probe('udp', false), probe('tls', true)],
      adapters,
      proxyOptions: {
        explicitProxy: explicitProxy.proxyUrl,
        explicitProxyPassword: { binding: explicitProxy.binding, password: 'sup3r-s3cret' },
        env: { HTTPS_PROXY: 'http://fallback:external-secret@fallback.example:8080' },
      },
      relayFallbackEnabled: true,
      connectedRelayCount: 0,
    });

    // VPN presence is a MEDIUM-confidence possible contributor, never proof.
    const vpnObservation = report.observations.find((item) => item.observation.includes('VPN/TUN'));
    assert.ok(vpnObservation);
    assert.equal(vpnObservation.confidence, 'medium');

    // UDP conclusion is high confidence because TCP/TLS succeeded.
    const udpObservation = report.observations.find((item) => item.observation.includes('UDP TURN probes'));
    assert.ok(udpObservation);
    assert.equal(udpObservation.confidence, 'high');
    assert.ok(udpObservation.possibleCauses?.includes('Packet-filter configuration'));

    // Proxy is described but its credentials must never appear.
    assert.ok(report.proxy.includes('proxy.corp.example:8080'));
    assert.ok(!report.proxy.toLowerCase().includes('alice'));
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('sup3r-s3cret'));
    assert.ok(!serialized.includes('external-secret'));

    // zapret/Flowseal is never named as a confirmed blocker anywhere.
    for (const observation of report.observations) {
      assert.ok(!/zapret|flowseal/i.test(observation.observation),
        'filtering software must not be claimed without direct evidence');
    }
  });

  it('reports DNS failures only when an injected resolver actually fails', async () => {
    const report = await buildNetworkDiagnostics({
      resolveDns: async (host) => {
        if (host === 'nostr.data.haus') throw new Error('ENOTFOUND');
        return { address: '1.2.3.4' };
      },
      dnsHosts: ['nos.lol', 'nostr.data.haus'],
    });
    assert.deepEqual(report.dnsFailures, ['nostr.data.haus']);
    const dnsObservation = report.observations.find((item) => item.observation.includes('DNS resolution failed'));
    assert.ok(dnsObservation);
    assert.equal(dnsObservation.confidence, 'confirmed');
  });

  it('reports inactive signalling from lifecycle evidence instead of room allocation', async () => {
    const report = await buildNetworkDiagnostics({
      adapters: [],
      relayFallbackEnabled: false,
      signalling: [{
        family: 'mqtt',
        enabled: true,
        active: false,
        stage: 'failed',
        roomCreated: true,
        endpoints: [{
          id: 'endpoint-id',
          endpoint: 'wss://broker.example/mqtt',
          state: 'disconnected',
          subscription: 'not-observed',
          publication: 'not-observed',
        }],
        evidence: [],
        routes: [],
        lastError: { category: 'authentication', phase: 'handshake', at: 123 },
      }],
    });

    const signalling = report.observations.find((item) => item.observation.includes('MQTT signalling'));
    assert.ok(signalling);
    assert.equal(signalling.confidence, 'confirmed');
    assert.match(signalling.impact, /last failure: handshake\/authentication/i);
  });

  it('distinguishes absent, invalid, and unreachable custom TURN configuration', async () => {
    const absent = await buildNetworkDiagnostics({
      turnStatus: 'not-configured', adapters: [], relayFallbackEnabled: false,
    });
    assert.ok(absent.observations.some((item) => item.observation === 'Custom TURN is not configured.'));
    assert.equal(absent.udp.state, 'unknown');

    const invalid = await buildNetworkDiagnostics({
      turnStatus: 'invalid', adapters: [], relayFallbackEnabled: false,
    });
    assert.ok(invalid.observations.some((item) => item.observation.includes('no valid turn: or turns:')));

    const unreachable = await buildNetworkDiagnostics({
      turnStatus: 'configured',
      turnProbes: [probe('udp', false), probe('tcp', false), probe('tls', false)],
      adapters: [],
      relayFallbackEnabled: false,
    });
    assert.equal(unreachable.udp.state, 'unknown');
    assert.ok(unreachable.observations.some((item) =>
      item.observation === 'All configured TURN endpoint probes failed.'));
    assert.ok(unreachable.observations.some((item) =>
      item.impact.includes('does not prove UDP is blocked')));
  });
});
