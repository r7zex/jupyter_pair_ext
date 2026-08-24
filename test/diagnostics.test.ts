import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  assessUdpAvailability,
  buildNetworkDiagnostics,
  classifyAdapters,
  type AdapterObservation,
} from '../src/runtime/diagnostics';
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
    assert.equal(everythingDown.state, 'unavailable');
    assert.equal(everythingDown.confidence, 'medium', 'must not overclaim when nothing works');

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
    const report = await buildNetworkDiagnostics({
      turnProbes: [probe('udp', false), probe('tls', true)],
      adapters,
      proxyOptions: {
        env: { HTTPS_PROXY: 'http://alice:sup3r-s3cret@proxy.corp.example:8080' },
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

    // zapret/Flowseal is never named as a confirmed blocker anywhere.
    for (const observation of report.observations) {
      assert.ok(!/zapret|flowseal/i.test(observation.observation),
        'filtering software must not be claimed without direct evidence');
    }
  });

  it('reports DNS failures only when an injected resolver actually fails', async () => {
    const report = await buildNetworkDiagnostics({
      resolveDns: async (host) => {
        if (host === 'relay.damus.io') throw new Error('ENOTFOUND');
        return { address: '1.2.3.4' };
      },
      dnsHosts: ['nos.lol', 'relay.damus.io'],
    });
    assert.deepEqual(report.dnsFailures, ['relay.damus.io']);
    const dnsObservation = report.observations.find((item) => item.observation.includes('DNS resolution failed'));
    assert.ok(dnsObservation);
    assert.equal(dnsObservation.confidence, 'confirmed');
  });
});
