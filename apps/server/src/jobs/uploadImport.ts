import { z } from 'zod';
import { ImportPermanentError, UPLOAD_IMPORT_JOB, type ImportService } from '../services/import.ts';
import { PermanentJobError, defineJob } from './registry.ts';

export { UPLOAD_IMPORT_JOB };
export const IMPORT_MAX_ATTEMPTS = 4;

export const uploadImportPayload = z.object({ uploadId: z.string().min(1) });

/**
 * `upload.import {uploadId}`: tag, file and announce an approved upload (see `services/import.ts`).
 * One at a time: imports write into the shared library tree and the media server rescan.
 * Safe to run again at any point; the approve route enqueues it with `uniqueKey: import:<id>`.
 * Permanent failures (bad tags, path validation, a broken file) mark the upload FAILED and kill
 * the job; transient ones are retried with the runner's backoff, and FAILED is set on the last.
 */
export function uploadImportJob(deps: { imports: ImportService }) {
  return defineJob({
    type: UPLOAD_IMPORT_JOB,
    payload: uploadImportPayload,
    concurrency: 1,
    maxAttempts: IMPORT_MAX_ATTEMPTS,
    backoff: { baseMs: 10_000 },
    handler: async ({ uploadId }, ctx) => {
      try {
        await deps.imports.run(uploadId, {
          attempt: ctx.attempt,
          maxAttempts: IMPORT_MAX_ATTEMPTS,
          signal: ctx.signal,
        });
      } catch (err) {
        if (err instanceof ImportPermanentError) {
          throw new PermanentJobError(err.message, { cause: err });
        }
        throw err;
      }
    },
  });
}
