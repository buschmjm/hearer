import { userAgent, type SettingsValue } from '@hearer/shared';
import { z } from 'zod';
import { RateLimiter, parseRetryAfter } from '../../lib/ratelimit.ts';
import type { SettingsService } from '../../services/settings.ts';

/** AcoustID allows at most 3 requests per second per application. */
export const ACOUSTID_INTERVAL_MS = 340;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
/** What we ask the service to include: `compress` merges identical releases. */
export const ACOUSTID_META = 'recordings releasegroups releases tracks compress';

let acoustIdLimiter: RateLimiter | undefined;
/** The process-global AcoustID limiter (about 3 requests per second). */
export function getAcoustIdLimiter(): RateLimiter {
  acoustIdLimiter ??= new RateLimiter({ intervalMs: ACOUSTID_INTERVAL_MS });
  return acoustIdLimiter;
}

/**
 * Why a lookup failed. `auth`: the key is wrong (do not retry). `bad_request`: the service
 * rejected our input (do not retry). `unavailable`: network, 5xx, rate limit or an internal
 * error on their side (retry later). `bad_response`: the body was not what the API documents.
 */
export class AcoustIdError extends Error {
  readonly kind: 'auth' | 'bad_request' | 'unavailable' | 'bad_response';
  readonly code: number | null;

  constructor(
    kind: AcoustIdError['kind'],
    message: string,
    options?: { code?: number | null; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AcoustIdError';
    this.kind = kind;
    this.code = options?.code ?? null;
  }
}

/** A release the recording appears on, as far as AcoustID tells us. */
export interface AcoustIdRelease {
  mbid: string;
  title: string | null;
  /** `YYYY[-MM[-DD]]` */
  date: string | null;
  trackCount: number | null;
  /** Where the recording sits on this release (first occurrence). */
  position: { discNumber: number; trackNumber: number; trackMbid: string | null } | null;
}

export interface AcoustIdReleaseGroup {
  mbid: string;
  title: string | null;
  type: string | null;
  releases: AcoustIdRelease[];
}

export interface AcoustIdRecording {
  /** MusicBrainz recording id. */
  mbid: string;
  /** AcoustID track id of the fingerprint this recording was found under. */
  acoustId: string;
  /** 0..1 fingerprint similarity. */
  score: number;
  title: string | null;
  artists: { mbid: string | null; name: string }[];
  durationMs: number | null;
  releaseGroups: AcoustIdReleaseGroup[];
}

export type AcoustIdLookup =
  { status: 'disabled' } | { status: 'ok'; recordings: AcoustIdRecording[] };

// --- raw response shapes (lenient: only what we read) --------------------------------------------

const artistRaw = z.object({ id: z.string().optional(), name: z.string().optional() });
const dateRaw = z
  .object({
    year: z.number().nullish(),
    month: z.number().nullish(),
    day: z.number().nullish(),
  })
  .nullish();
const trackRaw = z.object({
  id: z.string().optional(),
  position: z.number().nullish(),
});
const mediumRaw = z.object({
  position: z.number().nullish(),
  track_count: z.number().nullish(),
  tracks: z.array(trackRaw).nullish(),
});
const releaseRaw = z.object({
  id: z.string(),
  title: z.string().nullish(),
  date: dateRaw,
  track_count: z.number().nullish(),
  mediums: z.array(mediumRaw).nullish(),
});
const releaseGroupRaw = z.object({
  id: z.string(),
  title: z.string().nullish(),
  type: z.string().nullish(),
  releases: z.array(releaseRaw).nullish(),
});
const recordingRaw = z.object({
  id: z.string(),
  title: z.string().nullish(),
  duration: z.number().nullish(),
  artists: z.array(artistRaw).nullish(),
  releasegroups: z.array(releaseGroupRaw).nullish(),
});
const responseRaw = z.object({
  status: z.string(),
  error: z.object({ code: z.number().nullish(), message: z.string().nullish() }).nullish(),
  results: z
    .array(
      z.object({
        id: z.string(),
        score: z.number(),
        recordings: z.array(recordingRaw).nullish(),
      }),
    )
    .nullish(),
});

const pad = (n: number): string => String(n).padStart(2, '0');
function mapDate(date: z.infer<typeof dateRaw>): string | null {
  if (!date?.year) return null;
  if (!date.month) return String(date.year);
  return date.day
    ? `${String(date.year)}-${pad(date.month)}-${pad(date.day)}`
    : `${String(date.year)}-${pad(date.month)}`;
}

function mapRelease(raw: z.infer<typeof releaseRaw>): AcoustIdRelease {
  let position: AcoustIdRelease['position'] = null;
  for (const [mediumIndex, medium] of (raw.mediums ?? []).entries()) {
    const track = (medium.tracks ?? []).find((t) => t.position != null);
    if (track?.position != null) {
      position = {
        discNumber: medium.position ?? mediumIndex + 1,
        trackNumber: track.position,
        trackMbid: track.id ?? null,
      };
      break;
    }
  }
  return {
    mbid: raw.id,
    title: raw.title ?? null,
    date: mapDate(raw.date),
    trackCount:
      raw.track_count ??
      ((raw.mediums ?? []).reduce((sum, m) => sum + (m.track_count ?? 0), 0) || null),
    position,
  };
}

/**
 * Turn an AcoustID response into one entry per recording (the best score wins when a recording
 * is found under several fingerprints), best score first. Exported for tests.
 */
export function mapAcoustIdResults(raw: z.infer<typeof responseRaw>): AcoustIdRecording[] {
  const byMbid = new Map<string, AcoustIdRecording>();
  for (const result of raw.results ?? []) {
    for (const rec of result.recordings ?? []) {
      const existing = byMbid.get(rec.id);
      if (existing && existing.score >= result.score) continue;
      byMbid.set(rec.id, {
        mbid: rec.id,
        acoustId: result.id,
        score: Math.min(1, Math.max(0, result.score)),
        title: rec.title ?? null,
        artists: (rec.artists ?? []).flatMap((a) =>
          a.name ? [{ mbid: a.id ?? null, name: a.name }] : [],
        ),
        durationMs: rec.duration == null ? null : Math.round(rec.duration * 1000),
        releaseGroups: (rec.releasegroups ?? []).map((rg) => ({
          mbid: rg.id,
          title: rg.title ?? null,
          type: rg.type ?? null,
          releases: (rg.releases ?? []).map((r) => mapRelease(r)),
        })),
      });
    }
  }
  return [...byMbid.values()].sort((a, b) => b.score - a.score || a.mbid.localeCompare(b.mbid));
}

export interface AcoustIdClientOptions {
  settings: Pick<SettingsService, 'get'>;
  logger: { info: (obj: Record<string, unknown>, msg: string) => void };
  version?: string | undefined;
  /** Defaults to the process-global AcoustID limiter. */
  limiter?: RateLimiter;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * AcoustID `lookup`: fingerprint + duration in, MusicBrainz recording ids with scores out.
 * The API key (`metadata.acoustIdApiKey`) and base URL (`metadata.acoustIdBaseUrl`) are read per
 * call so settings apply live. Without a key the client does nothing and says `disabled`.
 */
export class AcoustIdClient {
  readonly #options: AcoustIdClientOptions;
  readonly #limiter: RateLimiter;
  #warnedDisabled = false;

  constructor(options: AcoustIdClientOptions) {
    this.#options = options;
    this.#limiter = options.limiter ?? getAcoustIdLimiter();
  }

  get #config(): SettingsValue<'metadata'> {
    return this.#options.settings.get('metadata');
  }

  /** True when an API key is configured. */
  get enabled(): boolean {
    return this.#config.acoustIdApiKey.trim() !== '';
  }

  async lookup(
    fingerprint: string,
    durationSeconds: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<AcoustIdLookup> {
    const config = this.#config;
    const key = config.acoustIdApiKey.trim();
    if (key === '') {
      if (!this.#warnedDisabled) {
        this.#warnedDisabled = true;
        this.#options.logger.info({}, 'AcoustID lookups are disabled: no metadata.acoustIdApiKey');
      }
      return { status: 'disabled' };
    }
    const body = new URLSearchParams({
      client: key,
      duration: String(Math.max(1, Math.round(durationSeconds))),
      fingerprint,
      meta: ACOUSTID_META,
      format: 'json',
    });
    const url = `${config.acoustIdBaseUrl.replace(/\/+$/u, '')}/lookup`;
    try {
      await this.#limiter.acquire(options.signal);
    } catch (err) {
      throw new AcoustIdError('unavailable', 'AcoustID lookup was cancelled', { cause: err });
    }
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          'user-agent': userAgent(this.#options.version),
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal,
      });
    } catch (err) {
      throw new AcoustIdError('unavailable', 'AcoustID could not be reached', { cause: err });
    }
    const text = await response.text().catch(() => '');
    if (response.status === 429 || response.status === 503) {
      const wait = parseRetryAfter(response.headers.get('retry-after')) ?? 2_000;
      this.#limiter.penalize(Math.min(wait, MAX_BACKOFF_MS));
      throw new AcoustIdError(
        'unavailable',
        `AcoustID is rate limiting (HTTP ${String(response.status)})`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AcoustIdError(
        response.status >= 500 ? 'unavailable' : 'bad_response',
        `AcoustID answered HTTP ${String(response.status)} with a body that is not JSON`,
      );
    }
    const parsed = responseRaw.safeParse(json);
    if (!parsed.success) {
      throw new AcoustIdError('bad_response', 'AcoustID answered in an unexpected format');
    }
    if (parsed.data.status !== 'ok') {
      const code = parsed.data.error?.code ?? null;
      const message = parsed.data.error?.message ?? `HTTP ${String(response.status)}`;
      // Documented codes: 4 and 6 are bad keys; 5 is their internal error; the rest are our input.
      const kind = code === 4 || code === 6 ? 'auth' : code === 5 ? 'unavailable' : 'bad_request';
      throw new AcoustIdError(
        kind,
        `AcoustID error${code === null ? '' : ` ${String(code)}`}: ${message}`,
        {
          code,
        },
      );
    }
    if (!response.ok) {
      throw new AcoustIdError(
        response.status >= 500 ? 'unavailable' : 'bad_response',
        `AcoustID answered HTTP ${String(response.status)}`,
      );
    }
    return { status: 'ok', recordings: mapAcoustIdResults(parsed.data) };
  }
}
