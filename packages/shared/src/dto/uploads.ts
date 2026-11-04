import { z } from 'zod';
import { UPLOAD_STATUSES } from '../enums.ts';
import { MBID_PATTERN } from './catalog.ts';

/**
 * tus clients must send chunks of at most this many bytes (DECISIONS rule 2: 50 MB, because
 * Cloudflare tunnels reject request bodies over 100 MB). The server answers 413 above it.
 * Clients should stay a little below (the web client uses 50 MiB minus a margin).
 */
export const MAX_UPLOAD_CHUNK_BYTES = 50 * 1024 * 1024;

/** Where the tus endpoint lives, relative to the origin. */
export const TUS_PATH = '/api/v1/uploads/tus';

/** Containers Hearer accepts (by file extension). `aif` is accepted when `aiff` is. */
export const UPLOAD_EXTENSIONS = [
  'flac',
  'mp3',
  'm4a',
  'ogg',
  'opus',
  'wav',
  'aiff',
  'aif',
] as const;

export const uploadStatusSchema = z.enum(UPLOAD_STATUSES);

export const uploadDtoSchema = z.object({
  id: z.string(),
  batchId: z.string().nullable(),
  /** The tus upload id (last segment of the tus URL) while it is in the tus temp dir. */
  tusId: z.string().nullable(),
  uploaderId: z.string(),
  uploaderName: z.string().nullable(),
  originalName: z.string(),
  size: z.number().int(),
  status: uploadStatusSchema,
  sha256: z.string().nullable(),
  /** ffprobe container, e.g. `flac`. */
  format: z.string().nullable(),
  codec: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  bitrate: z.number().int().nullable(),
  sampleRate: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  targetRequestId: z.string().nullable(),
  /** Why an upload was rejected or failed (or `cancelled`). */
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UploadDto = z.infer<typeof uploadDtoSchema>;

const flag = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

export const uploadListQuerySchema = z.object({
  /** Everyone's uploads. Requires MANAGE_UPLOADS. */
  all: flag.optional(),
  status: uploadStatusSchema.optional(),
  batchId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type UploadListQuery = z.infer<typeof uploadListQuerySchema>;

export const uploadListResponseSchema = z.object({
  items: z.array(uploadDtoSchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});
export type UploadListResponse = z.infer<typeof uploadListResponseSchema>;

export const uploadIdParamsSchema = z.object({ id: z.uuid() });

export const uploadQuotaSchema = z.object({
  /** Megabytes allowed per window; 0 means unlimited. */
  limitMb: z.number().int(),
  days: z.number().int(),
  usedBytes: z.number().int(),
  /** Bytes left in the window, or null when unlimited. */
  remainingBytes: z.number().int().nullable(),
  unlimited: z.boolean(),
});

export const uploadConfigSchema = z.object({
  tusPath: z.string(),
  /** Largest single PATCH body the server accepts. */
  maxChunkSizeBytes: z.number().int(),
  maxFileSizeMb: z.number().int(),
  allowedFormats: z.array(z.string()),
  quota: uploadQuotaSchema,
});
export type UploadConfig = z.infer<typeof uploadConfigSchema>;

// --- analysis, matching and review (H-14) ------------------------------------------------------

/**
 * A MusicBrainz id, lower-cased on input. Unlike `mbidSchema` this has no transform, so the same
 * schema can also describe API responses (zod cannot encode a transform).
 */
const mbidSchema = z.string().regex(MBID_PATTERN, 'must be a MusicBrainz id (UUID)').toLowerCase();

const optionalText = z.string().trim().max(500).nullish();
const positiveInt = z.number().int().min(1).max(9999);
/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
export const tagDateSchema = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/u, 'use YYYY or YYYY-MM-DD');

/** Where the cover image written into the file comes from. */
export const coverSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('caa'), releaseMbid: mbidSchema }),
  z.object({ type: z.literal('embedded') }),
]);
export type CoverSource = z.infer<typeof coverSourceSchema>;

/**
 * The final tags of an upload: what the review proposes, what the uploader may edit, and what
 * the import writes. MusicBrainz ids are mandatory: an upload is only filed once it is tied to
 * a recording and a release.
 */
export const tagSetSchema = z.object({
  title: z.string().trim().min(1).max(500),
  artist: z.string().trim().min(1).max(500),
  albumArtist: z.string().trim().min(1).max(500),
  album: z.string().trim().min(1).max(500),
  trackNumber: positiveInt,
  trackTotal: positiveInt,
  discNumber: positiveInt,
  discTotal: positiveInt,
  date: tagDateSchema.nullish(),
  genre: optionalText,
  mbRecordingId: mbidSchema,
  mbTrackId: mbidSchema.nullish(),
  mbReleaseId: mbidSchema,
  mbReleaseGroupId: mbidSchema,
  mbArtistId: mbidSchema,
  mbAlbumArtistId: mbidSchema,
  acoustId: z.string().trim().max(64).nullish(),
  isrc: z.string().trim().max(32).nullish(),
  compilation: z.boolean().nullish(),
  coverSource: coverSourceSchema.nullish(),
});
export type TagSet = z.infer<typeof tagSetSchema>;

/** How a candidate's score is made up; null where the evidence did not exist. */
export const scoreBreakdownSchema = z.object({
  acoustId: z.number().nullable(),
  title: z.number().nullable(),
  artist: z.number().nullable(),
  album: z.number().nullable(),
  duration: z.number().nullable(),
  track: z.number().nullable(),
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export const matchCandidateSchema = z.object({
  /** `<recordingMbid>@<releaseMbid>`; stable across re-ranking. */
  id: z.string(),
  recordingMbid: z.string(),
  releaseMbid: z.string(),
  releaseGroupMbid: z.string(),
  /** Every release group the recording appears on (at most 20), for album grouping. */
  releaseGroupMbids: z.array(z.string()),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  date: z.string().nullable(),
  trackNumber: z.number().int(),
  trackTotal: z.number().int(),
  discNumber: z.number().int(),
  discTotal: z.number().int(),
  lengthMs: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  /** 0..1, see docs/MATCHING.md. */
  score: z.number(),
  breakdown: scoreBreakdownSchema,
  sources: z.array(z.enum(['acoustid', 'tags'])),
  /** The tags this candidate would write (MusicBrainz data merged with the file's own tags). */
  tags: tagSetSchema,
});
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;

/** The tags read from the file itself, before any matching. */
export const existingTagsSchema = z.object({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  albumArtist: z.string().nullable(),
  album: z.string().nullable(),
  trackNumber: z.number().int().nullable(),
  trackTotal: z.number().int().nullable(),
  discNumber: z.number().int().nullable(),
  discTotal: z.number().int().nullable(),
  date: z.string().nullable(),
  genre: z.string().nullable(),
  isrc: z.string().nullable(),
  mbRecordingId: z.string().nullable(),
  mbReleaseId: z.string().nullable(),
  hasPicture: z.boolean(),
});
export type ExistingTags = z.infer<typeof existingTagsSchema>;

export const duplicateInfoSchema = z.object({
  kind: z.enum(['sha256', 'recording', 'fuzzy']),
  message: z.string(),
  /** The upload (sha256 kind) or library item that this file duplicates. */
  uploadId: z.string().nullable().optional(),
  libraryItemId: z.string().nullable().optional(),
});
export type DuplicateInfo = z.infer<typeof duplicateInfoSchema>;

export const albumGroupSchema = z.object({
  releaseMbid: z.string(),
  releaseGroupMbid: z.string(),
  title: z.string(),
  artist: z.string(),
  trackTotal: z.number().int(),
  /** Uploads that agreed on this release, with the track each one holds. */
  tracks: z.array(
    z.object({
      uploadId: z.string(),
      recordingMbid: z.string(),
      discNumber: z.number().int(),
      trackNumber: z.number().int(),
    }),
  ),
  /** Batch members that analysis finished for but that do not appear on this release. */
  unmatchedUploadIds: z.array(z.string()),
});
export type AlbumGroup = z.infer<typeof albumGroupSchema>;

/** `uploads.match_json`. */
export const matchResultSchema = z.object({
  version: z.literal(1),
  analyzedAt: z.string(),
  durationMs: z.number().int().nullable(),
  existingTags: existingTagsSchema,
  /** What the fingerprint lookup did. `disabled` means no AcoustID key is configured. */
  acoustId: z.object({
    status: z.enum(['matched', 'no_match', 'disabled', 'no_fingerprint', 'error']),
    message: z.string().nullable(),
  }),
  candidates: z.array(matchCandidateSchema),
  /** Set once the batch was grouped. */
  group: albumGroupSchema.nullable(),
  duplicate: duplicateInfoSchema.nullable(),
  /** Set when a reviewer kept a duplicate as an alternate version. */
  kept: z.object({ by: z.string(), reason: z.string().nullable(), at: z.string() }).nullable(),
  /** The candidate the reviewer picked (or the top one proposed). */
  chosenCandidateId: z.string().nullable(),
  /** The upload was approved automatically (uploader may auto-approve and the score was high enough). */
  autoApproved: z.boolean(),
  /** A reviewer edited the tags; re-ranking (album grouping) leaves them alone. */
  reviewed: z.boolean(),
  /** The `upload.needs_review` event was sent (or the upload was approved without review). */
  notified: z.boolean(),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

/** `GET /uploads/:id`: the upload plus what analysis found. */
export const uploadDetailSchema = uploadDtoSchema.extend({
  match: matchResultSchema.nullable(),
  chosen: tagSetSchema.nullable(),
  /** Whether the caller may use `POST /uploads/:id/keep` right now. */
  canKeep: z.boolean(),
});
export type UploadDetail = z.infer<typeof uploadDetailSchema>;

export const reviewBodySchema = z.object({
  tags: tagSetSchema,
  /** The candidate these tags were based on, if any. */
  candidateId: z.string().max(100).optional(),
  /** Fulfil this request. `null` clears an earlier link. */
  targetRequestId: z.uuid().nullable().optional(),
});
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(500) });
export const keepBodySchema = z.object({ reason: z.string().trim().max(500).optional() });
export const batchIdParamsSchema = z.object({ batchId: z.uuid() });
export const batchApproveResponseSchema = z.object({
  approved: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});
