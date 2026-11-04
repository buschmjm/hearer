import { userAgent } from '@hearer/shared';
import { RateLimiter } from '../../lib/ratelimit.ts';

/** Thumbnail sizes the Cover Art Archive serves. */
export const COVER_SIZES = [250, 500, 1200] as const;
export type CoverSize = (typeof COVER_SIZES)[number];
export type CoverEntity = 'release-group' | 'release';

export const DEFAULT_COVER_BASE_URL = 'https://coverartarchive.org';
const MAX_COVER_BYTES = 15 * 1024 * 1024;
const COVER_TIMEOUT_MS = 20_000;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png']);
/** The archive is not bound by MusicBrainz's 1 rps rule; stay modest anyway. */
const CAA_INTERVAL_MS = 250;

/**
 * Deterministic front-cover URL. Nothing is fetched, so searching never waits on the archive.
 * The archive answers 307 to archive.org, and 404 when a release group has no art, so a UI
 * needs `img-src https://coverartarchive.org https://*.archive.org` and an onerror fallback.
 */
export function coverArtUrl(
  baseUrl: string,
  entity: CoverEntity,
  mbid: string,
  size: CoverSize = 250,
): string {
  return `${baseUrl.replace(/\/+$/, '')}/${entity}/${mbid}/front-${String(size)}`;
}

let coverLimiter: RateLimiter | undefined;
/** The process-global Cover Art Archive limiter. */
export function getCoverArtLimiter(): RateLimiter {
  coverLimiter ??= new RateLimiter({ intervalMs: CAA_INTERVAL_MS });
  return coverLimiter;
}

export interface FetchCoverOptions {
  baseUrl?: string;
  entity?: CoverEntity;
  version?: string;
  limiter?: RateLimiter;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CoverImage {
  data: Buffer;
  contentType: string;
}

export class CoverArtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverArtError';
  }
}

/**
 * Download a front cover (for embedding into uploaded files). Follows redirects, enforces a
 * size limit and a JPEG/PNG content type, and times out. Returns null when there is no art
 * (404); throws CoverArtError for anything else that goes wrong.
 */
export async function fetchFrontCover(
  mbid: string,
  size: CoverSize,
  options: FetchCoverOptions = {},
): Promise<CoverImage | null> {
  const url = coverArtUrl(
    options.baseUrl ?? DEFAULT_COVER_BASE_URL,
    options.entity ?? 'release-group',
    mbid,
    size,
  );
  const maxBytes = options.maxBytes ?? MAX_COVER_BYTES;
  const limiter = options.limiter ?? getCoverArtLimiter();
  await limiter.acquire(options.signal);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COVER_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      redirect: 'follow',
      signal,
      headers: { 'user-agent': userAgent(options.version), accept: 'image/*' },
    });
  } catch (err) {
    throw new CoverArtError(`Cover Art Archive request failed: ${errorMessage(err)}`);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CoverArtError(`Cover Art Archive answered ${String(response.status)}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!ACCEPTED_TYPES.has(contentType.toLowerCase())) {
    await response.body?.cancel();
    throw new CoverArtError(`Unexpected cover content type "${contentType}"`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new CoverArtError('Cover image is too large');
  }
  const data = await readLimited(response, maxBytes, signal);
  return { data, contentType: contentType.toLowerCase() };
}

async function readLimited(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.body) throw new CoverArtError('Empty cover response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new CoverArtError('Cover image is too large');
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof CoverArtError) throw err;
    throw new CoverArtError(
      signal.aborted ? 'Cover download timed out' : `Cover download failed: ${errorMessage(err)}`,
    );
  }
  return Buffer.concat(chunks);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
