import path from 'node:path';

const UNSAFE_PATH_FORMAT_CHARACTERS = /[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

/**
 * Returns one safe native relative path that has identical file semantics on
 * Windows, macOS, and Linux. Pair Notebook deliberately excludes ambiguous
 * Windows device/ADS names even when the current host uses another platform.
 */
export function safeRelativePath(relativePath: string): string {
  if (!relativePath || Buffer.byteLength(relativePath, 'utf8') > 4096
    || hasControlCharacters(relativePath) || path.isAbsolute(relativePath) || /^[/\\]/.test(relativePath)
    || (path.sep === '/' && relativePath.includes('\\'))) {
    throw new Error('Unsafe project-relative path.');
  }
  const sourceSegments = relativePath.split(/[\\/]/);
  if (sourceSegments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Unsafe project-relative path.');
  }
  const normalized = path.normalize(relativePath);
  if (!normalized || normalized === '.' || normalized === '..'
    || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error('Unsafe project-relative path.');
  }
  if (normalized.split(path.sep).some((segment) => !isPortablePathSegment(segment))) {
    throw new Error('Unsafe project-relative path.');
  }
  return normalized;
}

export function portableRelativePath(relativePath: string): string | undefined {
  try {
    return safeRelativePath(relativePath).split(path.sep).join('/');
  } catch {
    return undefined;
  }
}

/**
 * Comparison key for paths exchanged between different operating systems.
 * Canonically equivalent Unicode spellings collide on default macOS volumes,
 * just as differently-cased spellings collide on Windows and macOS.
 */
export function portablePathComparisonKey(relativePath: string): string {
  return portableCaseFold(safeRelativePath(relativePath)
    .split(path.sep)
    .join('/')
    .normalize('NFC'));
}

/** Comparison key for absolute paths on the current platform. */
export function filesystemPathComparisonKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? portableCaseFold(resolved.normalize('NFC'))
    : resolved;
}

/** True when one distinct portable path is contained below the other. */
export function relativePathsNested(left: string, right: string): boolean {
  const first = portablePathComparisonKey(left);
  const second = portablePathComparisonKey(right);
  return first !== second && (first.startsWith(`${second}/`) || second.startsWith(`${first}/`));
}

function isPortablePathSegment(segment: string): boolean {
  if (!segment || Buffer.byteLength(segment, 'utf8') > 255
    || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
}

function hasControlCharacters(value: string): boolean {
  return UNSAFE_PATH_FORMAT_CHARACTERS.test(value) || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function portableCaseFold(value: string): string {
  // The upper-then-lower expansion catches important full case-fold pairs
  // such as "ß"/"SS" and "ς"/"σ" that lowercase alone misses.
  return value.toLocaleUpperCase('en-US').toLocaleLowerCase('en-US');
}
