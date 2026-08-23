import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CellSnapshot,
  CollaborativeProject,
  MAX_CELL_OUTPUTS,
  MAX_NOTEBOOK_CELLS,
  MAX_OUTPUT_ITEMS_PER_CELL,
  NotebookSnapshot,
  OutputSnapshot,
} from './crdt';
import { SESSION_TERMINATION_MARKER } from './sessionTermination';
import { MAX_TRANSFER_BYTES } from './transfer';
import { newId } from './types';
import { filesystemPathComparisonKey, portableRelativePath } from './projectPath';

export const MAX_COLLABORATIVE_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const MAX_TRACKED_PROJECT_ENTRIES = 50_000;

const TEXT_EXTENSIONS = new Set([
  '.py', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.ts', '.tsx', '.js', '.jsx',
  '.css', '.scss', '.html', '.xml', '.ini', '.cfg', '.sql', '.r', '.sh', '.ps1',
]);

// path.extname('.env') and path.extname('.gitignore') are empty, so dotfiles
// that are intentionally collaborative text need basename-aware classification.
const TEXT_BASENAMES = new Set([
  '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
]);

const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_BASENAMES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
  'credentials.json', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.p12', '.pfx', '.key', '.keystore', '.jks']);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg']);

const SKIP_CRDT_DIRECTORIES = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pair-notebook-transfers',
]);


export function shouldTrackProjectPath(relativePath: string): boolean {
  const normalized = portableRelativePath(relativePath);
  if (!normalized
    || normalized === '.pair-notebook-session.json'
    || normalized === SESSION_TERMINATION_MARKER
    || normalized.startsWith(`${SESSION_TERMINATION_MARKER}.tmp-`)
    || normalized === '.pair-notebook-autosave.json'
    || /\.pair-notebook-[A-Za-z0-9-]+(?:-backup)?\.tmp$/i.test(normalized)) return false;
  const segments = normalized.split('/');
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase()))) return false;
  if (SENSITIVE_BASENAMES.has(basename) || SENSITIVE_EXTENSIONS.has(path.extname(basename))) return false;
  if (basename.startsWith('.env.') && !SAFE_ENV_TEMPLATES.has(basename)) return false;
  return segments.every((segment) => !SKIP_CRDT_DIRECTORIES.has(segment.toLowerCase()));
}

export interface ProjectFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  kind: 'text' | 'notebook' | 'binary';
  hash: string;
}

export async function copyProject(source: string, destination: string): Promise<void> {
  const sourceRoot = await realpath(source);
  const destinationRoot = path.resolve(destination);
  const sourceInfo = await stat(sourceRoot);
  if (!sourceInfo.isDirectory()) throw new Error('The selected project source must be a directory.');
  if (pathsOverlap(sourceRoot, destinationRoot)) {
    throw new Error('The project source and isolated working copy must not overlap.');
  }
  try {
    const destinationInfo = await lstat(destinationRoot);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
      throw new Error('The isolated working copy must be a real directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let trackedEntries = 0;
  await mkdir(destinationRoot, { recursive: true });
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    filter: async (item) => {
      const relative = path.relative(sourceRoot, item);
      if (!relative) return true;
      if (relative && !shouldTrackProjectPath(relative)) return false;
      trackedEntries += 1;
      if (trackedEntries > MAX_TRACKED_PROJECT_ENTRIES) {
        throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
      }
      const info = await lstat(item);
      if (info.isSymbolicLink()) return false;
      if (info.isFile() && info.size > MAX_TRANSFER_BYTES) {
        throw new Error(`Project file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit: ${relative}`);
      }
      return true;
    },
  });
}

function pathsOverlap(left: string, right: string): boolean {
  const first = filesystemPathComparisonKey(left);
  const second = filesystemPathComparisonKey(right);
  const contained = (parent: string, candidate: string) => {
    const relative = path.relative(parent, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contained(first, second) || contained(second, first);
}

export async function scanProject(root: string, includeIgnored = false): Promise<ProjectFile[]> {
  const result: ProjectFile[] = [];
  await walk(root, '', result, includeIgnored);
  return result;
}

export async function scanDirectories(root: string, includeIgnored = false): Promise<string[]> {
  const result: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(relative, entry.name);
      if (!includeIgnored && !shouldTrackProjectPath(child)) continue;
      if (result.length >= MAX_TRACKED_PROJECT_ENTRIES) {
        throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
      }
      result.push(child.split(path.sep).join('/'));
      await visit(child);
    }
  };
  await visit('');
  return result;
}

async function walk(root: string, relative: string, result: ProjectFile[], includeIgnored: boolean): Promise<void> {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (!shouldTrackProjectPath(childRelative) && !includeIgnored) continue;
    if (entry.name === '.pair-notebook-session.json') continue;
    if (entry.isDirectory()) {
      await walk(root, childRelative, result, includeIgnored);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = path.join(root, childRelative);
    const info = await stat(absolutePath);
    if (info.size > MAX_TRANSFER_BYTES) {
      throw new Error(`Project file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit: ${childRelative}`);
    }
    if (result.length >= MAX_TRACKED_PROJECT_ENTRIES) {
      throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
    }
    let kind = classifyFile(childRelative, info.size);
    let documentBytes: Buffer | undefined;
    if (kind === 'text' || kind === 'notebook') {
      documentBytes = await readFile(absolutePath);
      const decoded = decodeUtf8ProjectFile(documentBytes);
      if (decoded === undefined) kind = 'binary';
      else if (kind === 'notebook') {
        try {
          parseIpynb(decoded);
        } catch {
          kind = 'binary';
        }
      }
    }
    result.push({
      relativePath: childRelative.split(path.sep).join('/'),
      absolutePath,
      size: info.size,
      kind,
      // Hashing is streamed: scanning a project with multi-gigabyte files must
      // not load any of them into memory.
      hash: documentBytes
        ? createHash('sha256').update(documentBytes).digest('hex')
        : await hashFileContents(absolutePath),
    });
  }
}

/** SHA-256 of a file, computed with a bounded reusable buffer. */
export async function hashFileContents(absolutePath: string, chunkSize = 256 * 1024): Promise<string> {
  const handle = await open(absolutePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function classifyFile(filePath: string, size = 0): 'text' | 'notebook' | 'binary' {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.ipynb' && size <= MAX_COLLABORATIVE_DOCUMENT_BYTES) return 'notebook';
  if ((TEXT_BASENAMES.has(basename) || SAFE_ENV_TEMPLATES.has(basename))
    && size <= MAX_COLLABORATIVE_DOCUMENT_BYTES) return 'text';
  if (TEXT_EXTENSIONS.has(extension) && size <= MAX_COLLABORATIVE_DOCUMENT_BYTES
    && (extension !== '.csv' || size <= 10 * 1024 * 1024)) return 'text';
  return 'binary';
}

/** Decodes collaborative documents without silently replacing invalid bytes. */
export function decodeUtf8ProjectFile(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function loadCrdtProject(root: string, project: CollaborativeProject): Promise<ProjectFile[]> {
  const files = await scanProject(root);
  for (const file of files) {
    if (file.kind === 'text') {
      const decoded = decodeUtf8ProjectFile(await readFile(file.absolutePath));
      if (decoded === undefined) {
        file.kind = 'binary';
        continue;
      }
      project.ensureText(file.relativePath, decoded);
    } else if (file.kind === 'notebook') {
      const decoded = decodeUtf8ProjectFile(await readFile(file.absolutePath));
      if (decoded === undefined) {
        file.kind = 'binary';
        continue;
      }
      try {
        project.ensureNotebook(file.relativePath, parseIpynb(decoded));
      } catch {
        file.kind = 'binary';
      }
    }
  }
  return files;
}

/** Cell fields that Pair Notebook models explicitly; everything else is preserved verbatim. */
const KNOWN_CELL_FIELDS = new Set(['cell_type', 'id', 'metadata', 'source', 'outputs', 'execution_count', 'attachments']);
const KNOWN_NOTEBOOK_FIELDS = new Set(['cells', 'metadata', 'nbformat', 'nbformat_minor']);
/** Internal output metadata keys, never written back into nbformat output metadata. */
const INTERNAL_OUTPUT_METADATA = new Set(['outputType', 'executionCount', 'name', 'transient', 'pairNotebookBuffersBase64', 'pairNotebookRaw']);

export function parseIpynb(raw: string): NotebookSnapshot {
  if (Buffer.byteLength(raw, 'utf8') > MAX_COLLABORATIVE_DOCUMENT_BYTES) {
    throw new Error(`Notebook exceeds the ${MAX_COLLABORATIVE_DOCUMENT_BYTES}-byte parsing limit.`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Notebook root must be a JSON object.');
  }
  const notebook = parsed as Record<string, unknown> & {
    metadata?: Record<string, unknown>;
    cells?: Array<Record<string, unknown>>;
  };
  if (notebook.cells !== undefined && !Array.isArray(notebook.cells)) {
    throw new Error('Notebook cells must be an array.');
  }
  if ((notebook.cells?.length ?? 0) > MAX_NOTEBOOK_CELLS) {
    throw new Error(`Notebook exceeds the ${MAX_NOTEBOOK_CELLS}-cell limit.`);
  }
  const notebookExtra = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(notebook)) {
    if (!KNOWN_NOTEBOOK_FIELDS.has(key)) notebookExtra[key] = value;
  }
  const notebookMetadata = normalizeNotebookMetadata(notebook.metadata, {
    nbformat: typeof notebook.nbformat === 'number' ? notebook.nbformat : 4,
    nbformatMinor: typeof notebook.nbformat_minor === 'number' ? notebook.nbformat_minor : 5,
    extra: notebookExtra,
  });
  const seenCellIds = new Set<string>();
  return {
    metadata: notebookMetadata,
    cells: (notebook.cells ?? []).map((cell, index): CellSnapshot => {
      if (!isRecord(cell)) {
        throw new Error(`Notebook cell ${index + 1} must be a JSON object.`);
      }
      const rawCellType = typeof cell.cell_type === 'string' ? cell.cell_type : 'code';
      // VS Code notebooks know only Markup (1) and Code (2).  Raw and unknown
      // cell types are carried as markup plus a restoration marker so that a
      // round trip never rewrites them into executable code cells.
      const kind = rawCellType === 'code' ? 2 : 1;
      const metadata = { ...asObject(cell.metadata) };
      const candidates = [cell.id, metadata.pairNotebookCellId];
      let id = candidates.find((value): value is string => isPortableCellId(value) && !seenCellIds.has(value));
      if (!id) {
        do id = newId(); while (seenCellIds.has(id));
      }
      seenCellIds.add(id);
      const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
      const extra = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(cell)) {
        if (!KNOWN_CELL_FIELDS.has(key)) extra[key] = value;
      }
      const preserved: Record<string, unknown> = { cellType: rawCellType };
      if (cell.attachments && typeof cell.attachments === 'object') preserved.attachments = cell.attachments;
      if (Object.keys(extra).length) preserved.extra = extra;
      if (rawCellType !== 'code' && typeof cell.execution_count === 'number') {
        preserved.execution_count = cell.execution_count;
      }
      if (rawCellType !== 'code' && Array.isArray(cell.outputs) && cell.outputs.length) {
        preserved.outputs = cell.outputs;
      }
      metadata.pairNotebookNbformat = preserved;
      return {
        id,
        kind,
        language: kind === 1 ? 'markdown' : notebookLanguage(notebookMetadata),
        source,
        metadata,
        outputs: kind === 2 ? parseJupyterOutputs(cell.outputs) : [],
        execution: kind === 2 && typeof cell.execution_count === 'number' && Number.isFinite(cell.execution_count)
          ? { executionOrder: cell.execution_count }
          : undefined,
      };
    }),
  };
}

export function serializeIpynb(snapshot: NotebookSnapshot): Uint8Array {
  // VS Code's Jupyter serializer represents notebook metadata as
  // { custom: { cells, metadata, nbformat, nbformat_minor } }.  Older Pair
  // Notebook builds accidentally persisted that transport wrapper as actual
  // Jupyter metadata on every save, creating metadata.metadata... growth.
  // Normalize here as a final durability boundary so even an already damaged
  // CRDT snapshot is repaired rather than amplified.
  const normalizedMetadata = normalizeNotebookMetadata(snapshot.metadata);
  const language = notebookLanguage(normalizedMetadata);
  const cells = snapshot.cells.map((cell) => {
    const metadata = { ...cell.metadata };
    delete metadata.pairNotebookCellId;
    const preserved = asObject(metadata.pairNotebookNbformat);
    delete metadata.pairNotebookNbformat;
    const attachments = asObject(preserved.attachments);
    const extra = asObject(preserved.extra);
    const preservedType = typeof preserved.cellType === 'string' ? preserved.cellType : undefined;
    const cellType = preservedType && (cell.kind === 1 ? preservedType !== 'code' : preservedType === 'code')
      ? preservedType
      : cell.kind === 1 ? 'markdown' : 'code';
    if (cellType === 'code') {
      return {
        ...extra,
        cell_type: 'code',
        execution_count: cell.execution?.executionOrder ?? null,
        id: cell.id,
        metadata,
        outputs: serializeJupyterOutputs(cell.outputs),
        source: splitLines(cell.source),
        ...(Object.keys(attachments).length ? { attachments } : {}),
      };
    }
    return {
      ...extra,
      cell_type: cellType,
      id: cell.id,
      metadata,
      source: splitLines(cell.source),
      ...(Object.keys(attachments).length ? { attachments } : {}),
      ...(typeof preserved.execution_count === 'number' ? { execution_count: preserved.execution_count } : {}),
      ...(Array.isArray(preserved.outputs) ? { outputs: preserved.outputs } : {}),
    };
  });
  const notebookMetadata = { ...normalizedMetadata };
  const preservedNotebook = asObject(notebookMetadata.pairNotebookNbformat);
  delete notebookMetadata.pairNotebookNbformat;
  const notebookExtra = asObject(preservedNotebook.extra);
  const value = {
    ...notebookExtra,
    cells,
    metadata: {
      kernelspec: {
        display_name: `Python ${language === 'python' ? '3' : language}`,
        language,
        name: language === 'python' ? 'python3' : language,
      },
      language_info: { name: language },
      ...notebookMetadata,
    },
    nbformat: typeof preservedNotebook.nbformat === 'number' ? preservedNotebook.nbformat : 4,
    nbformat_minor: typeof preservedNotebook.nbformat_minor === 'number' ? preservedNotebook.nbformat_minor : 5,
  };
  return Buffer.from(`${JSON.stringify(value, null, 1)}\n`, 'utf8');
}

export interface NotebookMetadataFormat {
  nbformat: number;
  nbformatMinor: number;
  extra?: Record<string, unknown>;
}

/**
 * Converts canonical metadata, VS Code's Jupyter transport wrapper, or the
 * recursively wrapped output of Pair Notebook <= 0.2.0 into one bounded
 * canonical metadata object.
 */
export function normalizeNotebookMetadata(
  value: unknown,
  fallback: NotebookMetadataFormat = { nbformat: 4, nbformatMinor: 5 },
): Record<string, unknown> {
  let candidate = asObject(value);
  const existingMarker = asObject(candidate.pairNotebookNbformat);
  const wrappedCustom = asObject(candidate.custom);
  if (Object.keys(existingMarker).length
    && !isNotebookMetadataContainer(candidate)
    && !isNotebookMetadataContainer(wrappedCustom)) return { ...candidate };

  let nbformat = fallback.nbformat;
  let nbformatMinor = fallback.nbformatMinor;
  let extra = fallback.extra ?? {};
  if (isNotebookMetadataContainer(wrappedCustom)) candidate = wrappedCustom;

  // A small hard limit is defensive against hostile/deep JSON while still
  // repairing every realistic save loop. The innermost metadata is the actual
  // Jupyter metadata; wrapper fields are transport-only and are discarded.
  for (let depth = 0; depth < 512 && isNotebookMetadataContainer(candidate); depth += 1) {
    if (typeof candidate.nbformat === 'number') nbformat = candidate.nbformat;
    if (typeof candidate.nbformat_minor === 'number') nbformatMinor = candidate.nbformat_minor;
    const wrapperExtra = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(candidate)) {
      if (!KNOWN_NOTEBOOK_FIELDS.has(key) && key !== 'indentAmount' && key !== 'custom'
        && key !== 'kernelspec' && key !== 'language_info') wrapperExtra[key] = item;
    }
    if (Object.keys(wrapperExtra).length) extra = { ...extra, ...wrapperExtra };
    candidate = asObject(candidate.metadata);
  }

  const metadata = { ...candidate };
  delete metadata.custom;
  metadata.pairNotebookNbformat = {
    nbformat,
    nbformat_minor: nbformatMinor,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return metadata;
}

function isNotebookMetadataContainer(value: Record<string, unknown>): boolean {
  return Array.isArray(value.cells)
    && value.metadata !== null
    && typeof value.metadata === 'object'
    && (typeof value.nbformat === 'number' || typeof value.nbformat_minor === 'number');
}


function parseJupyterOutputs(value: unknown): OutputSnapshot[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CELL_OUTPUTS) {
    throw new Error(`Cell exceeds the ${MAX_CELL_OUTPUTS}-output limit.`);
  }
  let outputItems = 0;
  return value.map((output) => {
    const record = asObject(output);
    const outputType = String(record.output_type ?? 'display_data');
    if (outputType === 'stream') {
      const name = record.name === 'stderr' ? 'stderr' : 'stdout';
      return {
        metadata: { outputType, name },
        items: [{
          mime: name === 'stderr' ? 'application/vnd.code.notebook.stderr' : 'application/vnd.code.notebook.stdout',
          dataBase64: toBase64(joinText(record.text)),
        }],
      };
    }
    if (outputType === 'error') {
      const payload = JSON.stringify({
        name: String(record.ename ?? 'Error'),
        message: String(record.evalue ?? ''),
        stack: Array.isArray(record.traceback) ? record.traceback.join('\n') : '',
      });
      return {
        metadata: { outputType },
        items: [{ mime: 'application/vnd.code.notebook.error', dataBase64: toBase64(payload) }],
      };
    }
    const data = asObject(record.data);
    const entries = Object.entries(data);
    outputItems += entries.length;
    if (outputItems > MAX_OUTPUT_ITEMS_PER_CELL) {
      throw new Error(`Cell exceeds the ${MAX_OUTPUT_ITEMS_PER_CELL}-item output limit.`);
    }
    return {
      metadata: { ...asObject(record.metadata), outputType, executionCount: record.execution_count ?? null },
      items: entries.map(([mime, item]) => ({
        mime,
        dataBase64: isBase64Mime(mime) && typeof item === 'string'
          ? item.replace(/\s+/g, '')
          : toBase64(isJsonMime(mime)
            ? JSON.stringify(item)
            : typeof item === 'string'
              ? item
              : Array.isArray(item)
                ? item.join('')
                : JSON.stringify(item)),
      })),
    };
  });
}

function serializeJupyterOutputs(outputs: OutputSnapshot[]): unknown[] {
  return outputs.map((output) => {
    const rawOutputType = output.metadata?.outputType;
    const outputType = typeof rawOutputType === 'string' && JUPYTER_OUTPUT_TYPES.has(rawOutputType)
      ? rawOutputType
      : 'display_data';
    if (outputType === 'stream') {
      return {
        output_type: 'stream',
        name: output.metadata?.name === 'stderr' ? 'stderr' : 'stdout',
        text: splitLines(fromBase64(output.items[0]?.dataBase64 ?? '')),
      };
    }
    if (outputType === 'error') {
      const item = output.items.find((candidate) => candidate.mime === 'application/vnd.code.notebook.error');
      let error = { name: 'Error', message: '', stack: '' };
      try {
        const parsed = asObject(JSON.parse(fromBase64(item?.dataBase64 ?? '')));
        error = {
          name: typeof parsed.name === 'string' ? parsed.name : 'Error',
          message: typeof parsed.message === 'string' ? parsed.message : '',
          stack: typeof parsed.stack === 'string' ? parsed.stack : '',
        };
      } catch { /* preserve safe defaults */ }
      return {
        output_type: 'error',
        ename: error.name,
        evalue: error.message,
        traceback: error.stack ? error.stack.split('\n') : [],
      };
    }
    const data = Object.create(null) as Record<string, unknown>;
    for (const item of output.items) {
      if (isBase64Mime(item.mime)) {
        data[item.mime] = item.dataBase64;
        continue;
      }
      const text = fromBase64(item.dataBase64);
      if (isJsonMime(item.mime)) {
        try { data[item.mime] = JSON.parse(text); } catch { data[item.mime] = text; }
      } else data[item.mime] = splitLines(text);
    }
    const metadata = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(output.metadata ?? {})) {
      if (!INTERNAL_OUTPUT_METADATA.has(key)) metadata[key] = value;
    }
    return {
      output_type: outputType,
      data,
      metadata,
      ...(outputType === 'execute_result' ? {
        execution_count: Number.isSafeInteger(output.metadata?.executionCount)
          && Number(output.metadata?.executionCount) >= 0
          ? output.metadata?.executionCount
          : null,
      } : {}),
    };

  });
}

const JUPYTER_OUTPUT_TYPES = new Set([
  'display_data', 'update_display_data', 'execute_result', 'stream', 'error',
]);

function notebookLanguage(metadata: unknown): string {
  const value = asObject(metadata);
  const info = asObject(value.language_info);
  return typeof info.name === 'string' ? info.name : 'python';
}

function asObject(value: unknown): Record<string, any> {
  return isRecord(value)
    ? value as Record<string, any>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.match(/.*(?:\n|$)/g) ?? [];
  return lines.filter((line, index) => line || index < lines.length - 1);
}

function joinText(value: unknown): string {
  return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function fromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function isJsonMime(mime: string): boolean {
  return mime === 'application/json' || mime.endsWith('+json');
}

function isBase64Mime(mime: string): boolean {
  return mime === 'application/pdf'
    || mime === 'application/vnd.pair-notebook.jupyter-buffer'
    || /^image\/(?:png|jpe?g|gif|webp|bmp|tiff|avif|x-icon)$/i.test(mime);
}

function isPortableCellId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
