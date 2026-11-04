import { z } from 'zod';
import { HttpError } from '../lib/http-error.ts';
import type { RequestsService } from '../services/requests.ts';
import { defineJob } from './registry.ts';

export const REQUEST_POLL_JOB = 'requests.poll';
export const REQUEST_POLL_INTERVAL_MS = 5 * 60_000;
const MAX_DETAIL = 300;

/**
 * `requests.poll` (every 5 minutes): ask the provider how each PROCESSING request is doing and
 * put notable changes on the timeline. This is for visibility only; a request becomes AVAILABLE
 * when the library index shows it (`requests.availability`), never because a provider says so.
 *
 *   - A note is added only when the provider's detail text differs from the last one this job
 *     wrote for the request, so a slow download does not fill the timeline.
 *   - `failed` (a permanent provider failure, e.g. the search command failed) moves the request
 *     to FAILED with that detail; an admin can retry it.
 *   - An error polling one request (provider down, bad reference) is logged and skipped so it
 *     cannot hide the others; the next run tries again.
 */
export function requestPollJob(requests: RequestsService) {
  return defineJob({
    type: REQUEST_POLL_JOB,
    payload: z.object({}),
    concurrency: 1,
    maxAttempts: 1,
    handler: async (_payload, ctx) => {
      for (const row of requests.processing()) {
        if (ctx.signal.aborted) return;
        if (!row.providerId || !row.providerRef) continue;
        const provider = requests.fulfillment.get(row.providerId);
        if (!provider?.poll) continue;
        let result;
        try {
          result = await provider.poll(row.providerRef, { signal: ctx.signal });
        } catch (err) {
          ctx.log.warn({ err, requestId: row.id, provider: provider.id }, 'provider poll failed');
          continue;
        }
        const detail = (result.detail ?? result.state).slice(0, MAX_DETAIL);
        const prefix = `${provider.label}: `;
        try {
          if (result.state === 'failed') {
            requests.transition(row.id, 'FAILED', { note: `${prefix}${detail}` });
          } else {
            requests.addNoteIfChanged(row.id, prefix, detail);
          }
        } catch (err) {
          // Cancelled or finished while we were polling.
          if (!(err instanceof HttpError && err.code === 'invalid_transition')) throw err;
        }
      }
    },
  });
}
