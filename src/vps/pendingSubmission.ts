import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../core/atomicFile';
import { type JobSubmission, normalizeVpsUrl, validateSubmission, VPS_ID } from './protocol';

/** Private immutable receipts survive editor restarts and ambiguous HTTP responses. */
export class PendingSubmissionStore {
  public constructor(private readonly directory: string) {}
  public async load(endpoint: string): Promise<JobSubmission | undefined> {
    for await (const job of this.list(endpoint)) return job;
    return undefined;
  }
  /** Iterate one receipt at a time so multiple editor windows do not multiply snapshot memory. */
  public async *list(endpoint: string): AsyncGenerator<JobSubmission> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).filter((value) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(value)).sort()) {
      let contents: string;
      try { contents = await readFile(path.join(this.directory, name), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // Another editor completed recovery after readdir.
        throw error;
      }
      const receipt = JSON.parse(contents) as { endpoint: string; job: unknown };
      if (receipt.endpoint !== normalizeVpsUrl(endpoint)) continue;
      const job = validateSubmission(receipt.job);
      if (name !== `${job.id}.json`) throw new Error('Pending VPS submission is inconsistent. Inspect local extension storage before retrying.');
      yield job;
    }
  }
  public async save(endpoint: string, job: JobSubmission): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWriteFile(path.join(this.directory, `${job.id}.json`), JSON.stringify({ endpoint: normalizeVpsUrl(endpoint), job: validateSubmission(job) }));
  }
  public async clear(id: string): Promise<void> {
    if (!VPS_ID.test(id)) throw new Error('Invalid pending submission ID.');
    try { await unlink(path.join(this.directory, `${id}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
