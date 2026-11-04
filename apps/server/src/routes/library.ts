import { Permission } from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { librarySyncPayload, LIBRARY_SYNC_JOB, syncUniqueKey } from '../jobs/librarySync.ts';
import { requirePermission } from '../auth/guard.ts';
import { HttpError } from '../lib/http-error.ts';
import { syncStateSchema } from '../services/library.ts';

const statusSchema = z.object({
  configured: z.boolean(),
  state: syncStateSchema,
  counts: z.object({ artist: z.number(), album: z.number(), track: z.number() }),
  total: z.number(),
});

/** Library index administration under /api/v1/library (MANAGE_SETTINGS). */
export const libraryRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { library, jobs } = app.hearer;
  const guard = [requirePermission(Permission.MANAGE_SETTINGS)];

  app.get(
    '/library/status',
    {
      onRequest: guard,
      schema: {
        tags: ['library'],
        summary: 'Library index sync state and item counts',
        response: { 200: statusSchema },
      },
    },
    () => library.status(),
  );

  app.post(
    '/library/sync',
    {
      onRequest: guard,
      schema: {
        tags: ['library'],
        summary: 'Queue a library sync',
        description:
          'Queues `library.sync`. A sync of the same mode that is already queued or running is reused.',
        body: librarySyncPayload,
        response: { 202: z.object({ jobId: z.number(), mode: librarySyncPayload.shape.mode }) },
      },
    },
    (request, reply) => {
      if (!library.isConfigured()) {
        throw new HttpError(
          409,
          'media_server_not_configured',
          'Set the media server URL and API key first',
        );
      }
      const { mode } = request.body;
      const jobId = jobs.enqueue(LIBRARY_SYNC_JOB, { mode }, { uniqueKey: syncUniqueKey(mode) });
      void reply.status(202);
      return { jobId, mode };
    },
  );
  done();
};
