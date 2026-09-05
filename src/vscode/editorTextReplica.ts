import * as Y from 'yjs';
import { CollaborativeProject, ProjectUpdate, TextChange } from '../core/crdt';

interface SharedVersion { project: CollaborativeProject; revision: number; references: number }

/** One source-only template per open document, shared by its displayed cells. */
class TextReplicaPool {
  public readonly members = new Set<EditorTextReplica>();
  private readonly template = new CollaborativeProject();
  private revision = 0;
  private latest: SharedVersion | undefined;

  public constructor(public readonly canonical: CollaborativeProject, public key: string, private readonly notebook: boolean) {
    this.template.applyRemoteUpdate(key, notebook ? 'notebook' : 'text', canonical.encodeUpdate(key));
    this.stripRichState();
    canonical.on('update', this.onUpdate);
  }

  private readonly onUpdate = (event: ProjectUpdate): void => {
    if (event.key !== this.key) return;
    // Consume every incremental update to retain contiguous Yjs client clocks.
    // Large outputs are collected immediately and never copied per editor.
    this.template.applyRemoteUpdate(this.key, event.kind, event.update);
    this.stripRichState();
    this.revision += 1;
  };

  private stripRichState(): void {
    if (!this.notebook) return;
    const doc = this.template.ensureNotebook(this.key);
    doc.transact(() => {
      doc.getMap('notebook').clear();
      for (const cell of doc.getMap<Y.Map<unknown>>('cellData').values()) {
        for (const field of [...cell.keys()]) {
          if (field !== 'source' && field !== 'textRevision') cell.delete(field);
        }
      }
    });
  }

  public version(): SharedVersion {
    if (this.latest?.revision === this.revision) return this.latest;
    const previous = this.latest;
    const project = new CollaborativeProject();
    project.applyRemoteUpdate(this.key, this.notebook ? 'notebook' : 'text', this.template.encodeUpdate(this.key));
    this.latest = { project, revision: this.revision, references: 0 };
    // Unchanged displayed sources can share the new version immediately. Only
    // cells with unapplied source changes retain an older source-only version.
    for (const member of this.members) {
      if (member.cellId && !project.hasNotebookCell(this.key, member.cellId)) continue;
      if (member.source() === member.sourceIn(project)) member.adopt(this.latest);
    }
    if (previous && !previous.references) previous.project.destroy();
    return this.latest;
  }

  public release(version: SharedVersion): void {
    version.references -= 1;
    if (!version.references && version !== this.latest) version.project.destroy();
  }

  public rename(key: string): void {
    const previousKey = this.key;
    const versions = new Set([...this.members].map((member) => member.version));
    if (this.latest) versions.add(this.latest);
    this.template.renameDocument(previousKey, key);
    for (const version of versions) version.project.renameDocument(previousKey, key);
    this.key = key;
    const pools = replicaPools.get(this.canonical)!;
    pools.delete(previousKey);
    pools.set(key, this);
  }

  public dispose(): void {
    this.canonical.off('update', this.onUpdate);
    this.template.destroy();
    this.latest?.project.destroy();
    replicaPools.get(this.canonical)?.delete(this.key);
  }
}

const replicaPools = new WeakMap<CollaborativeProject, Map<string, TextReplicaPool>>();

/** Displayed Yjs identities survive while remote editor updates are queued. */
export class EditorTextReplica {
  private readonly pool: TextReplicaPool;
  public version: SharedVersion;
  private disposed = false;

  public constructor(public readonly canonical: CollaborativeProject, key: string, public readonly cellId?: string) {
    let pools = replicaPools.get(canonical);
    if (!pools) { pools = new Map(); replicaPools.set(canonical, pools); }
    let pool = pools.get(key);
    if (!pool) { pool = new TextReplicaPool(canonical, key, !!cellId); pools.set(key, pool); }
    this.pool = pool;
    this.version = pool.version();
    this.version.references += 1;
    pool.members.add(this);
  }

  public get key(): string { return this.pool.key; }
  public get project(): CollaborativeProject { return this.version.project; }
  public sourceIn(project: CollaborativeProject): string {
    return (this.cellId ? project.cellSource(this.key, this.cellId) : project.text(this.key)).toString();
  }
  public source(): string { return this.sourceIn(this.project); }

  public adopt(version: SharedVersion): void {
    if (version === this.version) return;
    const previous = this.version;
    this.version = version;
    version.references += 1;
    this.pool.release(previous);
  }

  public edit(changes: readonly TextChange[]): void {
    const updates: Uint8Array[] = [];
    const capture = (event: ProjectUpdate) => updates.push(event.update);
    this.project.on('update', capture);
    try {
      if (this.cellId) this.project.applyCellTextChanges(this.key, this.cellId, changes);
      else this.project.applyTextChanges(this.key, changes);
    } finally { this.project.off('update', capture); }
    // Template pruning and historical deletion sets never cross this boundary.
    if (updates.length) this.canonical.mergeEditorText(this.key, this.cellId, Y.mergeUpdates(updates));
  }

  public accept(update: Uint8Array): void {
    this.project.applyRemoteUpdate(this.key, this.cellId ? 'notebook' : 'text', update);
  }

  public rename(key: string): void { this.pool.rename(key); }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.members.delete(this);
    this.pool.release(this.version);
    if (!this.pool.members.size) this.pool.dispose();
  }
}
