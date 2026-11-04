import { z } from 'zod';
import { REQUEST_STATUSES, REQUEST_TYPES } from '../enums.ts';
import { mbidSchema, pageSchema } from './catalog.ts';

/** Maximum length of a decline reason (and of timeline notes written from user input). */
export const DECLINE_REASON_MAX = 500;
export const REQUEST_LIST_MAX_PAGE_SIZE = 100;

export const createRequestBodySchema = z.object({
  type: z.enum(REQUEST_TYPES),
  mbid: mbidSchema,
});
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

export const declineRequestBodySchema = z.object({
  reason: z.string().trim().min(1).max(DECLINE_REASON_MAX),
});
export type DeclineRequestBody = z.infer<typeof declineRequestBodySchema>;

/** Display info for the person behind a request or a timeline entry. */
export const requestUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatar: z.string().nullable(),
});
export type RequestUser = z.infer<typeof requestUserSchema>;

export const requestDtoSchema = z.object({
  id: z.string(),
  type: z.enum(REQUEST_TYPES),
  mbid: z.string(),
  /** Tracks: the release group the recording belongs to (album-level providers act on it). */
  parentMbid: z.string().nullable(),
  title: z.string(),
  artistName: z.string().nullable(),
  coverUrl: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  requestedBy: requestUserSchema.nullable(),
  decidedBy: requestUserSchema.nullable(),
  decidedAt: z.string().nullable(),
  declineReason: z.string().nullable(),
  /** Which fulfillment provider took the request (e.g. `manual`, `lidarr`). */
  providerId: z.string().nullable(),
  fulfilledByUploadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RequestDto = z.infer<typeof requestDtoSchema>;

export const requestEventDtoSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  /** null = the system (jobs, availability sync). */
  actor: requestUserSchema.nullable(),
  fromStatus: z.enum(REQUEST_STATUSES).nullable(),
  toStatus: z.enum(REQUEST_STATUSES),
  note: z.string().nullable(),
});
export type RequestEventDto = z.infer<typeof requestEventDtoSchema>;

export const requestDetailDtoSchema = requestDtoSchema.extend({
  events: z.array(requestEventDtoSchema),
});
export type RequestDetailDto = z.infer<typeof requestDetailDtoSchema>;

const flag = z
  .enum(['1', '0', 'true', 'false'])
  .transform((value) => value === '1' || value === 'true');

/** A status list: `?status=PENDING` or `?status=PENDING,APPROVED`. */
const statusFilter = z
  .string()
  .transform((value) => value.split(',').filter(Boolean))
  .pipe(z.array(z.enum(REQUEST_STATUSES)).min(1).max(REQUEST_STATUSES.length));

export const requestListQuerySchema = z.object({
  /** Everyone's requests (needs VIEW_ALL_REQUESTS or MANAGE_REQUESTS). */
  all: flag.default(false),
  status: statusFilter.optional(),
  type: z.enum(REQUEST_TYPES).optional(),
  requestedBy: z.string().min(1).max(64).optional(),
  sort: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(REQUEST_LIST_MAX_PAGE_SIZE).default(25),
});
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;

export const requestListResponseSchema = pageSchema(requestDtoSchema);
export type RequestListResponse = z.infer<typeof requestListResponseSchema>;

export const requestCountsQuerySchema = z.object({ all: flag.default(false) });

/** Requests per status, for the badges in the UI. Every status is present (0 when empty). */
export const requestCountsSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.enum(REQUEST_STATUSES), z.number().int()),
});
export type RequestCounts = z.infer<typeof requestCountsSchema>;

export const requestQuotaSchema = z.object({
  /** Requests allowed per window; 0 = unlimited. */
  limit: z.number().int(),
  days: z.number().int(),
  used: z.number().int(),
  /** null when unlimited. */
  remaining: z.number().int().nullable(),
  unlimited: z.boolean(),
  /** When the oldest counted request leaves the window (ISO), or null when nothing is counted. */
  resetsAt: z.string().nullable(),
});
export type RequestQuota = z.infer<typeof requestQuotaSchema>;

/** Body of a 429 `quota_exceeded` error (`error.details`). */
export const quotaExceededDetailsSchema = z.object({
  limit: z.number().int(),
  used: z.number().int(),
  resetsAt: z.string().nullable(),
});
export type QuotaExceededDetails = z.infer<typeof quotaExceededDetailsSchema>;
