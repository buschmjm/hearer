import { z } from 'zod';
import { JOB_STATUSES } from '../enums.ts';

export const jobStatusSchema = z.enum(JOB_STATUSES);

/** A background job as the admin API shows it. Secret-looking payload fields are redacted. */
export const jobDtoSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: jobStatusSchema,
  priority: z.number().int(),
  uniqueKey: z.string().nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  /** ISO timestamps. */
  runAfter: z.string(),
  lockedBy: z.string().nullable(),
  lockedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  payload: z.unknown(),
});
export type JobDto = z.infer<typeof jobDtoSchema>;

export const jobListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: jobStatusSchema.optional(),
  type: z.string().trim().min(1).max(100).optional(),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobListResponseSchema = z.object({
  items: z.array(jobDtoSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

export const jobSummarySchema = z.object({
  /** Job counts by type, then status (statuses with no jobs are omitted). */
  counts: z.array(z.object({ type: z.string(), status: jobStatusSchema, count: z.number().int() })),
  /** Totals per status across all types. */
  totals: z.record(z.string(), z.number().int()),
  schedules: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      /** ISO time of the next run; null while the worker is not running. */
      nextRunAt: z.string().nullable(),
      everyMs: z.number().int().nullable(),
    }),
  ),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;
