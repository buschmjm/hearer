import { z } from 'zod';
import {
  ProviderPermanentError,
  ProviderSkipError,
  type FulfillmentProvider,
} from '../adapters/fulfillment/types.ts';
import { HttpError } from '../lib/http-error.ts';
import { SUBMIT_JOB, type RequestsService } from '../services/requests.ts';
import { defineJob } from './registry.ts';

export { SUBMIT_JOB };
export const SUBMIT_MAX_ATTEMPTS = 6;
const MAX_NOTE = 300;

export const requestSubmitPayload = z.object({ requestId: z.string().min(1) });

const short = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}...` : text;
};

/**
 * `requests.submit`: hand an APPROVED request to a fulfillment provider.
 *
 *   - The registry picks the provider; one that raises `ProviderSkipError` is passed over for
 *     the next (Lidarr with trackPolicy 'skip' falls back to Manual).
 *   - No enabled provider can take the request type: the request goes to FAILED with a note
 *     saying so. An admin can fix the settings and press Retry.
 *   - Permanent provider errors fail the request straight away. Anything else is retried by the
 *     runner with backoff (an album Lidarr has not refreshed yet, a network blip); when the last
 *     attempt fails the request goes to FAILED with the error as the note.
 *   - Requests that are no longer APPROVED (cancelled while queued, already handled) are ignored.
 */
export function requestSubmitJob(requests: RequestsService) {
  return defineJob({
    type: SUBMIT_JOB,
    payload: requestSubmitPayload,
    concurrency: 2,
    maxAttempts: SUBMIT_MAX_ATTEMPTS,
    timeoutMs: 120_000,
    backoff: { baseMs: 30_000, maxMs: 30 * 60_000 },
    handler: async ({ requestId }, ctx) => {
      const row = requests.find(requestId);
      if (row?.status !== 'APPROVED') {
        ctx.log.debug({ requestId, status: row?.status }, 'request is not awaiting submission');
        return;
      }
      const fail = (note: string): void => {
        requests.transition(requestId, 'FAILED', { note });
      };

      const skipped: string[] = [];
      for (;;) {
        const provider: FulfillmentProvider | null = requests.fulfillment.select(row, {
          exclude: skipped,
        });
        if (!provider) {
          fail(`No fulfillment provider is available for ${row.type} requests`);
          return;
        }
        try {
          const result = await provider.submit(row, { signal: ctx.signal });
          try {
            requests.transition(requestId, result.status, {
              note: result.note ?? `Submitted to ${provider.label}`,
              patch: { providerId: provider.id, providerRef: result.ref },
            });
          } catch (err) {
            // Cancelled while the provider call was in flight: withdraw what we just created.
            if (err instanceof HttpError && err.code === 'invalid_transition') {
              await provider.cancel?.(result.ref).catch((cancelErr: unknown) => {
                ctx.log.warn(
                  { err: cancelErr, requestId },
                  'could not withdraw a stale submission',
                );
              });
              return;
            }
            throw err;
          }
          return;
        } catch (err) {
          if (err instanceof ProviderSkipError) {
            ctx.log.info(
              { requestId, provider: provider.id, reason: err.message },
              'provider skipped',
            );
            skipped.push(provider.id);
            continue;
          }
          if (err instanceof ProviderPermanentError) {
            fail(`${provider.label}: ${short(err)}`);
            return;
          }
          if (ctx.attempt >= SUBMIT_MAX_ATTEMPTS) {
            fail(
              `${provider.label} did not accept the request after ${String(ctx.attempt)} attempts: ${short(err)}`,
            );
            return;
          }
          throw err; // the runner retries with backoff
        }
      }
    },
  });
}
