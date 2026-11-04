import { parseFile } from 'music-metadata';
import type { ExistingTags } from '@hearer/shared';

const DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/u;

const clean = (value: string | undefined | null): string | null => {
  const trimmed = value?.replace(/\0/gu, '').trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

/** Keep only `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (tags in the wild hold timestamps and junk). */
export function toTagDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const head = /^\d{4}(-\d{2}(-\d{2})?)?/u.exec(text)?.[0];
  return head && DATE_PATTERN.test(head) ? head : null;
}

const positive = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;

/**
 * Read the tags already inside an audio file (title, artist, album, numbering, MusicBrainz ids,
 * whether a picture is embedded). A file `music-metadata` cannot parse gives an empty result, so
 * an untagged or oddly tagged file is simply matched by fingerprint alone.
 */
export async function readExistingTags(path: string): Promise<ExistingTags> {
  try {
    const { common } = await parseFile(path, { duration: false, skipPostHeaders: true });
    return {
      title: clean(common.title),
      artist: clean(common.artist),
      albumArtist: clean(common.albumartist),
      album: clean(common.album),
      trackNumber: positive(common.track.no),
      trackTotal: positive(common.track.of),
      discNumber: positive(common.disk.no),
      discTotal: positive(common.disk.of),
      date: toTagDate(common.date) ?? toTagDate(common.year),
      genre: clean(common.genre?.[0]),
      isrc: clean(common.isrc?.[0]),
      mbRecordingId: clean(common.musicbrainz_recordingid)?.toLowerCase() ?? null,
      mbReleaseId: clean(common.musicbrainz_albumid)?.toLowerCase() ?? null,
      hasPicture: (common.picture?.length ?? 0) > 0,
    };
  } catch {
    return emptyTags();
  }
}

export function emptyTags(): ExistingTags {
  return {
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    trackNumber: null,
    trackTotal: null,
    discNumber: null,
    discTotal: null,
    date: null,
    genre: null,
    isrc: null,
    mbRecordingId: null,
    mbReleaseId: null,
    hasPicture: false,
  };
}
