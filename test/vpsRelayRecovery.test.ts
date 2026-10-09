import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { WebSocket } from 'ws';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';

class RelaySocket extends EventEmitter {
  public readyState = WebSocket.OPEN;
  public bufferedAmount = 0;
  public reply = true;
  public terminated = false;
  public probes: string[] = [];

  public send(raw: string): void {
    if (JSON.parse(raw).t !== 'probe') return;
    this.probes.push(raw);
    if (this.reply) setImmediate(() => this.emit('message', raw));
  }

  public terminate(): void {
    this.terminated = true;
    this.emit('close');
  }
}

const flushSocketEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('VPS relay half-open route recovery', () => {
  it('rechecks the encrypted path, rejects stale probes and reconnects before the peer recovery lease expires', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const sockets: RelaySocket[] = [];
    const relay = new VpsFrameRelay({
      sessionId: 'half-open', token: 'invitation-token', localPeerId: 'host',
      vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) },
      socketFactory: () => {
        const socket = new RelaySocket();
        sockets.push(socket);
        setImmediate(() => socket.emit('open'));
        return socket as unknown as WebSocket;
      },
    });
    try {
      relay.start();
      await flushSocketEvents();
      await flushSocketEvents();
      assert.equal(relay.connectedRelayCount, 1);
      const first = sockets[0]!;
      const initialProbe = first.probes[0]!;
      first.reply = false;
      mock.timers.tick(10_000);
      assert.equal(first.probes.length, 2, 'A ready socket still requires fresh encrypted round trips.');
      first.emit('message', initialProbe);
      mock.timers.tick(10_000);
      assert.equal(first.terminated, true, 'An old probe cannot keep a broken path alive.');
      assert.equal(relay.connectedRelayCount, 0);
      mock.timers.tick(2_000);
      await flushSocketEvents();
      await flushSocketEvents();
      assert.equal(sockets.length, 2);
      assert.equal(relay.connectedRelayCount, 1);
      first.emit('message', first.probes[1]!);
      assert.equal(relay.connectedRelayCount, 1, 'Late retired-socket messages cannot affect the replacement.');
      relay.stop();
      mock.timers.tick(60_000);
      assert.equal(sockets.length, 2, 'Stop cancels heartbeat and reconnect timers.');
      assert.equal(relay.connectedRelayCount, 0);
    } finally {
      relay.stop();
      mock.timers.reset();
    }
  });
});
