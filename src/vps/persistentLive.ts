import type { ServerResponse } from 'node:http';
import type { PresenceState } from '../runtime/session';

export type PersistentPresence = PresenceState & { epoch: string; readOnly: boolean };
export type PersistentLiveEvent = { kind: 'ready' } | { kind: 'invalidate' } | { kind: 'presence'; states: PersistentPresence[] }
  | { kind: 'execution'; path: string; id: string }
  | { kind: 'notebook'; path: string; epoch: string; revision: number; update: string };
interface Subscriber { response: ServerResponse; memberId: string; valid: () => boolean; visible: (path: string) => boolean }

/** Authenticated push transport for the existing editor and presence protocol. */
export class PersistentLive {
  private readonly subscribers = new Set<Subscriber>();
  private readonly presence = new Map<string, { state: PersistentPresence; at: number }>();
  private readonly timer: NodeJS.Timeout;
  constructor() { this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref(); }
  close(): void { clearInterval(this.timer); for (const subscriber of this.subscribers) subscriber.response.end(); this.subscribers.clear(); this.presence.clear(); }
  attach(subscriber: Subscriber): void {
    if (this.subscribers.size >= 64 || [...this.subscribers].filter((item) => item.memberId === subscriber.memberId).length >= 4) throw Object.assign(new Error('Live connection limit reached.'), { status: 429 });
    subscriber.response.setHeader('content-type', 'text/event-stream'); subscriber.response.setHeader('x-accel-buffering', 'no'); subscriber.response.flushHeaders();
    this.subscribers.add(subscriber); this.send(subscriber, { kind: 'ready' }); this.sendPresence(subscriber);
    subscriber.response.on('close', () => {
      this.subscribers.delete(subscriber);
      if (![...this.subscribers].some((item) => item.memberId === subscriber.memberId)) this.remove(subscriber.memberId);
    });
  }
  states(visible: (path: string) => boolean = () => true): PersistentPresence[] {
    return [...this.presence.values()].filter((item) => Date.now() - item.at < 5000 && !!item.state.activeFile && visible(item.state.activeFile)).map((item) => item.state);
  }
  update(memberId: string, state: PersistentPresence | undefined): void {
    if (state) this.presence.set(memberId, { state, at: Date.now() }); else this.presence.delete(memberId);
    for (const subscriber of this.subscribers) this.sendPresence(subscriber);
  }
  remove(memberId: string): void { if (this.presence.delete(memberId)) for (const subscriber of this.subscribers) this.sendPresence(subscriber); }
  broadcast(event: PersistentLiveEvent, permitted: (memberId: string) => boolean = () => true): void {
    for (const subscriber of this.subscribers) {
      if (!permitted(subscriber.memberId) || ((event.kind === 'notebook' || event.kind === 'execution') && !subscriber.visible(event.path))) continue;
      this.send(subscriber, event);
    }
  }
  invalidate(): void {
    this.presence.clear(); this.sweep(); this.broadcast({ kind: 'invalidate' });
    for (const subscriber of this.subscribers) this.sendPresence(subscriber);
  }
  private sendPresence(subscriber: Subscriber): void { this.send(subscriber, { kind: 'presence', states: this.states(subscriber.visible) }); }
  private send(subscriber: Subscriber, event: PersistentLiveEvent): void {
    if (!subscriber.valid()) { subscriber.response.end(); this.subscribers.delete(subscriber); this.presence.delete(subscriber.memberId); return; }
    const bytes = `data: ${JSON.stringify(event)}\n\n`;
    if (Buffer.byteLength(bytes) > 256 * 1024) { this.send(subscriber, { kind: 'invalidate' }); return; }
    if (!subscriber.response.write(bytes)) { subscriber.response.destroy(); this.subscribers.delete(subscriber); }
  }
  private sweep(): void {
    let changed = false;
    for (const [id, item] of this.presence) if (Date.now() - item.at >= 5000) { this.presence.delete(id); changed = true; }
    for (const subscriber of this.subscribers) {
      if (!subscriber.valid()) { subscriber.response.end(); this.subscribers.delete(subscriber); changed ||= this.presence.delete(subscriber.memberId); }
      else if (!subscriber.response.write(': heartbeat\n\n')) subscriber.response.destroy();
    }
    if (changed) for (const subscriber of this.subscribers) this.sendPresence(subscriber);
  }
}
