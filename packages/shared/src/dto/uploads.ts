import { z } from 'zod';
import { UPLOAD_STATUSES } from '../enums.ts';

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
