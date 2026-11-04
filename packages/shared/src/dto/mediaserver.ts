import { z } from 'zod';
import { userDtoSchema } from './users.ts';

/** What `testConnection` learned about the media server. */
export const mediaServerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  /** False for Jellyfin older than 10.10 (the modern auth header may be missing). */
  versionSupported: z.boolean(),
  warning: z.string().optional(),
});
export type MediaServerInfoDto = z.infer<typeof mediaServerInfoSchema>;

/** Result of `POST /settings/mediaServer/test`: always 200, `ok` says whether it worked. */
export const mediaServerTestResultSchema = z.object({
  ok: z.boolean(),
  server: mediaServerInfoSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type MediaServerTestResult = z.infer<typeof mediaServerTestResultSchema>;

export const jellyfinImportCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  isDisabled: z.boolean(),
  /** The Hearer user id when this Jellyfin user already has an account. */
  importedUserId: z.string().nullable(),
});
export type JellyfinImportCandidate = z.infer<typeof jellyfinImportCandidateSchema>;

export const jellyfinImportRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).min(1).max(500),
});
export type JellyfinImportRequest = z.infer<typeof jellyfinImportRequestSchema>;

export const jellyfinImportResultSchema = z.object({
  imported: z.array(userDtoSchema),
  skipped: z.array(
    z.object({
      id: z.string(),
      reason: z.enum(['already_imported', 'not_found', 'disabled']),
    }),
  ),
});
export type JellyfinImportResult = z.infer<typeof jellyfinImportResultSchema>;
