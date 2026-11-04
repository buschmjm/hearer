/**
 * Lidarr fulfillment (Lidarr v1 API: `/api/v1`, header `X-Api-Key`).
 *
 * > Unverified: there is no live Lidarr to test against. Endpoints, parameters and field names
 * > follow Lidarr's published OpenAPI document (src/Lidarr.Api.V1/openapi.json on the develop
 * > branch); the test fixtures are synthesized from it. Command payloads (`ArtistSearch`,
 * > `AlbumSearch`) are not described by that document and follow the Servarr wiki. See
 * > docs/ADAPTERS.md.
 *
 * Flows (all steps idempotent, so a retried submit just continues):
 *   artist  GET artist?mbId=<mbid>. Unknown: GET artist/lookup?term=lidarr:<mbid>, then POST
 *           artist (monitored, monitorNewItems all, addOptions monitor all + search). Known:
 *           PUT it monitored, monitor all its albums and POST command ArtistSearch.
 *   album   GET album?foreignAlbumId=<rg>. Unknown: album/lookup?term=lidarr:<rg> names the
 *           artist; add the artist with nothing monitored and no search; the artist's albums
 *           arrive after Lidarr refreshes it, so an album that is not there yet is a
 *           ProviderTemporaryError (the submit job retries with backoff). Then PUT
 *           album/monitor and POST command AlbumSearch.
 *   track   the parent release group is requested as an album (`trackPolicy: 'album'`);
 *           `'skip'`, or a recording without a release group, raises ProviderSkipError so the
 *           registry falls back to Manual.
 * `poll` only reports queue and command state for the timeline; completion is detected by the
 * library availability sync, so files that arrive by any route count.
 */
import { REDACTED_SECRET, lidarrSettingsSchema, type LidarrSettings } from '@hearer/shared';
import { z } from 'zod';
import type { MetadataProvider } from '../metadata/types.ts';
import {
  ProviderPermanentError,
  ProviderSkipError,
  ProviderTemporaryError,
  type CallOptions,
  type ConnectionTestResult,
  type FulfillmentProvider,
  type PollResult,
  type RequestRecord,
  type SubmitResult,
} from './types.ts';

export const LIDARR_PROVIDER_ID = 'lidarr';
export const LIDARR_DEFAULT_TIMEOUT_MS = 15_000;

export const lidarrConfigSchema = lidarrSettingsSchema;

export interface LidarrDeps {
  /** Only `getRecording` is used, to find a track's release group when the request lacks it. */
  metadata: Pick<MetadataProvider, 'getRecording'>;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  version?: string | undefined;
}

/** What `provider_ref` holds: enough to poll and cancel without asking Lidarr to search again. */
const refSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['artist', 'album']),
  artistId: z.number().int(),
  artistMbid: z.string(),
  /** True when this request added the artist to Lidarr (cancel then unmonitors it). */
  artistAdded: z.boolean(),
  albumId: z.number().int().optional(),
  albumMbid: z.string().optional(),
  commandId: z.number().int().optional(),
});
export type LidarrRef = z.infer<typeof refSchema>;

export function parseLidarrRef(ref: string): LidarrRef {
  try {
    return refSchema.parse(JSON.parse(ref));
  } catch (err) {
    throw new ProviderPermanentError('The stored Lidarr reference is not valid', { cause: err });
  }
}

// --- the slices of Lidarr's responses we read (lenient: unknown fields pass through) ----------

const idName = z.object({ id: z.number().int(), name: z.string() });
const artistSchema = z.looseObject({
  id: z.number().int(),
  artistName: z.string().optional(),
  foreignArtistId: z.string().optional(),
  monitored: z.boolean().optional(),
});
const albumSchema = z.looseObject({
  id: z.number().int(),
  title: z.string().optional(),
  artistId: z.number().int().optional(),
  foreignAlbumId: z.string().optional(),
  monitored: z.boolean().optional(),
  artist: z
    .looseObject({ foreignArtistId: z.string().optional(), artistName: z.string().optional() })
    .optional(),
});
const lookupArtistSchema = z.looseObject({
  foreignArtistId: z.string(),
  artistName: z.string(),
});
const commandSchema = z.looseObject({
  id: z.number().int(),
  status: z.string().optional(),
  message: z.string().nullish(),
});
const queueItemSchema = z.looseObject({
  title: z.string().nullish(),
  status: z.string().nullish(),
  trackedDownloadStatus: z.string().nullish(),
  trackedDownloadState: z.string().nullish(),
  errorMessage: z.string().nullish(),
  size: z.number().nullish(),
  sizeleft: z.number().nullish(),
});
const systemStatusSchema = z.looseObject({
  appName: z.string().optional(),
  version: z.string().optional(),
});
const rootFolderSchema = z.looseObject({
  id: z.number().int(),
  path: z.string(),
  name: z.string().nullish(),
  freeSpace: z.number().nullish(),
});

export interface LidarrOptions {
  qualityProfiles: { id: number; name: string }[];
  metadataProfiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string; name: string | null; freeSpace: number | null }[];
}

/** Thrown inside the client for a 404 so callers can tell "missing" from other failures. */
class LidarrNotFound extends Error {}

const MAX_DETAIL = 300;
const clip = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;

export class LidarrProvider implements FulfillmentProvider {
  readonly id = LIDARR_PROVIDER_ID;
  readonly label = 'Lidarr';
  readonly configSchema = lidarrConfigSchema;
  readonly #config: LidarrSettings;
  readonly #deps: LidarrDeps;

  constructor(config: LidarrSettings, deps: LidarrDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /** Track requests are only handled when the admin chose to request the parent album. */
  get supports(): FulfillmentProvider['supports'] {
    return { track: this.#config.trackPolicy === 'album', album: true, artist: true };
  }

  describeConfig(): Record<string, unknown> {
    return { ...this.#config, apiKey: this.#config.apiKey ? REDACTED_SECRET : '' };
  }

  // --- FulfillmentProvider ------------------------------------------------------------------

  async testConnection(options: CallOptions = {}): Promise<ConnectionTestResult> {
    try {
      this.#requireConnection();
      const status = systemStatusSchema.parse(await this.#get('system/status', {}, options));
      return {
        ok: true,
        ...(status.version ? { version: status.version } : {}),
        message: `Connected to ${status.appName ?? 'Lidarr'}${status.version ? ` ${status.version}` : ''}`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Quality profiles, metadata profiles and root folders, for the settings form. */
  async options(options: CallOptions = {}): Promise<LidarrOptions> {
    this.#requireConnection();
    const [quality, metadata, folders] = await Promise.all([
      this.#get('qualityprofile', {}, options),
      this.#get('metadataprofile', {}, options),
      this.#get('rootfolder', {}, options),
    ]);
    return {
      qualityProfiles: z
        .array(idName.loose())
        .parse(quality)
        .map((p) => ({ id: p.id, name: p.name })),
      metadataProfiles: z
        .array(idName.loose())
        .parse(metadata)
        .map((p) => ({ id: p.id, name: p.name })),
      rootFolders: z
        .array(rootFolderSchema)
        .parse(folders)
        .map((f) => ({
          id: f.id,
          path: f.path,
          name: f.name ?? null,
          freeSpace: f.freeSpace ?? null,
        })),
    };
  }

  async submit(request: RequestRecord, options: CallOptions = {}): Promise<SubmitResult> {
    this.#requireReady();
    switch (request.type) {
      case 'artist':
        return this.#submitArtist(request.mbid, options);
      case 'album':
        return this.#submitAlbum(request.mbid, undefined, options);
      case 'track': {
        if (this.#config.trackPolicy === 'skip') {
          throw new ProviderSkipError('Lidarr is set to skip track requests');
        }
        const parent = await this.#parentAlbum(request, options);
        return this.#submitAlbum(parent, `Track request: asked Lidarr for its album`, options);
      }
    }
  }

  async poll(ref: string, options: CallOptions = {}): Promise<PollResult> {
    this.#requireConnection();
    const parsed = parseLidarrRef(ref);
    const queue = z
      .array(queueItemSchema)
      .parse(
        await this.#get(
          'queue/details',
          parsed.kind === 'album' && parsed.albumId !== undefined
            ? { albumIds: [parsed.albumId], includeAlbum: false }
            : { artistId: parsed.artistId, includeAlbum: false },
          options,
        ),
      );
    let command: z.infer<typeof commandSchema> | null = null;
    if (parsed.commandId !== undefined) {
      try {
        command = commandSchema.parse(
          await this.#get(`command/${String(parsed.commandId)}`, {}, options),
        );
      } catch (err) {
        // Lidarr forgets old commands; that is not a failure.
        if (!(err instanceof LidarrNotFound)) throw err;
      }
    }
    if (command?.status === 'failed') {
      return {
        state: 'failed',
        detail: clip(`The Lidarr search failed${command.message ? `: ${command.message}` : ''}`),
      };
    }
    if (queue.length > 0) return { state: 'pending', detail: describeQueue(queue) };
    if (command?.status === 'completed') {
      return { state: 'done', detail: 'The Lidarr search finished and nothing is downloading' };
    }
    return {
      state: 'pending',
      detail: command?.status ? `Lidarr search ${command.status}` : 'Waiting for Lidarr',
    };
  }

  /** Stop wanting it: unmonitor the album, or the artist if this request added it. */
  async cancel(ref: string, options: CallOptions = {}): Promise<void> {
    this.#requireConnection();
    const parsed = parseLidarrRef(ref);
    if (parsed.kind === 'album' && parsed.albumId !== undefined) {
      await this.#put('album/monitor', { albumIds: [parsed.albumId], monitored: false }, options);
      return;
    }
    if (parsed.kind === 'artist' && parsed.artistAdded) {
      const artist = await this.#get(`artist/${String(parsed.artistId)}`, {}, options);
      await this.#put(
        `artist/${String(parsed.artistId)}`,
        { ...recordOf(artist), monitored: false },
        options,
      );
    }
    // An artist that was already in Lidarr stays as the admin had it.
  }

  // --- flows --------------------------------------------------------------------------------

  async #parentAlbum(request: RequestRecord, options: CallOptions): Promise<string> {
    if (request.parentMbid) return request.parentMbid;
    const recording = await this.#deps.metadata
      .getRecording(request.mbid, options.signal ? { signal: options.signal } : {})
      .catch((err: unknown) => {
        throw new ProviderTemporaryError("Could not look up the track's album", { cause: err });
      });
    const group = recording.releaseGroup ?? recording.releaseGroups[0];
    if (!group) throw new ProviderSkipError('The track is not on any album');
    return group.mbid;
  }

  async #submitArtist(artistMbid: string, options: CallOptions): Promise<SubmitResult> {
    let artist = await this.#findArtist(artistMbid, options);
    if (!artist) {
      const created = await this.#addArtist(artistMbid, { allAlbums: true }, options);
      if (created) {
        return this.#artistResult(
          created.id,
          artistMbid,
          true,
          undefined,
          'Added the artist to Lidarr and started a search',
        );
      }
      // Another request added it first; carry on as for any artist Lidarr already has.
      artist = await this.#findArtist(artistMbid, options);
      if (!artist) throw new ProviderTemporaryError('Lidarr has not finished adding the artist');
    }
    // Known artist: make sure it is wanted, then ask for everything it has.
    artist = artistSchema.parse(
      await this.#put(
        `artist/${String(artist.id)}`,
        { ...artist, monitored: true, monitorNewItems: 'all' },
        options,
      ),
    );
    const albums = z
      .array(albumSchema)
      .parse(await this.#get('album', { artistId: artist.id }, options));
    if (albums.length > 0) {
      await this.#put(
        'album/monitor',
        { albumIds: albums.map((a) => a.id), monitored: true },
        options,
      );
    }
    const command = await this.#command({ name: 'ArtistSearch', artistId: artist.id }, options);
    return this.#artistResult(
      artist.id,
      artistMbid,
      false,
      command.id,
      'Monitored the artist in Lidarr and started a search',
    );
  }

  #artistResult(
    artistId: number,
    artistMbid: string,
    artistAdded: boolean,
    commandId: number | undefined,
    note: string,
  ): SubmitResult {
    const ref: LidarrRef = {
      v: 1,
      kind: 'artist',
      artistId,
      artistMbid,
      artistAdded,
      ...(commandId === undefined ? {} : { commandId }),
    };
    return { ref: JSON.stringify(ref), status: 'PROCESSING', note };
  }

  async #submitAlbum(
    albumMbid: string,
    notePrefix: string | undefined,
    options: CallOptions,
  ): Promise<SubmitResult> {
    let album = await this.#findAlbum(albumMbid, options);
    let artistAdded = false;
    let artistMbid = album?.artist?.foreignArtistId ?? '';
    if (!album) {
      const lookup = await this.#lookupAlbumArtist(albumMbid, options);
      artistMbid = lookup.artistMbid;
      if (!(await this.#findArtist(lookup.artistMbid, options))) {
        await this.#addArtist(
          lookup.artistMbid,
          { allAlbums: false, name: lookup.artistName },
          options,
        );
        artistAdded = true;
      }
      album = await this.#findAlbum(albumMbid, options);
      if (!album) {
        // A freshly added artist is refreshed in the background, so its albums show up later.
        throw new ProviderTemporaryError(
          `Lidarr has not imported "${lookup.title}" yet (its metadata profile may also exclude this release type)`,
        );
      }
    }
    const artistId = album.artistId ?? 0;
    await this.#put('album/monitor', { albumIds: [album.id], monitored: true }, options);
    const command = await this.#command({ name: 'AlbumSearch', albumIds: [album.id] }, options);
    const ref: LidarrRef = {
      v: 1,
      kind: 'album',
      artistId,
      artistMbid,
      artistAdded,
      albumId: album.id,
      albumMbid,
      commandId: command.id,
    };
    const note = `Monitored "${album.title ?? albumMbid}" in Lidarr and started a search`;
    return {
      ref: JSON.stringify(ref),
      status: 'PROCESSING',
      note: notePrefix ? `${notePrefix}. ${note}` : note,
    };
  }

  async #findArtist(mbid: string, options: CallOptions) {
    const found = z.array(artistSchema).parse(await this.#get('artist', { mbId: mbid }, options));
    return found.find((a) => a.foreignArtistId === undefined || a.foreignArtistId === mbid) ?? null;
  }

  async #findAlbum(mbid: string, options: CallOptions) {
    const found = z
      .array(albumSchema)
      .parse(await this.#get('album', { foreignAlbumId: mbid }, options));
    return found.find((a) => a.foreignAlbumId === undefined || a.foreignAlbumId === mbid) ?? null;
  }

  /** Lidarr's own metadata names the album's artist, so no MusicBrainz call is needed. */
  async #lookupAlbumArtist(
    albumMbid: string,
    options: CallOptions,
  ): Promise<{ artistMbid: string; artistName: string; title: string }> {
    const results = z
      .array(albumSchema)
      .parse(await this.#get('album/lookup', { term: `lidarr:${albumMbid}` }, options));
    const hit = results.find((a) => a.foreignAlbumId === albumMbid) ?? results[0];
    const artistMbid = hit?.artist?.foreignArtistId;
    if (!hit || !artistMbid) {
      throw new ProviderPermanentError('Lidarr does not know this album');
    }
    return {
      artistMbid,
      artistName: hit.artist?.artistName ?? '',
      title: hit.title ?? albumMbid,
    };
  }

  /**
   * Add an artist. Album requests add it with nothing monitored and no search (the album is
   * monitored afterwards); artist requests monitor everything and let Lidarr search. Returns
   * null when the artist turned out to exist already (another request added it meanwhile).
   */
  async #addArtist(
    mbid: string,
    mode: { allAlbums: boolean; name?: string },
    options: CallOptions,
  ): Promise<z.infer<typeof artistSchema> | null> {
    const candidates = z
      .array(lookupArtistSchema)
      .parse(await this.#get('artist/lookup', { term: `lidarr:${mbid}` }, options));
    const hit = candidates.find((c) => c.foreignArtistId === mbid) ?? candidates[0];
    if (!hit) throw new ProviderPermanentError('Lidarr does not know this artist');
    const body = {
      foreignArtistId: hit.foreignArtistId,
      artistName: hit.artistName === '' ? (mode.name ?? '') : hit.artistName,
      qualityProfileId: this.#config.qualityProfileId,
      metadataProfileId: this.#config.metadataProfileId,
      rootFolderPath: this.#config.rootFolder,
      monitored: true,
      monitorNewItems: mode.allAlbums ? 'all' : 'none',
      addOptions: {
        monitor: mode.allAlbums ? 'all' : 'none',
        searchForMissingAlbums: mode.allAlbums,
      },
    };
    try {
      return artistSchema.parse(await this.#send('POST', 'artist', {}, body, options));
    } catch (err) {
      // Lost a race with another request for the same artist: report that it exists now.
      if (
        err instanceof ProviderPermanentError &&
        (await this.#findArtist(mbid, options).catch(() => null))
      ) {
        return null;
      }
      throw err;
    }
  }

  #command(body: Record<string, unknown>, options: CallOptions) {
    return this.#send('POST', 'command', {}, body, options).then((r) => commandSchema.parse(r));
  }

  // --- HTTP ---------------------------------------------------------------------------------

  #requireConnection(): void {
    if (!this.#config.url || !this.#config.apiKey) {
      throw new ProviderPermanentError('Lidarr needs a URL and an API key');
    }
  }

  #requireReady(): void {
    this.#requireConnection();
    const missing: string[] = [];
    if (!this.#config.rootFolder) missing.push('a root folder');
    if (this.#config.qualityProfileId <= 0) missing.push('a quality profile');
    if (this.#config.metadataProfileId <= 0) missing.push('a metadata profile');
    if (missing.length > 0) {
      throw new ProviderPermanentError(
        `Lidarr settings are incomplete: choose ${missing.join(', ')}`,
      );
    }
  }

  #get(path: string, query: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    return this.#send('GET', path, query, undefined, options);
  }

  #put(path: string, body: unknown, options: CallOptions): Promise<unknown> {
    return this.#send('PUT', path, {}, body, options);
  }

  async #send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query: Record<string, unknown>,
    body: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const url = new URL(`${this.#config.url.replace(/\/+$/, '')}/api/v1/${path}`);
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(item));
      }
    }
    const timeout = AbortSignal.timeout(this.#deps.timeoutMs ?? LIDARR_DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.#deps.fetch ?? fetch)(url, {
        method,
        headers: {
          'X-Api-Key': this.#config.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'User-Agent': `Hearer/${this.#deps.version ?? '0'}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw new ProviderTemporaryError(`Lidarr is not reachable: ${describeNetworkError(err)}`, {
        cause: err,
      });
    }
    const text = await response.text().catch(() => '');
    if (response.ok) {
      if (text === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new ProviderTemporaryError('Lidarr sent a response that is not JSON', { cause: err });
      }
    }
    const detail = errorDetail(text);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderPermanentError('Lidarr rejected the API key');
    }
    if (response.status === 404) throw new LidarrNotFound(`Lidarr has no ${path}`);
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderTemporaryError(`Lidarr answered ${String(response.status)}${detail}`);
    }
    throw new ProviderPermanentError(
      `Lidarr refused ${method} ${path} (${String(response.status)})${detail}`,
    );
  }
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return clip(`${err.message}${cause}`);
  }
  return 'unknown error';
}

/** Lidarr reports validation problems as `[{ errorMessage }]` or `{ message }`. */
function errorDetail(text: string): string {
  if (text === '') return '';
  try {
    const parsed: unknown = JSON.parse(text);
    const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    const record = recordOf(first);
    const message = record.errorMessage ?? record.message;
    if (typeof message === 'string' && message) return `: ${clip(message)}`;
  } catch {
    // not JSON (a proxy error page): fall through
  }
  return '';
}

function describeQueue(queue: z.infer<typeof queueItemSchema>[]): string {
  const problem = queue.find((q) => q.trackedDownloadStatus && q.trackedDownloadStatus !== 'ok');
  if (problem) {
    return clip(
      `${problem.title ?? 'A download'}: ${problem.trackedDownloadState ?? problem.status ?? 'problem'}${
        problem.errorMessage ? ` (${problem.errorMessage})` : ''
      }`,
    );
  }
  const total = queue.reduce((sum, q) => sum + (q.size ?? 0), 0);
  const left = queue.reduce((sum, q) => sum + (q.sizeleft ?? 0), 0);
  const pct = total > 0 ? Math.round(((total - left) / total) * 100) : null;
  return `Downloading ${String(queue.length)} item${queue.length === 1 ? '' : 's'}${pct === null ? '' : ` (${String(pct)}%)`}`;
}
