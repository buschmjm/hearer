import type { RequestType } from '@hearer/shared';
import { toJSONSchema, type ZodType } from 'zod';

/** The slice of a request a provider needs. */
export interface RequestRecord {
  id: string;
  type: RequestType;
  mbid: string;
  /** Tracks: the release group the recording belongs to, when known. */
  parentMbid: string | null;
  title: string;
  artistName: string | null;
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
}

export interface SubmitResult {
  /** Opaque provider reference, stored in `requests.provider_ref`. */
  ref: string;
  status: 'PROCESSING' | 'AWAITING_UPLOAD';
  /** Goes on the request timeline. */
  note?: string;
}

export interface PollResult {
  state: 'pending' | 'done' | 'failed';
  detail?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message?: string;
  version?: string;
}

/**
 * Something that can try to obtain the music behind an approved request. See docs/ADAPTERS.md.
 * Completion is never reported by a provider: Hearer detects it when the item shows up in the
 * library index (`requests.availability`), so files imported by any route count.
 */
export interface FulfillmentProvider {
  id: string;
  label: string;
  /** What the provider can handle with its current config (may depend on settings). */
  supports: { track: boolean; album: boolean; artist: boolean };
  /** Validates the provider's settings; also drives the settings form. */
  configSchema: ZodType;
  /**
   * Hand the request over. Throw `ProviderSkipError` to pass it on to the next provider,
   * `ProviderTemporaryError` for something worth retrying, `ProviderPermanentError` to fail it.
   * Any other error is treated as temporary.
   */
  submit: (request: RequestRecord, options?: CallOptions) => Promise<SubmitResult>;
  /** Progress for visibility only (timeline notes); never decides availability. */
  poll?: (ref: string, options?: CallOptions) => Promise<PollResult>;
  /** Withdraw a submitted request. */
  cancel?: (ref: string, options?: CallOptions) => Promise<void>;
  testConnection?: (options?: CallOptions) => Promise<ConnectionTestResult>;
  /** The provider's current config with secrets masked, for the settings UI. */
  describeConfig?: () => Record<string, unknown>;
}

/** The provider cannot handle this request; try the next one (e.g. Lidarr with trackPolicy 'skip'). */
export class ProviderSkipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderSkipError';
  }
}

/** Worth retrying later (network error, 5xx, an album Lidarr has not imported yet). */
export class ProviderTemporaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderTemporaryError';
  }
}

/** Retrying will not help (rejected key, bad config, 4xx for this request). */
export class ProviderPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderPermanentError';
  }
}

/**
 * The provider's config schema as JSON Schema (draft 2020-12), for the settings form. Uses the
 * input side of the schema so defaults show as optional fields with a `default`.
 */
export function configJsonSchema(provider: Pick<FulfillmentProvider, 'configSchema'>) {
  return toJSONSchema(provider.configSchema, { io: 'input', unrepresentable: 'any' });
}
