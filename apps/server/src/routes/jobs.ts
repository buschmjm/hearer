import {
  JOB_STATUSES,
  Permission,
  jobDtoSchema,
  jobListQuerySchema,
  jobListResponseSchema,
  jobSummarySchema,
  type JobDto,
} from '@hearer/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.ts';
import { jobs } from '../db/schema.ts';
import { HttpError, notFound } from '../lib/http-error.ts';

const idParams = z.object({ id: z.coerce.number().int().min(1) });

/** Key names that never leave the server, whatever a job payload happens to carry. */
const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|authorization|credential|cookie/i;

/** Copy a payload with secret-looking fields replaced (jobs should not hold secrets; belt and braces). */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) && item !== null && item !== ''
          ? '[redacted]'
          : redactPayload(item, depth + 1),
      ]),
    );
  }
  return value;
}

type JobRow = typeof jobs.$inferSelect;

function toJobDto(row: JobRow): JobDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    uniqueKey: row.uniqueKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: row.runAfter.toISOString(),
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt?.toISOString() ?? null,
    lastError: row.lastError,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    payload: redactPayload(row.payloadJson),
  };
}

/** Jobs administration under /api/v1/jobs (MANAGE_SETTINGS). */
export const jobRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { database, jobs: runner } = app.hearer;
  const { db } = database;
  const guard = [requirePermission(Permission.MANAGE_SETTINGS)];

  const load = (id: number): JobRow => {
    const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw notFound('Job not found');
    return row;
  };

  app.get(
    '/jobs/summary',
    {
      onRequest: guard,
      schema: {
        tags: ['jobs'],
        summary: 'Job counts by type and status, plus the recurring schedules',
        response: { 200: jobSummarySchema },
      },
    },
    () => {
      const rows = db
        .select({ type: jobs.type, status: jobs.status, count: count() })
        .from(jobs)
        .groupBy(jobs.type, jobs.status)
        .orderBy(jobs.type, jobs.status)
        .all();
      const totals: Record<string, number> = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
      for (const row of rows) totals[row.status] = (totals[row.status] ?? 0) + row.count;
      return {
        counts: rows,
        totals,
        schedules: runner.schedules().map((s) => ({
          key: s.key,
          type: s.type,
          nextRunAt: s.nextRunAt === null ? null : new Date(s.nextRunAt).toISOString(),
          everyMs: s.everyMs,
        })),
      };
    },
  );

  app.get(
    '/jobs',
    {
      onRequest: guard,
      schema: {
        tags: ['jobs'],
        summary: 'List jobs, newest first',
        querystring: jobListQuerySchema,
        response: { 200: jobListResponseSchema },
      },
    },
    (request) => {
      const { page, pageSize, status, type } = request.query;
      const where = and(
        status ? eq(jobs.status, status) : undefined,
        type ? eq(jobs.type, type) : undefined,
      );
      const total = db.select({ n: count() }).from(jobs).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { items: rows.map(toJobDto), total, page, pageSize };
    },
  );

  app.get(
    '/jobs/:id',
    {
      onRequest: guard,
      schema: {
        tags: ['jobs'],
        summary: 'One job',
        params: idParams,
        response: { 200: jobDtoSchema },
      },
    },
    (request) => toJobDto(load(request.params.id)),
  );

  app.post(
    '/jobs/:id/retry',
    {
      onRequest: guard,
      schema: {
        tags: ['jobs'],
        summary: 'Queue a dead or failed job again (attempts reset)',
        params: idParams,
        response: { 200: jobDtoSchema },
      },
    },
    (request) => {
      const row = load(request.params.id);
      if (row.status !== 'dead' && row.status !== 'failed') {
        throw new HttpError(409, 'job_not_retryable', 'Only dead or failed jobs can be retried');
      }
      try {
        // Guarded on the status so two clicks cannot both flip it.
        const updated: JobRow | undefined = db
          .update(jobs)
          .set({
            status: 'queued',
            attempts: 0,
            runAfter: new Date(),
            lockedBy: null,
            lockedAt: null,
            finishedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(jobs.id, row.id), sql`${jobs.status} in ('dead', 'failed')`))
          .returning()
          .get();
        if (!updated) {
          throw new HttpError(409, 'job_not_retryable', 'Only dead or failed jobs can be retried');
        }
        runner.wake();
        return toJobDto(updated);
      } catch (err) {
        // The partial unique index allows one active job per key (scheduled jobs re-enqueue).
        if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
          throw new HttpError(
            409,
            'job_already_active',
            'The same job is already queued or running; delete this one instead',
          );
        }
        throw err;
      }
    },
  );

  app.delete(
    '/jobs/:id',
    {
      onRequest: guard,
      schema: {
        tags: ['jobs'],
        summary: 'Delete a queued or dead job',
        params: idParams,
      },
    },
    (request, reply) => {
      const row = load(request.params.id);
      const deleted = db
        .delete(jobs)
        .where(and(eq(jobs.id, row.id), sql`${jobs.status} in ('queued', 'dead')`))
        .returning({ id: jobs.id })
        .get();
      if (!deleted) {
        throw new HttpError(409, 'job_not_deletable', 'Only queued or dead jobs can be deleted');
      }
      return reply.code(204).send();
    },
  );

  done();
};
