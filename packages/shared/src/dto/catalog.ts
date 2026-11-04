import { z } from 'zod';
import { REQUEST_STATUSES } from '../enums.ts';

/** MusicBrainz ids are UUIDs (not always RFC 4122 variants, so no version check). */
export const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const mbidSchema = z
  .string()
  .regex(MBID_PATTERN, 'must be a MusicBrainz id (UUID)')
  .transform((value) => value.toLowerCase());

export const SEARCH_TYPES = ['artist', 'album', 'track'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const CATALOG_MAX_PAGE_SIZE = 50;
export const CATALOG_DEFAULT_PAGE_SIZE = 20;
/** MusicBrainz offsets beyond this are pointless for a UI and expensive for the server. */
export const MAX_OFFSET = 10_000;

/** Release-group primary types MusicBrainz can filter a browse by. */
export const RELEASE_GROUP_TYPES = ['album', 'single', 'ep', 'broadcast', 'other'] as const;
export type ReleaseGroupType = (typeof RELEASE_GROUP_TYPES)[number];

/** Is it in the media library? `possible` is a fuzzy (name-based) match, added by H-10. */
export const IN_LIBRARY_VALUES = ['yes', 'possible', 'no'] as const;
export const inLibrarySchema = z.enum(IN_LIBRARY_VALUES);
export type InLibrary = z.infer<typeof inLibrarySchema>;

export const requestBadgeSchema = z.object({
  id: z.string(),
  status: z.enum(REQUEST_STATUSES),
});
export type RequestBadge = z.infer<typeof requestBadgeSchema>;

/** Added by the API to every catalog item. The metadata provider itself never sets these. */
export const badgesSchema = z.object({
  inLibrary: inLibrarySchema,
  request: requestBadgeSchema.nullable(),
});
export type Badges = z.infer<typeof badgesSchema>;

export const artistCreditSchema = z.object({
  mbid: z.string().nullable(),
  name: z.string(),
  joinPhrase: z.string(),
});
export type ArtistCredit = z.infer<typeof artistCreditSchema>;

const dateString = z.string().nullable();

// --- artists ---------------------------------------------------------------------------------

export const artistBaseSchema = z.object({
  mbid: z.string(),
  name: z.string(),
  sortName: z.string(),
  type: z.string().nullable(),
  country: z.string().nullable(),
  disambiguation: z.string(),
  /** MusicBrainz search relevance 0-100; null outside search results. */
  score: z.number().nullable(),
});
export type ArtistBase = z.infer<typeof artistBaseSchema>;
export const artistSummarySchema = artistBaseSchema.extend(badgesSchema.shape);
export type ArtistSummary = z.infer<typeof artistSummarySchema>;

export const artistDetailBaseSchema = artistBaseSchema.extend({
  lifeSpan: z.object({ begin: dateString, end: dateString, ended: z.boolean() }).nullable(),
});
export type ArtistDetailBase = z.infer<typeof artistDetailBaseSchema>;
export const artistDetailSchema = artistDetailBaseSchema.extend(badgesSchema.shape);
export type ArtistDetail = z.infer<typeof artistDetailSchema>;

// --- release groups (albums) -----------------------------------------------------------------

export const releaseGroupBaseSchema = z.object({
  mbid: z.string(),
  title: z.string(),
  disambiguation: z.string(),
  primaryType: z.string().nullable(),
  secondaryTypes: z.array(z.string()),
  firstReleaseDate: dateString,
  artistCredit: z.array(artistCreditSchema),
  /** "Artist A feat. Artist B", the credit joined into display text. */
  artistName: z.string(),
  /** Cover Art Archive front image (250px); may 404 for releases without art. */
  coverUrl: z.string(),
  score: z.number().nullable(),
});
export type ReleaseGroupBase = z.infer<typeof releaseGroupBaseSchema>;
export const releaseGroupSummarySchema = releaseGroupBaseSchema.extend(badgesSchema.shape);
export type ReleaseGroupSummary = z.infer<typeof releaseGroupSummarySchema>;

export const releaseSummarySchema = z.object({
  mbid: z.string(),
  title: z.string(),
  date: dateString,
  country: z.string().nullable(),
  status: z.string().nullable(),
  /** Formats of every medium, joined (e.g. "CD + DVD-Video"). */
  format: z.string().nullable(),
  trackCount: z.number().int(),
});
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;

export const trackBaseSchema = z.object({
  /** MusicBrainz recording id (what requests and library matching key on). */
  mbid: z.string(),
  title: z.string(),
  discNumber: z.number().int(),
  position: z.number().int(),
  /** The printed track number ("A1", "3"), when it differs from position. */
  number: z.string().nullable(),
  lengthMs: z.number().int().nullable(),
  artistCredit: z.array(artistCreditSchema),
  artistName: z.string(),
  isrcs: z.array(z.string()),
});
export type TrackBase = z.infer<typeof trackBaseSchema>;
export const trackSchema = trackBaseSchema.extend(badgesSchema.shape);
export type Track = z.infer<typeof trackSchema>;

export const releaseGroupDetailBaseSchema = releaseGroupBaseSchema.extend({
  /** Up to 100 releases of the group. */
  releases: z.array(releaseSummarySchema),
  /** The release whose tracklist is shown (see the server's representative-release heuristic). */
  representativeRelease: releaseSummarySchema.nullable(),
  tracks: z.array(trackBaseSchema),
});
export type ReleaseGroupDetailBase = z.infer<typeof releaseGroupDetailBaseSchema>;
export const releaseGroupDetailSchema = releaseGroupDetailBaseSchema
  .omit({ tracks: true })
  .extend(badgesSchema.shape)
  .extend({ tracks: z.array(trackSchema) });
export type ReleaseGroupDetail = z.infer<typeof releaseGroupDetailSchema>;

// --- recordings (tracks) ---------------------------------------------------------------------

const releaseGroupRefSchema = z.object({
  mbid: z.string(),
  title: z.string(),
  primaryType: z.string().nullable(),
  coverUrl: z.string(),
});

export const recordingBaseSchema = z.object({
  mbid: z.string(),
  title: z.string(),
  disambiguation: z.string(),
  lengthMs: z.number().int().nullable(),
  artistCredit: z.array(artistCreditSchema),
  artistName: z.string(),
  /** The release group of the first release MusicBrainz lists (search and detail). */
  releaseGroup: releaseGroupRefSchema.nullable(),
  coverUrl: z.string().nullable(),
  firstReleaseDate: dateString,
  score: z.number().nullable(),
});
export type RecordingBase = z.infer<typeof recordingBaseSchema>;
export const recordingSummarySchema = recordingBaseSchema.extend(badgesSchema.shape);
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;

export const recordingDetailBaseSchema = recordingBaseSchema.extend({
  isrcs: z.array(z.string()),
  /** Every release group the recording appears on (deduplicated). */
  releaseGroups: z.array(releaseGroupBaseSchema),
});
export type RecordingDetailBase = z.infer<typeof recordingDetailBaseSchema>;
export const recordingDetailSchema = recordingDetailBaseSchema
  .omit({ releaseGroups: true })
  .extend(badgesSchema.shape)
  .extend({ releaseGroups: z.array(releaseGroupSummarySchema) });
export type RecordingDetail = z.infer<typeof recordingDetailSchema>;

// --- pages and queries -----------------------------------------------------------------------

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });
}
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export const pageQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CATALOG_MAX_PAGE_SIZE)
    .default(CATALOG_DEFAULT_PAGE_SIZE),
});

export const searchQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(200),
  type: z.enum(SEARCH_TYPES).default('album'),
});

export const artistAlbumsQuerySchema = pageQuerySchema.extend({
  type: z.enum(RELEASE_GROUP_TYPES).optional(),
});

export const searchResponseSchema = z.discriminatedUnion('type', [
  pageSchema(artistSummarySchema).extend({ type: z.literal('artist') }),
  pageSchema(releaseGroupSummarySchema).extend({ type: z.literal('album') }),
  pageSchema(recordingSummarySchema).extend({ type: z.literal('track') }),
]);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
