import { z } from 'zod';
import { MetadataError } from '../adapters/metadata/types.ts';
import { HttpError } from '../lib/http-error.ts';
import type { AvailabilityMatcher } from '../services/availability.ts';
import type { RequestsService } from '../services/requests.ts';
import { AVAILABILITY_JOB } from './librarySync.ts';
import { defineJob } from './registry.ts';

export { AVAILABILITY_JOB };
/** An APPROVED request untouched for this long probably lost its submit job; queue it again. */
export const STRANDED_AFTER_MS = 5 * 60_000;

export const requestAvailabilityPayload = z.object({
  /** Only these requests; omitted = every request that is still waiting for music. */
  requestIds: z.array(z.string().min(1)).max(500).optional(),
});

/**
 * `requests.availability`: compare waiting requests (APPROVED, PROCESSING, AWAITING_UPLOAD,
 * PARTIALLY_AVAILABLE) with the library index and move them to AVAILABLE or PARTIALLY_AVAILABLE.
 * Queued after each library sync and after imports. Requests are evaluated one at a time (the
 * metadata calls behind an album or artist check are rate limited), sharing one memoized run.
 * A MusicBrainz outage fails the job after the rest have been processed so the runner retries;
 * an id MusicBrainz no longer knows is logged and skipped.
 */
export function requestAvailabilityJob(deps: {
  requests: RequestsService;
  availability: Pick<AvailabilityMatcher, 'evaluateRequest' | 'newRun'>;
}) {
  return defineJob({
    type: AVAILABILITY_JOB,
    payload: requestAvailabilityPayload,
    concurrency: 1,
    maxAttempts: 4,
    handler: async ({ requestIds }, ctx) => {
      const { requests, availability } = deps;
      const run = availability.newRun(ctx.signal);
      let unavailable: MetadataError | undefined;
      for (const row of requests.watched(requestIds)) {
        if (ctx.signal.aborted) break;
        let result;
        try {
          result = await availability.evaluateRequest(
            {
              type: row.type,
              mbid: row.mbid,
              title: row.title,
              artistName: row.artistName,
            },
            run,
          );
        } catch (err) {
          if (err instanceof MetadataError && err.kind === 'not_found') {
            ctx.log.warn({ requestId: row.id, mbid: row.mbid }, 'catalog no longer knows this id');
          } else if (err instanceof MetadataError) {
            unavailable = err;
          } else {
            throw err;
          }
          continue;
        }
        if (result.status === 'NOT_AVAILABLE') continue;
        if (result.status === row.status) continue;
        try {
          requests.transition(row.id, result.status, {
            note:
              result.status === 'AVAILABLE'
                ? 'Found in the library'
                : 'Part of this is in the library',
          });
        } catch (err) {
          // Cancelled or finished by someone else since we read it: nothing to do.
          if (!(err instanceof HttpError && err.code === 'invalid_transition')) throw err;
        }
      }
      const stranded = requests.resubmitStranded(STRANDED_AFTER_MS);
      if (stranded > 0) ctx.log.info({ stranded }, 'queued stranded approved requests again');
      if (unavailable) throw unavailable;
    },
  });
}
