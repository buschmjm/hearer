/**
 * Render a library path from a template (`library.namingTemplate` / `library.singlesTemplate`).
 *
 * Variables are listed in `@hearer/shared` (`validateNamingTemplate`): albumartist (falls back to
 * artist), artist, album, title, ext, genre, date, year, disc, `disc:?`, track (`track:02`) and
 * the MusicBrainz ids. `{disc:?}` renders "<disc>-" only when the release has more than one disc,
 * which is what the setup wizard's preview shows too.
 *
 * Rules:
 *  - Segments: a literal `/` in the TEMPLATE separates folders. Slashes (and backslashes) inside
 *    VALUES are replaced with `_` first, so "AC/DC" becomes the single folder "AC_DC" and a tag
 *    such as "../../etc/passwd" can never add or remove a level.
 *  - Every segment goes through `sanitizeFileName` (NFKC, control characters, Windows-reserved
 *    characters and device names, dot runs, length limit).
 *  - A segment whose values are all empty gets a fallback: "Unknown Artist" when it used an
 *    artist variable, "Unknown Album" for album, else "Unknown". Empty brackets left by a missing
 *    value ("Album ()" without a year) are removed.
 *  - Singles: `singlesTemplate` is used instead of `namingTemplate` when the file has no album
 *    (blank album tag) or its release group is a MusicBrainz "Single". See `useSinglesTemplate`.
 *  - The caller joins the result to MUSIC_DIR and must pass it through `assertInside`.
 */
import { lstat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { TEMPLATE_TOKEN, type TagSet } from '@hearer/shared';
import { sha256File } from './atomicMove.ts';
import { FALLBACK_FILE_NAME, assertInside, sanitizeFileName } from './paths.ts';

export interface TemplateValues {
  albumartist: string;
  artist: string;
  album: string;
  title: string;
  /** Lower-case extension without the dot. */
  ext: string;
  genre: string;
  date: string;
  year: string;
  disc: number;
  discTotal: number;
  track: number;
  mbrecording: string;
  mbtrack: string;
  mbrelease: string;
  mbreleasegroup: string;
  mbartist: string;
  mbalbumartist: string;
  acoustid: string;
}

/** Template values for a file with these tags. */
export function valuesFromTags(tags: TagSet, ext: string): TemplateValues {
  const date = tags.date ?? '';
  return {
    albumartist: tags.albumArtist || tags.artist,
    artist: tags.artist,
    album: tags.album,
    title: tags.title,
    ext: ext.toLowerCase().replace(/[^a-z0-9]/gu, ''),
    genre: tags.genre ?? '',
    date,
    year: /^\d{4}/u.exec(date)?.[0] ?? '',
    disc: tags.discNumber,
    discTotal: tags.discTotal,
    track: tags.trackNumber,
    mbrecording: tags.mbRecordingId,
    mbtrack: tags.mbTrackId ?? '',
    mbrelease: tags.mbReleaseId,
    mbreleasegroup: tags.mbReleaseGroupId,
    mbartist: tags.mbArtistId,
    mbalbumartist: tags.mbAlbumArtistId,
    acoustid: tags.acoustId ?? '',
  };
}

/**
 * Whether the singles template applies: the album tag is blank, or MusicBrainz says the release
 * group is a Single (`releaseGroupType`, looked up by the caller when it can).
 */
export function useSinglesTemplate(tags: TagSet, releaseGroupType: string | null): boolean {
  return tags.album.trim() === '' || releaseGroupType?.toLowerCase() === 'single';
}

const ARTIST_VARS = new Set(['albumartist', 'artist']);
const EMPTY_BRACKETS = /\s*(?:\(\s*\)|\[\s*\]|\{\s*\})/gu;

const textValue = (values: TemplateValues, name: keyof TemplateValues): string => {
  const value = values[name];
  return typeof value === 'string' ? value : String(value);
};

function renderSegment(segment: string, values: TemplateValues): string {
  const used: string[] = [];
  const rendered = segment
    .replace(TEMPLATE_TOKEN, (_whole, name: string, spec: string | undefined) => {
      used.push(name);
      if (name === 'disc' && spec === '?') {
        return values.discTotal > 1 ? `${String(values.disc)}-` : '';
      }
      if (name === 'disc' || name === 'track') {
        const width = spec === undefined ? 0 : Number(spec);
        return String(values[name]).padStart(Number.isNaN(width) ? 0 : width, '0');
      }
      if (!Object.hasOwn(values, name)) throw new Error(`Unknown template variable {${name}}`);
      // Slashes in a value must not create folders: replace them before anything splits on them.
      // NFKC first, so a fullwidth slash (which sanitizeFileName would fold into a real one) goes too.
      return textValue(values, name as keyof TemplateValues)
        .normalize('NFKC')
        .replace(/[/\\]/gu, '_');
    })
    .replace(EMPTY_BRACKETS, '')
    .trim();
  const clean = rendered === '' ? FALLBACK_FILE_NAME : sanitizeFileName(rendered);
  // Nothing usable survived (empty, or only dots/separators): name the segment by what it held.
  if (clean !== FALLBACK_FILE_NAME || rendered.toLowerCase() === FALLBACK_FILE_NAME) return clean;
  if (used.some((name) => ARTIST_VARS.has(name))) return 'Unknown Artist';
  if (used.includes('album')) return 'Unknown Album';
  return 'Unknown';
}

/**
 * The relative library path (`/`-separated, no leading slash). Empty literal segments are
 * dropped. Throws if the template produces no file name.
 */
export function renderLibraryPath(template: string, values: TemplateValues): string {
  const segments = template
    .split('/')
    .filter((segment) => segment.trim() !== '')
    .map((segment) => renderSegment(segment, values));
  if (segments.length === 0) throw new Error('The path template renders an empty path');
  return segments.join('/');
}

// --- collision handling -----------------------------------------------------------------------

/** `Name.ext` -> `Name (2).ext`. */
export function withCollisionSuffix(path: string, n: number): string {
  if (n <= 1) return path;
  const ext = extname(path);
  const stem = basename(path, ext);
  return join(dirname(path), `${stem} (${String(n)})${ext}`);
}

export interface ResolvedDestination {
  /** Absolute path, verified inside the library root. */
  path: string;
  /** A file with identical content is already there (nothing to move). */
  identical: boolean;
}

export const MAX_COLLISIONS = 999;

/**
 * Pick the destination for a file with this size and sha256: the rendered path if it is free, the
 * same path if a byte-identical file is already there, else " (2)", " (3)" ... before the
 * extension. Never returns a path occupied by different content, and every candidate is checked
 * to stay inside `root`.
 */
export async function resolveDestination(
  root: string,
  relativePath: string,
  file: { size: number; sha256: string },
  hashOf: (path: string) => Promise<string> = sha256File,
): Promise<ResolvedDestination> {
  const base = join(root, relativePath);
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const candidate = assertInside(root, withCollisionSuffix(base, n));
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return { path: candidate, identical: false };
      throw err;
    }
    if (stats.isFile() && stats.size === file.size && (await hashOf(candidate)) === file.sha256) {
      return { path: candidate, identical: true };
    }
  }
  throw new Error(`No free file name under ${relativePath} after ${String(MAX_COLLISIONS)} tries`);
}
