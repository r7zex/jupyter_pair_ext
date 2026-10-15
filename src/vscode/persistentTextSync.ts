import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import { atomicWriteFile } from '../core/atomicFile';
import { CollaborativeProject } from '../core/crdt';
import { classifyFile } from '../core/projectFiles';
import { REMOTE_ORIGIN } from '../core/types';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import type { PersistentLiveEvent } from '../vps/persistentLive';
import { EditorSynchronizer } from './sync';

interface Connection { endpoint: string; sessionId: string; memberId: string; client: PersistentClient }
interface Reply { epoch: string; revision: number; update: string }
interface State {
  document: vscode.TextDocument; connection: Connection; key: string; file: string; epoch: string;
  project: CollaborativeProject; editor?: EditorSynchronizer; pending?: Uint8Array; inFlight?: Uint8Array; ready: Promise<void>;
  sending?: Promise<void>; journal: Promise<void>; closed: boolean;
}

/** Ordinary project files use the same local Yjs authorship as P2P editing. */
export class PersistentTextSynchronizer implements vscode.Disposable {
  private readonly states = new Map<string, State>();
  private readonly remoteBootstrap = new WeakSet<vscode.TextDocument>();
  private readonly listeners: vscode.Disposable[];
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly connection: () => Connection | undefined,
    private readonly log: Pick<vscode.OutputChannel, 'appendLine'>) {
    this.listeners = [vscode.workspace.onDidOpenTextDocument((document) => { void this.ensure(document).catch((error) => this.report(error)); }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const state = this.states.get(document.uri.toString());
        if (state) void this.persist(state).finally(() => this.close(state)).catch((error) => this.report(error));
      })];
    this.timer = setInterval(() => { void this.flushAll().catch((error) => this.report(error)); }, 1000); this.timer.unref();
  }
  private report(error: unknown): void { this.log.appendLine(`[debug] Text synchronization retry: ${error instanceof Error ? error.message : 'Disconnected.'}`); }
  manages(uri: vscode.Uri): boolean { return !!this.states.get(uri.toString())?.editor; }
  private close(state: State): void {
    if (state.closed) return; state.closed = true; state.editor?.dispose(); state.project.destroy(); this.states.delete(state.document.uri.toString());
  }
  reset(): void { for (const state of [...this.states.values()]) { void this.persist(state).catch((error) => this.report(error)); this.close(state); } }
  private current(state: State): void { if (state.closed || this.stopped || this.connection() !== state.connection) throw new Error('Text synchronization connection changed.'); }
  private persist(state: State): Promise<void> {
    // Capture bytes synchronously so reset/dispose cannot destroy an unsaved replica.
    if (state.closed || !state.project.has(state.key)) return state.journal;
    const pending = state.inFlight && state.pending ? Y.mergeUpdates([state.inFlight, state.pending]) : state.inFlight ?? state.pending;
    const bytes = JSON.stringify({ epoch: state.epoch, update: Buffer.from(state.project.encodeUpdate(state.key)).toString('base64'),
      ...(pending ? { pending: Buffer.from(pending).toString('base64') } : {}) });
    state.journal = state.journal.catch(() => undefined).then(() => atomicWriteFile(state.file, bytes)); return state.journal;
  }
  async ensure(document: vscode.TextDocument): Promise<State | undefined> {
    const connection = this.connection();
    if (this.stopped || !connection || document.isClosed || document.uri.scheme !== 'pair-vps' || document.uri.authority !== connection.sessionId
      || classifyFile(document.uri.path, Buffer.byteLength(document.getText())) !== 'text') return undefined;
    const uri = document.uri.toString(); let state = this.states.get(uri);
    if (state?.connection !== connection) { if (state) { await this.persist(state); this.close(state); } state = undefined; }
    if (!state) {
      state = { document, connection, key: document.uri.path.slice(1), file: path.join(this.context.globalStorageUri.fsPath, 'persistent-text',
        createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId, document.uri.path])).digest('hex') + '.json'),
        epoch: '', project: new CollaborativeProject(), ready: Promise.resolve(), journal: Promise.resolve(), closed: false };
      this.states.set(uri, state); const created = state;
      state.ready = this.initialize(state).catch((error) => { this.close(created); throw error; });
    }
    await state.ready; return state;
  }
  private async initialize(state: State): Promise<void> {
    let saved: { epoch: string; update: string; pending?: string } | undefined;
    try {
      saved = JSON.parse(await readFile(state.file, 'utf8'));
      if (!saved || typeof saved.epoch !== 'string' || typeof saved.update !== 'string') throw new SyntaxError('Invalid text journal.');
      const probe = new Y.Doc(); try { Y.applyUpdate(probe, Buffer.from(saved.update, 'base64')); } finally { probe.destroy(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
        await rename(state.file, `${state.file}.invalid-${Date.now()}.json`); saved = undefined;
        this.log.appendLine('[warn] Invalid text journal archived; reconnecting from the server and editor.');
      }
    }
    const reply = await state.connection.client.call<Reply>('textSync', { sessionId: state.connection.sessionId, path: state.key }); this.current(state);
    state.epoch = reply.epoch; state.project.applyRemoteUpdate(state.key, 'text', Buffer.from(reply.update, 'base64'));
    if (saved?.epoch === reply.epoch) {
      state.project.applyRemoteUpdate(state.key, 'text', Buffer.from(saved.update, 'base64'));
      if (saved.pending) state.pending = Buffer.from(saved.pending, 'base64');
    } else if (saved) {
      await rename(state.file, `${state.file}.recovered-${Date.now()}.json`);
      this.log.appendLine(`[info] Replaced text replica archived for ${state.key}.`);
      this.remoteBootstrap.add(state.document);
    }
    state.project.on('update', (event) => {
      if (event.origin === REMOTE_ORIGIN) return;
      state.pending = state.pending ? Y.mergeUpdates([state.pending, event.update]) : event.update;
      void this.send(state).catch((error) => this.report(error));
    });
    state.editor = new EditorSynchronizer(state.project, '', this.log, undefined, undefined, undefined,
      (uri) => uri.toString() === state.document.uri.toString() ? state.key : undefined, !this.remoteBootstrap.has(state.document));
    this.remoteBootstrap.delete(state.document);
    await this.persist(state);
  }
  private send(state: State): Promise<void> {
    if (state.sending) return state.sending;
    const work = Promise.resolve().then(async () => {
      await state.ready; this.current(state);
      while (state.pending) {
        const update = state.pending; state.inFlight = update; delete state.pending; await this.persist(state); this.current(state);
        try {
          const reply = await state.connection.client.call<Reply>('textSync', { sessionId: state.connection.sessionId, path: state.key,
            epoch: state.epoch, update: Buffer.from(update).toString('base64'), stateVector: Buffer.from(Y.encodeStateVector(state.project.text(state.key).doc!)).toString('base64') });
          this.current(state); state.project.applyRemoteUpdate(state.key, 'text', Buffer.from(reply.update, 'base64'));
          delete state.inFlight;
          await this.persist(state);
        } catch (error) {
          state.pending = state.pending ? Y.mergeUpdates([update, state.pending]) : update; delete state.inFlight;
          await this.persist(state);
          if (error instanceof PersistentHttpError && [400, 409, 413].includes(error.status)) {
            await this.recoverReplacement(state);
            if (error.status !== 409) void vscode.window.showWarningMessage('The server could not accept this edit. It was archived locally for recovery; reconnecting to the saved file.');
          }
          throw error;
        }
      }
    });
    state.sending = work.finally(() => { delete state.sending; }); return state.sending;
  }
  receive(event: PersistentLiveEvent): void {
    if (event.kind === 'ready' || event.kind === 'invalidate') { void this.flushAll(true).catch((error) => this.report(error)); return; }
    if (event.kind !== 'text') return;
    for (const state of this.states.values()) if (state.key === event.path && state.epoch === event.epoch && !state.closed) {
      state.project.applyRemoteUpdate(state.key, 'text', Buffer.from(event.update, 'base64'));
    }
  }
  async flushAll(refresh = false): Promise<void> {
    await Promise.all((vscode.workspace.textDocuments ?? []).map(async (document) => {
      const state = await this.ensure(document); if (!state) return; await this.send(state);
      if (refresh) {
        try {
          const reply = await state.connection.client.call<Reply>('textSync', { sessionId: state.connection.sessionId, path: state.key, epoch: state.epoch,
            stateVector: Buffer.from(Y.encodeStateVector(state.project.text(state.key).doc!)).toString('base64') });
          this.current(state); state.project.applyRemoteUpdate(state.key, 'text', Buffer.from(reply.update, 'base64'));
        } catch (error) {
          if (!(error instanceof PersistentHttpError) || error.status !== 409) throw error;
          await this.recoverReplacement(state); await this.ensure(document);
        }
      }
    }));
  }
  private async recoverReplacement(state: State): Promise<void> {
    await this.persist(state); await rename(state.file, `${state.file}.recovered-${Date.now()}.json`);
    this.remoteBootstrap.add(state.document); this.close(state);
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => this.persist(state)));
    this.stopped = true; clearInterval(this.timer); for (const listener of this.listeners) listener.dispose();
    for (const state of [...this.states.values()]) this.close(state);
  }
  dispose(): void { if (this.stopped) return; this.stopped = true; clearInterval(this.timer); for (const listener of this.listeners) listener.dispose(); this.reset(); }
}
