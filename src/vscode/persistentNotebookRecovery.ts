import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';
import { atomicWriteFile } from '../core/atomicFile';
import { normalizeNotebookMetadata, serializeIpynb } from '../core/projectFiles';
import { executionFromCell, outputsFromCell } from './sync';

/** Local backing for a detached notebook URI; never a server write. */
export class PersistentNotebookRecovery {
  private readonly detached = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}
  isDetached(uri: vscode.Uri): boolean { return this.detached.has(uri.toString()); }
  file(uri: vscode.Uri): string {
    return path.join(this.directory, createHash('sha256').update(uri.toString()).digest('hex') + '.ipynb');
  }
  async has(uri: vscode.Uri): Promise<boolean> {
    if (uri.scheme !== 'pair-vps' || !uri.path.endsWith('.ipynb')) return false;
    if (this.isDetached(uri)) { await this.writes.get(uri.toString()); return true; }
    try { if (!(await stat(this.file(uri))).isFile()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    this.detached.add(uri.toString());
    return true;
  }
  preserve(notebook: vscode.NotebookDocument): Promise<void> {
    return this.save(notebook.uri, serializeIpynb({ metadata: normalizeNotebookMetadata(notebook.metadata), cells: notebook.getCells().map(cell => ({
      id: cell.metadata.pairNotebookCellId ?? cell.metadata.id ?? randomUUID(), kind: cell.kind, language: cell.document.languageId,
      source: cell.document.getText(), metadata: cell.metadata, outputs: outputsFromCell(cell), execution: executionFromCell(cell),
    })) }));
  }
  save(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const key = uri.toString(), content = Buffer.from(bytes);
    const work = (this.writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWriteFile(this.file(uri), content);
      this.detached.add(key);
    });
    this.writes.set(key, work);
    void work.finally(() => { if (this.writes.get(key) === work) this.writes.delete(key); }).catch(() => undefined);
    return work;
  }
  async read(uri: vscode.Uri): Promise<Uint8Array> { await this.writes.get(uri.toString()); return readFile(this.file(uri)); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.writes.get(uri.toString());
    const saved = await stat(this.file(uri));
    // Server modification clocks no longer apply to a detached local copy.
    return { type: 1, ctime: 0, mtime: 0, size: saved.size };
  }
}
