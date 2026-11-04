import type { NotificationService } from '../services/notifications.ts';
import { NOTIFY_JOB, NOTIFY_MAX_ATTEMPTS, notifySendPayload } from '../services/notifications.ts';
import { defineJob } from './registry.ts';

export { NOTIFY_JOB };

/**
 * `notify.send`: deliver one rendered notification to one destination. Agents classify their
 * errors (429/5xx/network retry, other 4xx are `PermanentJobError`), the runner retries with
 * exponential backoff up to 5 attempts, and `last_error` on the job row records what went wrong.
 */
export function notifySendJob(notifications: NotificationService) {
  return defineJob({
    type: NOTIFY_JOB,
    payload: notifySendPayload,
    concurrency: 4,
    maxAttempts: NOTIFY_MAX_ATTEMPTS,
    timeoutMs: 90_000,
    backoff: { baseMs: 15_000, maxMs: 30 * 60_000 },
    handler: async (payload, ctx) => {
      await notifications.deliver(payload, ctx.signal);
    },
  });
}
