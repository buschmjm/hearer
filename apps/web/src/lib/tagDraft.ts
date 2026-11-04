import { tagSetSchema, type CoverSource, type ExistingTags, type TagSet } from '@hearer/shared';
import type { TemplateSample } from './template.ts';

/** The tag editor's form state: everything as text, converted and validated on demand. */
export interface TagDraft {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  trackNumber: string;
  trackTotal: string;
  discNumber: string;
  discTotal: string;
  date: string;
  genre: string;
  isrc: string;
  acoustId: string;
  compilation: boolean;
  mbRecordingId: string;
  mbTrackId: string;
  mbReleaseId: string;
  mbReleaseGroupId: string;
  mbArtistId: string;
  mbAlbumArtistId: string;
  coverSource: CoverSource | null;
}

export type TagField = Exclude<keyof TagDraft, 'coverSource' | 'compilation'>;

const num = (value: number | null | undefined, fallback = 1): string => String(value ?? fallback);

/** Draft from a stored tag set, or from what the file itself carries when nothing is stored. */
export function draftFromTags(tags: TagSet | null, existing?: ExistingTags | null): TagDraft {
  if (tags) {
    return {
      title: tags.title,
      artist: tags.artist,
      albumArtist: tags.albumArtist,
      album: tags.album,
      trackNumber: num(tags.trackNumber),
      trackTotal: num(tags.trackTotal),
      discNumber: num(tags.discNumber),
      discTotal: num(tags.discTotal),
      date: tags.date ?? '',
      genre: tags.genre ?? '',
      isrc: tags.isrc ?? '',
      acoustId: tags.acoustId ?? '',
      compilation: tags.compilation ?? false,
      mbRecordingId: tags.mbRecordingId,
      mbTrackId: tags.mbTrackId ?? '',
      mbReleaseId: tags.mbReleaseId,
      mbReleaseGroupId: tags.mbReleaseGroupId,
      mbArtistId: tags.mbArtistId,
      mbAlbumArtistId: tags.mbAlbumArtistId,
      coverSource: tags.coverSource ?? null,
    };
  }
  return {
    title: existing?.title ?? '',
    artist: existing?.artist ?? '',
    albumArtist: existing?.albumArtist ?? existing?.artist ?? '',
    album: existing?.album ?? '',
    trackNumber: num(existing?.trackNumber),
    trackTotal: num(existing?.trackTotal),
    discNumber: num(existing?.discNumber),
    discTotal: num(existing?.discTotal),
    date: existing?.date ?? '',
    genre: existing?.genre ?? '',
    isrc: existing?.isrc ?? '',
    acoustId: '',
    compilation: false,
    mbRecordingId: existing?.mbRecordingId ?? '',
    mbTrackId: '',
    mbReleaseId: existing?.mbReleaseId ?? '',
    mbReleaseGroupId: '',
    mbArtistId: '',
    mbAlbumArtistId: '',
    coverSource: null,
  };
}

const NUMBER_FIELDS = ['trackNumber', 'trackTotal', 'discNumber', 'discTotal'] as const;
const NULLABLE_TEXT = ['date', 'genre', 'isrc', 'acoustId', 'mbTrackId'] as const;

export type ParsedDraft =
  { ok: true; tags: TagSet } | { ok: false; errors: Partial<Record<keyof TagDraft, string>> };

/** Validate with the shared `tagSetSchema` (the same rules the server applies). */
export function parseDraft(draft: TagDraft): ParsedDraft {
  const input: Record<string, unknown> = { ...draft };
  const errors: Partial<Record<keyof TagDraft, string>> = {};
  for (const field of NUMBER_FIELDS) {
    const raw = draft[field].trim();
    if (raw === '') input[field] = undefined;
    else if (!/^\d+$/u.test(raw)) {
      errors[field] = 'Use a whole number';
      input[field] = undefined;
    } else input[field] = Number(raw);
  }
  for (const field of NULLABLE_TEXT) {
    input[field] = draft[field].trim() === '' ? null : draft[field];
  }
  const result = tagSetSchema.safeParse(input);
  if (result.success && Object.keys(errors).length === 0) return { ok: true, tags: result.data };
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string' || field in errors) continue;
      errors[field as keyof TagDraft] = friendlyIssue(issue);
    }
  }
  return { ok: false, errors };
}

function friendlyIssue(issue: { code: string; message: string }): string {
  if (issue.code === 'too_small' && issue.message.includes('character')) return 'Required';
  if (issue.code === 'invalid_type') return 'Required';
  if (issue.code === 'too_small' || issue.code === 'too_big') return 'Use a number from 1 to 9999';
  return issue.message;
}

export function draftsEqual(a: TagDraft, b: TagDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Where a draft's cover comes from, as an image address (the CSP allows the archive hosts). */
export function coverUrlFor(source: CoverSource | null): string | null {
  return source?.type === 'caa'
    ? `https://coverartarchive.org/release/${source.releaseMbid}/front-250`
    : null;
}

/** Sample values for the destination preview. */
export function sampleFromDraft(draft: TagDraft, ext: string): TemplateSample {
  const n = (s: string, fallback: number): number => {
    const v = Number(s);
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  return {
    artist: draft.artist || 'Unknown Artist',
    albumartist: draft.albumArtist || draft.artist || 'Unknown Artist',
    album: draft.album || 'Unknown Album',
    year: /^\d{4}/u.test(draft.date) ? draft.date.slice(0, 4) : '',
    disc: n(draft.discNumber, 1),
    discCount: n(draft.discTotal, 1),
    track: n(draft.trackNumber, 1),
    title: draft.title || 'Unknown',
    ext,
    genre: draft.genre,
    date: draft.date,
    mbrecording: draft.mbRecordingId,
    mbtrack: draft.mbTrackId,
    mbrelease: draft.mbReleaseId,
    mbreleasegroup: draft.mbReleaseGroupId,
    mbartist: draft.mbArtistId,
    mbalbumartist: draft.mbAlbumArtistId,
    acoustid: draft.acoustId,
  };
}
