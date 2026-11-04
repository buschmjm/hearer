import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Thrown when a path would leave the directory it must stay inside. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

export const FALLBACK_FILE_NAME = 'untitled';
export const DEFAULT_MAX_NAME_BYTES = 200;

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Control characters (C0, DEL, C1), zero-width and bidi controls, the BOM, and line/paragraph separators.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;
const RESERVED_CHARS = /[<>:"/\\|?*]/g;
const MAX_EXTENSION_CHARS = 16;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** Cut `value` to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

const trimEdges = (value: string): string => value.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');

/**
 * Turn an untrusted file name into a single safe path segment.
 *
 *  - Unicode is normalised with NFKC first, so look-alikes such as the fullwidth `．．／` become
 *    their ASCII forms and are then neutralised like the real thing.
 *  - Only the last segment survives: everything before the final `/` or `\` is dropped.
 *  - Control, zero-width and bidi-override characters are removed; the Windows-reserved
 *    characters `<>:"/\|?*` become `_`; runs of dots collapse to one, so `..` cannot appear.
 *  - Leading dots/spaces and trailing dots/spaces are removed.
 *  - Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or without an extension,
 *    get a `_` prefix.
 *  - The result is at most `maxBytes` of UTF-8 (never split mid-character), keeping the extension.
 *  - An empty result becomes `untitled`.
 */
export function sanitizeFileName(input: string, maxBytes = DEFAULT_MAX_NAME_BYTES): string {
  const segments = input.normalize('NFKC').replace(INVISIBLE, '').split(/[/\\]/u);
  // The last non-empty segment: "a/b/" names "b"; "..\\.." and "" name nothing.
  const last = segments.findLast((segment) => segment.trim() !== '') ?? '';
  let name = trimEdges(last.replace(RESERVED_CHARS, '_').replace(/\.{2,}/g, '.'));
  // Dots only appear after the earlier collapse as single separators, but a name like "._." can remain.
  name = trimEdges(name);
  if (name === '') return FALLBACK_FILE_NAME;

  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && name.length - dot - 1 <= MAX_EXTENSION_CHARS;
  let stem = hasExtension ? name.slice(0, dot) : name;
  let extension = hasExtension ? name.slice(dot) : '';
  // Windows decides on the part before the FIRST dot ("con.tar.gz" is still the console).
  const firstSegment = stem.split('.')[0] ?? stem;
  if (WINDOWS_RESERVED.test(firstSegment.trim())) stem = `_${stem}`;

  if (byteLength(stem) + byteLength(extension) > maxBytes) {
    if (byteLength(extension) > maxBytes / 2) extension = truncateBytes(extension, maxBytes / 2);
    stem = truncateBytes(stem, maxBytes - byteLength(extension));
  }
  stem = stem.replace(/[\s.]+$/u, '');
  const result = `${stem}${extension}`;
  return result === '' || result === extension ? `${FALLBACK_FILE_NAME}${extension}` : result;
}

/** The deepest existing ancestor of `target` resolved through symlinks, plus the missing tail. */
function realpathOfExistingPrefix(target: string): string {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(existing);
      if (parent === existing) return target;
      tail.unshift(existing.slice(parent.length).replace(/^[/\\]+/u, ''));
      existing = parent;
    }
  }
}

export interface AssertInsideOptions {
  /** Allow `candidate` to be `root` itself. Default false. */
  allowRoot?: boolean;
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and require it to stay inside `root`.
 * Symlinks are resolved on the longest part of the path that exists, so a link pointing out of
 * `root` is caught even when the file below it does not exist yet. The comparison is by path
 * segment (`/data/staging-evil` is not inside `/data/staging`). Returns the resolved real path.
 */
export function assertInside(
  root: string,
  candidate: string,
  options: AssertInsideOptions = {},
): string {
  if (root.includes('\0') || candidate.includes('\0')) {
    throw new PathEscapeError('path contains a NUL byte');
  }
  const realRoot = realpathOfExistingPrefix(resolve(root));
  const real = realpathOfExistingPrefix(resolve(root, candidate));
  const rel = relative(realRoot, real);
  if (rel === '') {
    if (options.allowRoot === true) return real;
    throw new PathEscapeError('path is the root itself');
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError('path escapes the allowed directory');
  }
  return real;
}
