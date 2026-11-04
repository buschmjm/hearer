import { userAgent, type SettingsValue } from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { mbCache } from '../../db/schema.ts';
import { type RateLimiter, getMusicBrainzLimiter, parseRetryAfter } from '../../lib/ratelimit.ts';
import type { SettingsService } from '../../services/settings.ts';
import { coverArtUrl } from './coverart.ts';
import {
  MetadataError,
  type ArtistBase,
  type ArtistDetailBase,
  type MetadataProvider,
  type Page,
  type PageRequest,
  type RecordingBase,
  type RecordingDetailBase,
  type ReleaseDetailBase,
  type ReleaseGroupBase,
  type ReleaseGroupDetailBase,
  type ReleaseGroupType,
  type ReleaseSummary,
  type RequestOptions,
  type TrackBase,
} from './types.ts';

const DAY_SECONDS = 86_400;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2_000;
/** Never wait longer than this for a Retry-After. */
const MAX_BACKOFF_MS = 60_000;
/** The most releases one browse returns; groups with more are truncated. */
const RELEASE_BROWSE_LIMIT = 100;

// --- Lucene query building ---------------------------------------------------------------------

const LUCENE_SPECIAL = /[+\-!(){}[\]^"~*?:\\/&|]/g;
const LUCENE_OPERATORS = new Set(['AND', 'OR', 'NOT', 'TO']);

/**
 * Make user text safe to embed in a Lucene query: every special character is backslash-escaped
 * (`AC/DC` becomes `AC\/DC`), the bare operators AND/OR/NOT are quoted, and whitespace is
 * collapsed. The result is plain terms, never operators.
 */
export function escapeLucene(input: string): string {
  return input
    .normalize('NFKC')
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) =>
      LUCENE_OPERATORS.has(term) ? `"${term}"` : term.replace(LUCENE_SPECIAL, '\\$&'),
    )
    .join(' ');
}

/** `field:(terms) OR field:(terms)`: the same user text matched against several fields. */
function fieldQuery(fields: readonly string[], input: string): string {
  const terms = escapeLucene(input);
  return fields.map((field) => `${field}:(${terms})`).join(' OR ');
}

export const artistQuery = (input: string): string => fieldQuery(['artist', 'alias'], input);
/** "Radiohead OK Computer" matches the title, the artist, or both. */
export const releaseGroupQuery = (input: string): string =>
  fieldQuery(['releasegroup', 'artist'], input);
export const recordingQuery = (input: string): string => fieldQuery(['recording', 'artist'], input);

// --- raw MusicBrainz shapes (only what we read; everything optional) ---------------------------

const text = z.string().nullish();
const rawCredit = z.array(
  z.object({
    name: z.string().optional(),
    joinphrase: text,
    artist: z.object({ id: z.string(), name: z.string() }).partial({ name: true }).optional(),
  }),
);
const rawArtist = z.object({
  id: z.string(),
  name: z.string(),
  'sort-name': text,
  type: text,
  country: text,
  disambiguation: text,
  score: z.number().optional(),
  'life-span': z.object({ begin: text, end: text, ended: z.boolean().nullish() }).nullish(),
});
const rawReleaseGroup = z.object({
  id: z.string(),
  title: z.string(),
  disambiguation: text,
  'primary-type': text,
  'secondary-types': z.array(z.string()).nullish(),
  'first-release-date': text,
  'artist-credit': rawCredit.nullish(),
  score: z.number().optional(),
});
const rawMedium = z.object({
  position: z.number().nullish(),
  format: text,
  'track-count': z.number().nullish(),
  tracks: z
    .array(
      z.object({
        id: z.string().optional(),
        number: text,
        position: z.number().nullish(),
        title: z.string().optional(),
        length: z.number().nullish(),
        'artist-credit': rawCredit.nullish(),
        recording: z
          .object({
            id: z.string(),
            title: z.string().optional(),
            length: z.number().nullish(),
            isrcs: z.array(z.string()).nullish(),
            'artist-credit': rawCredit.nullish(),
          })
          .optional(),
      }),
    )
    .nullish(),
});
const rawRelease = z.object({
  id: z.string(),
  title: z.string(),
  status: text,
  date: text,
  country: text,
  media: z.array(rawMedium).nullish(),
  'release-group': rawReleaseGroup.optional(),
});
const rawRecording = z.object({
  id: z.string(),
  title: z.string(),
  disambiguation: text,
  length: z.number().nullish(),
  'first-release-date': text,
  'artist-credit': rawCredit.nullish(),
  isrcs: z.array(z.string()).nullish(),
  releases: z.array(rawRelease.partial({ title: true })).nullish(),
  score: z.number().optional(),
});

const artistSearch = z.object({ count: z.number(), artists: z.array(rawArtist) });
const releaseGroupSearch = z.object({
  count: z.number(),
  'release-groups': z.array(rawReleaseGroup),
});
const recordingSearch = z.object({ count: z.number(), recordings: z.array(rawRecording) });
const releaseGroupBrowse = z.object({
  'release-group-count': z.number(),
  'release-groups': z.array(rawReleaseGroup),
});
const releaseBrowse = z.object({ releases: z.array(rawRelease) });

type RawCredit = z.infer<typeof rawCredit>;
type RawReleaseGroup = z.infer<typeof rawReleaseGroup>;
type RawRelease = z.infer<typeof rawRelease>;

// --- mapping -----------------------------------------------------------------------------------

function mapCredit(credit: RawCredit | null | undefined): {
  artistCredit: ReleaseGroupBase['artistCredit'];
  artistName: string;
} {
  const artistCredit = (credit ?? []).map((c) => ({
    mbid: c.artist?.id ?? null,
    name: c.name ?? c.artist?.name ?? '',
    joinPhrase: c.joinphrase ?? '',
  }));
  return { artistCredit, artistName: artistCredit.map((c) => c.name + c.joinPhrase).join('') };
}

const emptyToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === '' ? null : value;

function mapArtist(raw: z.infer<typeof rawArtist>): ArtistBase {
  return {
    mbid: raw.id,
    name: raw.name,
    sortName: raw['sort-name'] ?? raw.name,
    type: emptyToNull(raw.type),
    country: emptyToNull(raw.country),
    disambiguation: raw.disambiguation ?? '',
    score: raw.score ?? null,
  };
}

function mapReleaseGroup(raw: RawReleaseGroup, coverBaseUrl: string): ReleaseGroupBase {
  return {
    mbid: raw.id,
    title: raw.title,
    disambiguation: raw.disambiguation ?? '',
    primaryType: emptyToNull(raw['primary-type']),
    secondaryTypes: raw['secondary-types'] ?? [],
    firstReleaseDate: emptyToNull(raw['first-release-date']),
    ...mapCredit(raw['artist-credit']),
    coverUrl: coverArtUrl(coverBaseUrl, 'release-group', raw.id, 250),
    score: raw.score ?? null,
  };
}

function summarizeFormats(formats: readonly string[]): string | null {
  const groups: { format: string; count: number }[] = [];
  for (const format of formats) {
    const last = groups[groups.length - 1];
    if (last?.format === format) last.count++;
    else groups.push({ format, count: 1 });
  }
  return groups.length === 0
    ? null
    : groups.map((g) => (g.count > 1 ? `${String(g.count)}x${g.format}` : g.format)).join(' + ');
}

/** The facts the representative-release heuristic looks at. */
export interface ReleaseCandidate {
  mbid: string;
  status: string | null;
  date: string | null;
  /** One entry per medium; unknown formats are ''. */
  formats: readonly string[];
  trackCount: number;
}

interface MappedRelease {
  summary: ReleaseSummary;
  candidate: ReleaseCandidate;
}

function mapRelease(raw: RawRelease): MappedRelease {
  const media = raw.media ?? [];
  const formats = media.map((m) => m.format ?? '');
  const trackCount = media.reduce((sum, m) => sum + (m['track-count'] ?? m.tracks?.length ?? 0), 0);
  const date = emptyToNull(raw.date);
  const status = emptyToNull(raw.status);
  return {
    summary: {
      mbid: raw.id,
      title: raw.title,
      date,
      country: emptyToNull(raw.country),
      status,
      format: summarizeFormats(formats.filter((f) => f !== '')),
      trackCount,
    },
    candidate: { mbid: raw.id, status, date, formats, trackCount },
  };
}

function mapTracks(raw: RawRelease): TrackBase[] {
  const tracks: TrackBase[] = [];
  (raw.media ?? []).forEach((medium, mediumIndex) => {
    (medium.tracks ?? []).forEach((track, trackIndex) => {
      const recording = track.recording;
      if (!recording) return;
      const position = track.position ?? trackIndex + 1;
      tracks.push({
        mbid: recording.id,
        title: track.title ?? recording.title ?? '',
        discNumber: medium.position ?? mediumIndex + 1,
        position,
        number: track.number && track.number !== String(position) ? track.number : null,
        lengthMs: track.length ?? recording.length ?? null,
        ...mapCredit(track['artist-credit'] ?? recording['artist-credit']),
        isrcs: recording.isrcs ?? [],
      });
    });
  });
  return tracks;
}

const isStudioAlbum = (rg: RawReleaseGroup): boolean =>
  rg['primary-type'] === 'Album' && (rg['secondary-types'] ?? []).length === 0;

/** Studio albums first, then by first release date, then id: a stable "home" for a recording. */
function sortHomeReleaseGroups(groups: RawReleaseGroup[]): RawReleaseGroup[] {
  return [...groups].sort(
    (a, b) =>
      Number(isStudioAlbum(b)) - Number(isStudioAlbum(a)) ||
      dateSortKey(emptyToNull(a['first-release-date'])).localeCompare(
        dateSortKey(emptyToNull(b['first-release-date'])),
      ) ||
      a.id.localeCompare(b.id),
  );
}

function uniqueReleaseGroups(
  releases: readonly { 'release-group'?: RawReleaseGroup | undefined }[],
) {
  const byId = new Map<string, RawReleaseGroup>();
  for (const release of releases) {
    const rg = release['release-group'];
    if (rg && !byId.has(rg.id)) byId.set(rg.id, rg);
  }
  return sortHomeReleaseGroups([...byId.values()]);
}

function mapRecording(
  raw: z.infer<typeof rawRecording>,
  coverBaseUrl: string,
): { base: RecordingBase; groups: RawReleaseGroup[] } {
  const groups = uniqueReleaseGroups(raw.releases ?? []);
  const home = groups[0];
  return {
    groups,
    base: {
      mbid: raw.id,
      title: raw.title,
      disambiguation: raw.disambiguation ?? '',
      lengthMs: raw.length ?? null,
      ...mapCredit(raw['artist-credit']),
      releaseGroup: home
        ? {
            mbid: home.id,
            title: home.title,
            primaryType: emptyToNull(home['primary-type']),
            coverUrl: coverArtUrl(coverBaseUrl, 'release-group', home.id, 250),
          }
        : null,
      coverUrl: home ? coverArtUrl(coverBaseUrl, 'release-group', home.id, 250) : null,
      firstReleaseDate: emptyToNull(raw['first-release-date']),
      score: raw.score ?? null,
    },
  };
}

// --- representative release ---------------------------------------------------------------------

/** Sortable form of a MusicBrainz date: "1997" sorts after "1997-05-21"; undated sorts last. */
function dateSortKey(date: string | null): string {
  if (!date) return '9999-99-99';
  const [year = '9999', month = '99', day = '99'] = date.split('-');
  return `${year}-${month}-${day}`;
}

const PREFERRED_FORMATS = new Set(['digital media', 'cd', 'hdcd', 'enhanced cd', 'cd-r']);

/**
 * Choose the release whose tracklist stands for the whole release group:
 *  1. Official releases only (every release, when none is official).
 *  2. Releases whose media are all Digital Media or CD (all remaining, when there are none).
 *  3. The most common total track count among those; a tie goes to the count that the
 *     earliest-dated release has. This keeps deluxe/bonus editions from winning.
 *  4. The earliest date (a full date beats a bare year of the same year; undated is last).
 *  5. The release id, so the answer never depends on response order.
 */
export function pickRepresentativeRelease<T extends ReleaseCandidate>(
  releases: readonly T[],
): T | null {
  const official = releases.filter((r) => r.status?.toLowerCase() === 'official');
  let pool = official.length > 0 ? official : [...releases];
  const preferred = pool.filter(
    (r) => r.formats.length > 0 && r.formats.every((f) => PREFERRED_FORMATS.has(f.toLowerCase())),
  );
  if (preferred.length > 0) pool = preferred;
  if (pool.length === 0) return null;

  const byDate = (a: T, b: T) =>
    dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.mbid.localeCompare(b.mbid);
  pool.sort(byDate);

  const counts = new Map<number, number>();
  for (const r of pool) counts.set(r.trackCount, (counts.get(r.trackCount) ?? 0) + 1);
  const best = Math.max(...counts.values());
  // pool is date-sorted, so the first release with a modal count is the earliest one.
  const winner = pool.find((r) => counts.get(r.trackCount) === best);
  return winner ?? null;
}

// --- the provider ----------------------------------------------------------------------------

export interface MusicBrainzOptions {
  db: Db;
  settings: Pick<SettingsService, 'get'>;
  logger: { warn: (obj: Record<string, unknown>, msg: string) => void };
  version?: string | undefined;
  /** Defaults to the process-global MusicBrainz limiter. */
  limiter?: RateLimiter;
  fetch?: typeof fetch;
  /** Clock override (tests). */
  now?: () => number;
  maxRetries?: number;
  /** Backoff when a 503/429 carries no Retry-After; doubles per attempt. */
  backoffMs?: number;
  timeoutMs?: number;
}

type TtlKind = 'entity' | 'search';
interface Flight {
  promise: Promise<unknown>;
  waiters: number;
  controller: AbortController;
}

export class MusicBrainzProvider implements MetadataProvider {
  readonly #options: MusicBrainzOptions;
  readonly #limiter: RateLimiter;
  readonly #now: () => number;
  readonly #flights = new Map<string, Flight>();

  constructor(options: MusicBrainzOptions) {
    this.#options = options;
    this.#limiter = options.limiter ?? getMusicBrainzLimiter();
    this.#now = options.now ?? Date.now;
  }

  get #config(): SettingsValue<'metadata'> {
    return this.#options.settings.get('metadata');
  }

  async searchArtists(query: string, page: PageRequest, options?: RequestOptions) {
    const body = await this.#get(
      'artist',
      { query: artistQuery(query), ...pageParams(page) },
      'search',
      artistSearch,
      options,
    );
    return pageOf(body.artists.map(mapArtist), body.count, page);
  }

  async searchReleaseGroups(query: string, page: PageRequest, options?: RequestOptions) {
    const body = await this.#get(
      'release-group',
      { query: releaseGroupQuery(query), ...pageParams(page) },
      'search',
      releaseGroupSearch,
      options,
    );
    const cover = this.#config.coverArtBaseUrl;
    return pageOf(
      body['release-groups'].map((rg) => mapReleaseGroup(rg, cover)),
      body.count,
      page,
    );
  }

  async searchRecordings(query: string, page: PageRequest, options?: RequestOptions) {
    const body = await this.#get(
      'recording',
      { query: recordingQuery(query), ...pageParams(page) },
      'search',
      recordingSearch,
      options,
    );
    const cover = this.#config.coverArtBaseUrl;
    return pageOf(
      body.recordings.map((r) => mapRecording(r, cover).base),
      body.count,
      page,
    );
  }

  async getArtist(mbid: string, options?: RequestOptions): Promise<ArtistDetailBase> {
    const raw = await this.#get(`artist/${mbid}`, {}, 'entity', rawArtist, options);
    const span = raw['life-span'];
    return {
      ...mapArtist(raw),
      lifeSpan: span
        ? { begin: emptyToNull(span.begin), end: emptyToNull(span.end), ended: span.ended ?? false }
        : null,
    };
  }

  async getArtistReleaseGroups(
    mbid: string,
    page: PageRequest & { type?: ReleaseGroupType | undefined },
    options?: RequestOptions,
  ) {
    const body = await this.#get(
      'release-group',
      {
        artist: mbid,
        inc: 'artist-credits',
        ...(page.type ? { type: page.type } : {}),
        ...pageParams(page),
      },
      'entity',
      releaseGroupBrowse,
      options,
    );
    const cover = this.#config.coverArtBaseUrl;
    return pageOf(
      body['release-groups'].map((rg) => mapReleaseGroup(rg, cover)),
      body['release-group-count'],
      page,
    );
  }

  async getReleaseGroup(mbid: string, options?: RequestOptions): Promise<ReleaseGroupDetailBase> {
    const raw = await this.#get(
      `release-group/${mbid}`,
      { inc: 'artist-credits' },
      'entity',
      rawReleaseGroup,
      options,
    );
    const browse = await this.#get(
      'release',
      { 'release-group': mbid, inc: 'media', limit: String(RELEASE_BROWSE_LIMIT) },
      'entity',
      releaseBrowse,
      options,
    );
    const mapped = browse.releases.map(mapRelease);
    const picked = pickRepresentativeRelease(mapped.map((m) => m.candidate));
    const representative = mapped.find((m) => m.candidate.mbid === picked?.mbid)?.summary ?? null;
    const tracks = representative
      ? (await this.getRelease(representative.mbid, options)).tracks
      : [];
    return {
      ...mapReleaseGroup(raw, this.#config.coverArtBaseUrl),
      releases: mapped.map((m) => m.summary),
      representativeRelease: representative,
      tracks,
    };
  }

  async getRelease(mbid: string, options?: RequestOptions): Promise<ReleaseDetailBase> {
    const raw = await this.#get(
      `release/${mbid}`,
      { inc: 'recordings+artist-credits+isrcs+release-groups' },
      'entity',
      rawRelease,
      options,
    );
    return {
      ...mapRelease(raw).summary,
      releaseGroupMbid: raw['release-group']?.id ?? null,
      tracks: mapTracks(raw),
    };
  }

  async getRecording(mbid: string, options?: RequestOptions): Promise<RecordingDetailBase> {
    const raw = await this.#get(
      `recording/${mbid}`,
      { inc: 'artists+releases+release-groups+isrcs' },
      'entity',
      rawRecording,
      options,
    );
    const cover = this.#config.coverArtBaseUrl;
    const { base, groups } = mapRecording(raw, cover);
    return {
      ...base,
      isrcs: raw.isrcs ?? [],
      releaseGroups: groups.map((rg) => mapReleaseGroup(rg, cover)),
    };
  }

  // --- transport: cache, single-flight, rate limit, retries ---------------------------------

  #buildUrl(path: string, params: Record<string, string>): URL {
    const base = this.#config.musicBrainzBaseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path}`);
    const all: Record<string, string> = { ...params, fmt: 'json' };
    for (const key of Object.keys(all).sort()) url.searchParams.set(key, all[key] ?? '');
    return url;
  }

  async #get<S extends z.ZodType>(
    path: string,
    params: Record<string, string>,
    kind: TtlKind,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const url = this.#buildUrl(path, params);
    const key = url.toString();
    const cached = this.#readCache(key);
    if (cached && cached.freshUntil > this.#now()) {
      const parsed = schema.safeParse(cached.body);
      if (parsed.success) return parsed.data;
    }

    let flight = this.#flights.get(key);
    // A flight whose last waiter left is being torn down; start a fresh one instead.
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.#fetchAndStore(
        url,
        key,
        kind,
        schema,
        cached?.body,
        controller.signal,
      ).finally(() => this.#flights.delete(key));
      flight = { promise, waiters: 0, controller };
      this.#flights.set(key, flight);
    }
    const joined = flight;
    joined.waiters++;
    try {
      return (await raceAbort(joined.promise, options.signal)) as z.infer<S>;
    } finally {
      joined.waiters--;
      // Nobody is waiting any more: stop queueing for the limiter / drop the request.
      if (joined.waiters === 0) joined.controller.abort();
    }
  }

  #readCache(key: string): { body: unknown; freshUntil: number } | null {
    const row = this.#options.db.select().from(mbCache).where(eq(mbCache.urlKey, key)).get();
    if (!row) return null;
    try {
      return {
        body: JSON.parse(row.bodyJson) as unknown,
        freshUntil: row.fetchedAt.getTime() + row.ttlSeconds * 1000,
      };
    } catch {
      return null;
    }
  }

  async #fetchAndStore(
    url: URL,
    key: string,
    kind: TtlKind,
    schema: z.ZodType,
    stale: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      const bodyText = await this.#fetchText(url, signal);
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch (cause) {
        throw new MetadataError('bad_response', 'MusicBrainz returned invalid JSON', { cause });
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new MetadataError('bad_response', 'MusicBrainz returned an unexpected response', {
          cause: parsed.error,
        });
      }
      this.#writeCache(key, bodyText, kind);
      return parsed.data;
    } catch (err) {
      // not_found is an answer, and an abort is the caller's choice: neither falls back.
      const falls = !signal.aborted && !(err instanceof MetadataError && err.kind === 'not_found');
      if (falls && stale !== undefined) {
        const parsed = schema.safeParse(stale);
        if (parsed.success) {
          this.#options.logger.warn(
            { url: key, err: err instanceof Error ? err.message : String(err) },
            'MusicBrainz request failed; serving a stale cached response',
          );
          return parsed.data;
        }
      }
      throw err;
    }
  }

  #writeCache(key: string, bodyJson: string, kind: TtlKind): void {
    const { entityDays, searchDays } = this.#config.cacheTtl;
    const ttlSeconds = (kind === 'search' ? searchDays : entityDays) * DAY_SECONDS;
    const fetchedAt = new Date(this.#now());
    this.#options.db
      .insert(mbCache)
      .values({ urlKey: key, bodyJson, fetchedAt, ttlSeconds })
      .onConflictDoUpdate({ target: mbCache.urlKey, set: { bodyJson, fetchedAt, ttlSeconds } })
      .run();
  }

  async #fetchText(url: URL, signal: AbortSignal): Promise<string> {
    const maxRetries = this.#options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const fetchImpl = this.#options.fetch ?? fetch;
    for (let attempt = 0; ; attempt++) {
      await this.#limiter.acquire(signal);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            'user-agent': userAgent(this.#options.version),
            accept: 'application/json',
          },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS),
          ]),
        });
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new MetadataError('unavailable', 'MusicBrainz is unreachable', { cause });
      }
      if (response.status === 503 || response.status === 429) {
        await response.body?.cancel();
        if (attempt >= maxRetries) {
          throw new MetadataError('unavailable', 'MusicBrainz is rate limiting requests');
        }
        const hinted = parseRetryAfter(response.headers.get('retry-after'), this.#now());
        const delay = Math.min(
          hinted ?? (this.#options.backoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** attempt,
          MAX_BACKOFF_MS,
        );
        // Every other MusicBrainz caller in the process waits too.
        this.#limiter.penalize(delay);
        continue;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        throw new MetadataError('not_found', 'Not found in MusicBrainz');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MetadataError(
          response.status === 400 ? 'bad_response' : 'unavailable',
          `MusicBrainz answered ${String(response.status)}`,
        );
      }
      try {
        return await response.text();
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new MetadataError('unavailable', 'MusicBrainz response was cut off', { cause });
      }
    }
  }
}

const pageParams = (page: PageRequest): Record<string, string> => ({
  offset: String(page.offset),
  limit: String(page.limit),
});

function pageOf<T>(items: T[], total: number, page: PageRequest): Page<T> {
  return { items, total, offset: page.offset, limit: page.limit };
}

/** Reject with the signal's reason when it aborts; otherwise settle with the promise. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
