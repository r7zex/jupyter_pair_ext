import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  MIN_DIRECT_IMPROVEMENT_RATIO,
  shouldMigrateRoute,
} from '../src/runtime/routeScoring';
import {
  NetworkChangeWatcher,
  fingerprintInterfaces,
} from '../src/runtime/netWatch';
import type { networkInterfaces } from 'node:os';

type InterfaceList = ReturnType<typeof networkInterfaces>;

function iface(name: string, family: string, address: string, internal = false): InterfaceList {
  return { [name]: [{ address, family, internal } as never] };
}

describe('route selection policy', () => {
  const relayCurrent = { kind: 'relay' as const, rttMs: 110, recentFailures: 0 };
  const directCurrent = { kind: 'direct' as const, rttMs: 24, recentFailures: 0 };

  it('always migrates from relay to a verified stable direct candidate', () => {
    const decision = shouldMigrateRoute(relayCurrent, { kind: 'direct', rttMs: 28, recentFailures: 0 });
    assert.equal(decision.migrate, true);
    assert.equal(decision.reason, 'relay-to-direct');
  });

  it('does not migrate for a meaningless 1 ms direct improvement (hysteresis)', () => {
    const decision = shouldMigrateRoute(
      directCurrent,
      { kind: 'direct', rttMs: 23, recentFailures: 0 },
    );
    assert.equal(decision.migrate, false);
    assert.equal(decision.reason, 'marginal-improvement');
    // The threshold itself is the documented 20% ratio.
    const meaningful = shouldMigrateRoute(
      directCurrent,
      { kind: 'direct', rttMs: Math.floor(24 * MIN_DIRECT_IMPROVEMENT_RATIO) - 1, recentFailures: 0 },
    );
    assert.equal(meaningful.migrate, true);
  });

  it('rejects unverified or recently failing candidates', () => {
    assert.equal(shouldMigrateRoute(relayCurrent, { kind: 'direct', rttMs: -1, recentFailures: 0 }).migrate, false);
    const unstable = shouldMigrateRoute(
      relayCurrent,
      { kind: 'direct', rttMs: 20, recentFailures: 2 },
    );
    assert.equal(unstable.migrate, false);
    assert.equal(unstable.reason, 'candidate-unstable');
  });

  it('never migrates direct -> relay', () => {
    const decision = shouldMigrateRoute(directCurrent, { kind: 'relay', rttMs: 5, recentFailures: 0 });
    assert.equal(decision.migrate, false);
  });
});

describe('passive network-change detection', () => {
  it('fingerprints adapter/address sets order-independently', () => {
    const a = fingerprintInterfaces({ ...iface('Eth', 'IPv4', '10.0.0.2'), ...iface('Wi-Fi', 'IPv4', '192.168.0.5') });
    const b = fingerprintInterfaces({ ...iface('Wi-Fi', 'IPv4', '192.168.0.5'), ...iface('Eth', 'IPv4', '10.0.0.2') });
    assert.equal(a, b, 'same set in different insertion order must match');
  });

  it('fires exactly once per actual change and never for identical snapshots', () => {
    let current = iface('Ethernet', 'IPv4', '192.168.1.10');
    let changes = 0;
    const watcher = new NetworkChangeWatcher(() => { changes += 1; }, {
      intervalMs: 10,
      listInterfaces: () => current,
    });
    watcher.start();
    assert.equal(watcher.check(), false, 'identical snapshot must not fire');
    current = { ...current, ...iface('WireGuard Tunnel', 'IPv4', '10.8.0.2') };
    assert.equal(watcher.check(), true, 'adapter appearance must fire');
    assert.equal(changes, 1);
    assert.equal(watcher.check(), false, 'no further change must not fire');
    current = iface('Ethernet', 'IPv4', '192.168.1.11');
    assert.equal(watcher.check(), true, 'address change must fire');
    assert.equal(changes, 2);
    watcher.stop();
  });
});
