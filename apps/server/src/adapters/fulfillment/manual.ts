import { z } from 'zod';
import type { FulfillmentProvider, RequestRecord, SubmitResult } from './types.ts';

export const MANUAL_PROVIDER_ID = 'manual';

export const manualConfigSchema = z.object({ enabled: z.boolean().default(true) });

/**
 * Manual fulfillment: nothing is contacted. The request waits in `AWAITING_UPLOAD` until
 * somebody uploads the music (the upload names the request it fulfills) or the file otherwise
 * lands in the library (`requests.availability` notices).
 */
export class ManualProvider implements FulfillmentProvider {
  readonly id = MANUAL_PROVIDER_ID;
  readonly label = 'Manual (upload)';
  readonly supports = { track: true, album: true, artist: true };
  readonly configSchema = manualConfigSchema;

  submit(request: RequestRecord): Promise<SubmitResult> {
    return Promise.resolve({
      ref: `manual:${request.id}`,
      status: 'AWAITING_UPLOAD',
      note: 'Waiting for an upload',
    });
  }

  testConnection(): Promise<{ ok: true; message: string }> {
    return Promise.resolve({ ok: true, message: 'Nothing to connect to' });
  }

  describeConfig(): Record<string, unknown> {
    return {};
  }
}
