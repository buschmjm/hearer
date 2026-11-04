import { z } from 'zod';
import {
  MediaServerAuthError,
  MediaServerError,
  MediaServerUnavailableError,
  type ExternalUser,
  type IterateLibraryOptions,
  type LibraryItem,
  type LibraryItemKind,
  type MediaServerAdapter,
  type ServerInfo,
} from './types.ts';

/** Jellyfin releases older than this lack reliable support for the modern auth header. */
export const MIN_JELLYFIN_VERSION = [10, 10] as const;
export const ITEMS_PAGE_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
const LIBRARY_TIMEOUT_MS = 60_000;
const TICKS_PER_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JellyfinOptions {
  /** Server base URL; a sub-path (`https://host/jellyfin`) is kept, trailing slashes dropped. */
  url: string;
  /** Admin API key (sent as the `Token` of the MediaBrowser Authorization header). */
  apiKey: string;
  /** Stable identifier for this Hearer install. */
  deviceId: string;
  /** Hearer version, reported as the client version. */
  version: string;
  /** URL browsers use for "Open in Jellyfin" links; defaults to `url`. */
  externalUrl?: string | undefined;
  /** Restrict library iteration to these library (parent) ids. */
  libraryIds?: readonly string[] | undefined;
  /** Items per library page (default 500; tests use small pages). */
  pageSize?: number | undefined;
  /** Per-request timeout. */
  timeoutMs?: number | undefined;
}

/** Trim, validate and strip trailing slashes, query and fragment. Keeps a sub-path. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MediaServerError(`"${raw}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MediaServerError('The media server URL must start with http:// or https://');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Header values cannot contain a double quote, backslash, comma or control character without
 * breaking the header's `Key="value"` list, so those are percent-encoded. Everything Hearer
 * sends (ids, versions, tokens) is plain text, so in practice nothing changes.
 */
export function escapeHeaderValue(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex -- control characters are exactly what we escape
    /["\\,\u0000-\u001f\u007f]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Build the modern `Authorization` header. The only auth mechanism Hearer uses (never X-Emby-*). */
export function buildAuthorizationHeader(
  parts: { deviceId: string; version: string },
  token?: string,
): string {
  const fields: [string, string][] = [
    ['Client', 'Hearer'],
    ['Device', 'Hearer Server'],
    ['DeviceId', parts.deviceId],
    ['Version', parts.version],
  ];
  if (token) fields.push(['Token', token]);
  return `MediaBrowser ${fields.map(([k, v]) => `${k}="${escapeHeaderValue(v)}"`).join(', ')}`;
}

/** True when `version` ("10.11.4") is at least the minimum supported release. */
export function isSupportedVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = MIN_JELLYFIN_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

const policySchema = z.object({
  IsAdministrator: z.boolean().optional(),
  IsDisabled: z.boolean().optional(),
});
const userSchema = z.object({
  Id: z.string().min(1),
  Name: z.string(),
  Policy: policySchema.optional(),
});
const systemInfoSchema = z.object({
  ServerName: z.string().default(''),
  Version: z.string().default(''),
  Id: z.string().default(''),
});
const authResultSchema = z.object({
  User: userSchema,
  AccessToken: z.string().optional(),
});
const itemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().nullish(),
  Type: z.string(),
  Album: z.string().nullish(),
  AlbumArtist: z.string().nullish(),
  Artists: z.array(z.string()).nullish(),
  RunTimeTicks: z.number().nullish(),
  Path: z.string().nullish(),
  DateCreated: z.string().nullish(),
  ProviderIds: z.record(z.string(), z.string().nullable()).nullish(),
});
const itemsPageSchema = z.object({
  Items: z.array(itemSchema).default([]),
  TotalRecordCount: z.number().optional(),
});
type JellyfinItem = z.infer<typeof itemSchema>;

const KIND_BY_TYPE: Readonly<Record<string, LibraryItemKind>> = {
  Audio: 'track',
  MusicAlbum: 'album',
  MusicArtist: 'artist',
};

/**
 * ProviderIds keys read from Jellyfin items (matched case-insensitively):
 *
 * - recording (tracks): `MusicBrainzRecording`, else `MusicBrainzTrack`. UNVERIFIED: Jellyfin
 *   has used `MusicBrainzTrack` for the tag MUSICBRAINZ_TRACKID (which Picard fills with the
 *   *recording* id) and, in newer releases, possibly for MUSICBRAINZ_RELEASETRACKID (a
 *   release-specific id). Both keys are accepted; verify with the live test.
 * - release group: `MusicBrainzReleaseGroup`
 * - release ("album"): `MusicBrainzAlbum`
 * - artist: `MusicBrainzArtist`, else `MusicBrainzAlbumArtist`
 */
export const PROVIDER_KEYS = {
  recording: ['MusicBrainzRecording', 'MusicBrainzTrack'],
  releaseGroup: ['MusicBrainzReleaseGroup'],
  album: ['MusicBrainzAlbum'],
  artist: ['MusicBrainzArtist', 'MusicBrainzAlbumArtist'],
} as const;

function providerId(
  ids: Readonly<Record<string, string | null>> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!ids) return null;
  const lower = new Map(Object.entries(ids).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const value = lower.get(key.toLowerCase())?.trim();
    if (value && UUID.test(value)) return value.toLowerCase();
  }
  return null;
}

/** Map one Jellyfin item to a library item; undefined for types Hearer does not index. */
export function mapItem(item: JellyfinItem): LibraryItem | undefined {
  const kind = KIND_BY_TYPE[item.Type];
  if (!kind) return undefined;
  const ids = item.ProviderIds;
  const firstArtist = item.Artists?.[0] ?? null;
  const created = item.DateCreated ? new Date(item.DateCreated) : null;
  return {
    serverItemId: item.Id,
    kind,
    name: item.Name ?? '',
    artistName:
      kind === 'artist'
        ? null
        : kind === 'track'
          ? (firstArtist ?? item.AlbumArtist ?? null)
          : (item.AlbumArtist ?? firstArtist),
    albumName:
      kind === 'track' ? (item.Album ?? null) : kind === 'album' ? (item.Name ?? null) : null,
    durationMs:
      item.RunTimeTicks === null || item.RunTimeTicks === undefined
        ? null
        : Math.round(item.RunTimeTicks / TICKS_PER_MS),
    mbRecordingId: kind === 'track' ? providerId(ids, PROVIDER_KEYS.recording) : null,
    mbReleaseGroupId: kind === 'artist' ? null : providerId(ids, PROVIDER_KEYS.releaseGroup),
    mbArtistId: providerId(ids, PROVIDER_KEYS.artist),
    mbAlbumId: kind === 'artist' ? null : providerId(ids, PROVIDER_KEYS.album),
    path: item.Path ?? null,
    dateCreated: created && !Number.isNaN(created.getTime()) ? created : null,
  };
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** Send the API key as the header Token. */
  authorized?: boolean;
  /** Bearer token to use instead of the API key (the session of a user we just signed in). */
  token?: string;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export class JellyfinAdapter implements MediaServerAdapter {
  readonly id = 'jellyfin';
  readonly #base: string;
  readonly #external: string;
  readonly #options: JellyfinOptions;

  constructor(options: JellyfinOptions) {
    this.#options = options;
    this.#base = normalizeBaseUrl(options.url);
    this.#external = options.externalUrl ? normalizeBaseUrl(options.externalUrl) : this.#base;
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const url = new URL(`${this.#base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: buildAuthorizationHeader(
        this.#options,
        opts.token ?? (opts.authorized ? this.#options.apiKey : undefined),
      ),
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(
      opts.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const timedOut = timeout.aborted;
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
      throw new MediaServerUnavailableError(
        timedOut
          ? `Media server did not answer within ${String((opts.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`
          : `Cannot reach the media server at ${this.#base}${cause ? ` (${cause})` : ''}`,
        undefined,
        { cause: err },
      );
    }
    if (!res.ok) {
      // Drain the body so the socket is released; it is never shown (it can echo input).
      await res.body?.cancel().catch(() => undefined);
      const status = res.status;
      if (status === 401 || status === 403) {
        throw new MediaServerAuthError(
          opts.token === undefined && opts.authorized
            ? 'The media server rejected the API key'
            : 'The media server rejected the credentials',
          status,
        );
      }
      if (status >= 500) {
        throw new MediaServerUnavailableError(
          `Media server error (HTTP ${String(status)})`,
          status,
        );
      }
      throw new MediaServerError(
        `Unexpected media server response (HTTP ${String(status)}) for ${method} ${path}`,
        status,
      );
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new MediaServerError(
        `The media server sent invalid JSON for ${method} ${path}`,
        res.status,
        {
          cause: err,
        },
      );
    }
  }

  #parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new MediaServerError(`Unexpected ${what} response from the media server`);
    }
    return parsed.data;
  }

  async testConnection(): Promise<ServerInfo> {
    const info = this.#parse(
      systemInfoSchema,
      await this.#request('GET', '/System/Info', { authorized: true }),
      'system info',
    );
    const versionSupported = isSupportedVersion(info.Version);
    const [major, minor] = MIN_JELLYFIN_VERSION;
    return {
      id: info.Id,
      name: info.ServerName,
      version: info.Version,
      versionSupported,
      ...(versionSupported
        ? {}
        : {
            warning: `Jellyfin ${info.Version || '(unknown version)'} is older than ${String(major)}.${String(minor)}; Hearer is tested with 10.10 and newer`,
          }),
    };
  }

  async authenticate(username: string, password: string): Promise<ExternalUser> {
    const result = this.#parse(
      authResultSchema,
      await this.#request('POST', '/Users/AuthenticateByName', {
        body: { Username: username, Pw: password },
      }),
      'authentication',
    );
    // Hearer only needs the identity. End the Jellyfin session this created so signing in does
    // not leave a device entry behind on the server (best effort).
    if (result.AccessToken) {
      await this.#request('POST', '/Sessions/Logout', { token: result.AccessToken }).catch(
        () => undefined,
      );
    }
    return toExternalUser(result.User);
  }

  async listUsers(): Promise<ExternalUser[]> {
    const users = this.#parse(
      z.array(userSchema),
      await this.#request('GET', '/Users', { authorized: true }),
      'user list',
    );
    return users.map(toExternalUser);
  }

  async *iterateLibrary(opts: IterateLibraryOptions = {}): AsyncGenerator<LibraryItem> {
    const parents: (string | undefined)[] = this.#options.libraryIds?.length
      ? [...this.#options.libraryIds]
      : [undefined];
    const pageSize = this.#options.pageSize ?? ITEMS_PAGE_SIZE;
    for (const parentId of parents) {
      let startIndex = 0;
      for (;;) {
        opts.signal?.throwIfAborted();
        const query: Record<string, string> = {
          IncludeItemTypes: 'Audio,MusicAlbum,MusicArtist',
          Recursive: 'true',
          Fields: 'ProviderIds,Path,DateCreated',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          StartIndex: String(startIndex),
          Limit: String(pageSize),
        };
        if (parentId) query.ParentId = parentId;
        if (opts.since) query.MinDateLastSaved = opts.since.toISOString();
        const page = this.#parse(
          itemsPageSchema,
          await this.#request('GET', '/Items', {
            authorized: true,
            query,
            timeoutMs: this.#options.timeoutMs ?? LIBRARY_TIMEOUT_MS,
            signal: opts.signal,
          }),
          'library page',
        );
        for (const item of page.Items) {
          const mapped = mapItem(item);
          if (mapped) yield mapped;
        }
        startIndex += page.Items.length;
        if (
          page.Items.length === 0 ||
          page.Items.length < pageSize ||
          (page.TotalRecordCount !== undefined && startIndex >= page.TotalRecordCount)
        ) {
          break;
        }
      }
    }
  }

  async notifyPathsChanged(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.#request('POST', '/Library/Media/Updated', {
        authorized: true,
        body: { Updates: paths.map((Path) => ({ Path, UpdateType: 'Created' })) },
      });
    } catch (err) {
      // A rejected key will not work for the full refresh either; surface it as is.
      if (err instanceof MediaServerAuthError) throw err;
      await this.refreshLibrary();
    }
  }

  async refreshLibrary(): Promise<void> {
    await this.#request('POST', '/Library/Refresh', { authorized: true });
  }

  itemUrl(serverItemId: string): string {
    return `${this.#external}/web/#/details?id=${encodeURIComponent(serverItemId)}`;
  }
}

function toExternalUser(user: z.infer<typeof userSchema>): ExternalUser {
  return {
    id: user.Id,
    name: user.Name,
    isAdmin: user.Policy?.IsAdministrator === true,
    isDisabled: user.Policy?.IsDisabled === true,
  };
}
