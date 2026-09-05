import * as Y from 'yjs';
import { CollaborativeProject, ProjectUpdate, TextChange } from '../core/crdt';

/** A displayed text version retains Yjs identities while canonical updates queue. */
export class EditorTextReplica {
  public readonly project = new CollaborativeProject();

  public constructor(
    public readonly canonical: CollaborativeProject,
    public key: string,
    public readonly cellId?: string,
  ) {
    this.project.applyRemoteUpdate(key, cellId ? 'notebook' : 'text', canonical.encodeUpdate(key));
    if (cellId) {
      // Retain only this source's identities, not one copy of every rich output
      // and neighboring cell per open editor. These private deletions are never
      // included in the incremental authoring updates sent to canonical state.
      const doc = this.project.cellSource(key, cellId).doc!;
      doc.transact(() => {
        const cells = doc.getMap<Y.Map<unknown>>('cellData');
        for (const [id, cell] of cells) {
          if (id !== cellId) cells.delete(id);
          else for (const field of [...cell.keys()]) {
            if (field !== 'source' && field !== 'textRevision') cell.delete(field);
          }
        }
      });
    }
  }

  public source(): string {
    return (this.cellId ? this.project.cellSource(this.key, this.cellId) : this.project.text(this.key)).toString();
  }

  public edit(changes: readonly TextChange[]): void {
    const updates: Uint8Array[] = [];
    const capture = (event: ProjectUpdate) => updates.push(event.update);
    this.project.on('update', capture);
    try {
      if (this.cellId) this.project.applyCellTextChanges(this.key, this.cellId, changes);
      else this.project.applyTextChanges(this.key, changes);
    } finally {
      this.project.off('update', capture);
    }
    if (updates.length) this.canonical.mergeEditorText(this.key, this.cellId, Y.mergeUpdates(updates));
  }

  public accept(update: Uint8Array): void {
    this.project.applyRemoteUpdate(this.key, this.cellId ? 'notebook' : 'text', update);
  }

  public rename(key: string): void {
    this.project.renameDocument(this.key, key);
    this.key = key;
  }

  public dispose(): void { this.project.destroy(); }
}
