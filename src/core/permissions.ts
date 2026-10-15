import { portableRelativePath } from './projectPath';

export interface ParticipantPermissions {
  edit: 'all' | 'selected' | 'none';
  /** Exact project file paths; a trailing slash grants a complete directory. */
  paths: string[];
  execute: boolean;
  terminal: 'none' | 'read' | 'write';
  comment: boolean;
}

export function defaultPermissions(readOnly = false): ParticipantPermissions {
  return { edit: readOnly ? 'none' : 'all', paths: [], execute: !readOnly, terminal: 'read', comment: !readOnly };
}

export function normalizePermissions(value: unknown): ParticipantPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid participant permissions.');
  const raw = value as ParticipantPermissions;
  if (!['all', 'selected', 'none'].includes(raw.edit) || !['none', 'read', 'write'].includes(raw.terminal)
    || typeof raw.execute !== 'boolean' || typeof raw.comment !== 'boolean' || !Array.isArray(raw.paths) || raw.paths.length > 4096) throw new Error('Invalid participant permissions.');
  const paths = raw.paths.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 1024) throw new Error('Invalid permitted project path.');
    const directory = entry.endsWith('/');
    const name = directory ? entry.slice(0, -1) : entry;
    const normalized = portableRelativePath(name);
    if (!normalized || normalized !== name) throw new Error('Use exact relative file paths or directories ending in /.');
    return normalized + (directory ? '/' : '');
  });
  return { edit: raw.edit, paths: [...new Set(paths)].sort(), execute: raw.execute, terminal: raw.terminal, comment: raw.comment };
}

export function mayEdit(permissions: ParticipantPermissions, filename: string): boolean {
  if (!portableRelativePath(filename)) return false;
  return permissions.edit === 'all' || (permissions.edit === 'selected'
    && permissions.paths.some((rule) => rule.endsWith('/') ? filename === rule.slice(0, -1) || filename.startsWith(rule) : filename === rule));
}

/** Directory operations must also authorize every affected child and destination. */
export function mayChangeTree(permissions: ParticipantPermissions, filename: string, entries: Iterable<string>, destination?: string): boolean {
  if (!mayEdit(permissions, filename) || (destination !== undefined && !mayEdit(permissions, destination))) return false;
  for (const entry of entries) if (entry === filename || entry.startsWith(filename + '/')) {
    if (!mayEdit(permissions, entry) || (destination !== undefined && !mayEdit(permissions, destination + entry.slice(filename.length)))) return false;
  }
  return true;
}
