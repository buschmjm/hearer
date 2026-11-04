import { z } from 'zod';
import {
  MediaServerAuthError,
  MediaServerNotConfiguredError,
} from '../adapters/mediaserver/types.ts';
import type { LibraryService } from '../services/library.ts';
import { PermanentJobError, defineJob } from './registry.ts';
import type { JobRunner } from './runner.ts';

export const LIBRARY_SYNC_JOB = 'library.sync';
/** Defined by H-11. Enqueued after a successful sync only when it is registered. */
export const AVAILABILITY_JOB = 'requests.availability';
export const INCREMENTAL_INTERVAL_MS = 15 * 60_000;
export const FULL_SYNC_HOUR = 3;

export const librarySyncPayload = z.object({ mode: z.enum(['incremental', 'full']) });

/** Unique key for a manual or scheduled run, so repeated requests collapse while one is pending. */
export const syncUniqueKey = (mode: 'incremental' | 'full'): string => `library.sync:${mode}`;

export function librarySyncJob(deps: {
  library: LibraryService;
  jobs: Pick<JobRunner, 'registry'>;
}) {
  return defineJob({
    type: LIBRARY_SYNC_JOB,
    payload: librarySyncPayload,
    // One sync at a time; two writers on the same index would only fight.
    concurrency: 1,
    maxAttempts: 3,
    handler: async ({ mode }, ctx) => {
      let result;
      try {
        result = await deps.library.sync(mode, { signal: ctx.signal, log: ctx.log });
      } catch (err) {
        // A rejected key or missing settings will not fix themselves between retries.
        if (err instanceof MediaServerAuthError || err instanceof MediaServerNotConfiguredError) {
          throw new PermanentJobError(err.message, { cause: err });
        }
        throw err;
      }
      if (result.skipped) return;
      if (deps.jobs.registry.has(AVAILABILITY_JOB)) {
        // Collapses with a pending evaluation; the job reads the whole library state anyway.
        try {
          ctx.enqueue(AVAILABILITY_JOB, {}, { uniqueKey: AVAILABILITY_JOB });
        } catch (err) {
          // The sync itself succeeded; a follow-up that cannot be queued must not fail it.
          ctx.log.warn({ err }, 'could not enqueue the availability job');
        }
      }
    },
  });
}

/**
 * Define `library.sync` and its two schedules. The schedules are registered unconditionally
 * (settings can change at runtime); the handler is a quiet no-op while no media server is set.
 */
export function registerLibrarySync(jobs: JobRunner, library: LibraryService): void {
  jobs.define(librarySyncJob({ library, jobs }));
  jobs.schedule({
    type: LIBRARY_SYNC_JOB,
    key: 'incremental',
    payload: { mode: 'incremental' },
    every: INCREMENTAL_INTERVAL_MS,
  });
  jobs.schedule({
    type: LIBRARY_SYNC_JOB,
    key: 'full',
    payload: { mode: 'full' },
    dailyAtHour: FULL_SYNC_HOUR,
  });
}
