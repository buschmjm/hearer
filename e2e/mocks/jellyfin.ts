import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { listen, sendJson, type MockService } from './http.ts';

const run = promisify(execFile);
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'server',
  'test',
  'fixtures',
  'jellyfin',
);
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aiff']);

export const JELLYFIN_API_KEY = 'e2e-jellyfin-api-key';
export const JELLYFIN_SERVER_ID = '8f1c5e0a7d2b4c6e9a3b1d4f5e6a7b8c';

export interface JellyfinTestUser {
  username: string;
  password: string;
  admin: boolean;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface JellyfinMock extends MockService {
  /** Calls to `/Library/Media/Updated` and `/Library/Refresh`, newest last. */
  readonly rescans: RecordedCall[];
  /** Every call, for debugging. */
  readonly calls: RecordedCall[];
}

export interface JellyfinMockOptions {
  /** Directory scanned for audio files; they are served as the Jellyfin library. */
  libraryDir: string;
  users?: JellyfinTestUser[];
  version?: string;
}

interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  durationTicks: number;
  providerIds: Record<string, string>;
}

const hex32 = (value: string): string =>
  createHash('sha1').update(value).digest('hex').slice(0, 32);

/** ffprobe tag names vary by container; compare them without case, spaces and underscores. */
const normKey = (key: string): string => key.toLowerCase().replace(/[\s_]/gu, '');

async function probe(path: string): Promise<Track | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', path],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const format = (
      JSON.parse(stdout) as { format?: { duration?: string; tags?: Record<string, string> } }
    ).format;
    const tags = new Map(Object.entries(format?.tags ?? {}).map(([k, v]) => [normKey(k), v]));
    const base = path.split('/').pop() ?? path;
    const artist = tags.get('artist') ?? tags.get('albumartist') ?? 'Unknown Artist';
    const providerIds: Record<string, string> = {};
    const ids: [string, string][] = [
      ['musicbrainztrackid', 'MusicBrainzTrack'],
      ['musicbrainzalbumid', 'MusicBrainzAlbum'],
      ['musicbrainzreleasegroupid', 'MusicBrainzReleaseGroup'],
      ['musicbrainzartistid', 'MusicBrainzArtist'],
      ['musicbrainzalbumartistid', 'MusicBrainzAlbumArtist'],
    ];
    for (const [tag, key] of ids) {
      const value = tags.get(tag);
      if (value) providerIds[key] = value;
    }
    return {
      id: hex32(path),
      path,
      title: tags.get('title') ?? base.replace(/\.[^.]+$/u, ''),
      artist,
      albumArtist: tags.get('albumartist') ?? artist,
      album: tags.get('album') ?? 'Unknown Album',
      durationTicks: Math.round(Number(format?.duration ?? '0') * 10_000_000),
      providerIds,
    };
  } catch {
    return null;
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield full;
  }
}

/** Probe results are cached by path + mtime + size so repeated library syncs stay cheap. */
function createLibraryScanner(dir: string): () => Promise<Record<string, unknown>[]> {
  const cache = new Map<string, { key: string; track: Track | null }>();
  return async () => {
    const tracks: Track[] = [];
    for await (const path of walk(dir)) {
      const info = await stat(path);
      const key = `${String(info.mtimeMs)}:${String(info.size)}`;
      let hit = cache.get(path);
      if (hit?.key !== key) {
        hit = { key, track: await probe(path) };
        cache.set(path, hit);
      }
      if (hit.track) tracks.push(hit.track);
    }
    return toItems(tracks);
  };
}

function toItems(tracks: Track[]): Record<string, unknown>[] {
  const created = '2026-01-02T03:04:05.0000000Z';
  const artists = new Map<string, Record<string, unknown>>();
  const albums = new Map<string, Record<string, unknown>>();
  const items: Record<string, unknown>[] = [];
  for (const t of tracks) {
    const artistKey = t.albumArtist.toLowerCase();
    if (!artists.has(artistKey)) {
      const mbid = t.providerIds.MusicBrainzAlbumArtist ?? t.providerIds.MusicBrainzArtist;
      artists.set(artistKey, {
        Name: t.albumArtist,
        ServerId: JELLYFIN_SERVER_ID,
        Id: hex32(`artist:${artistKey}`),
        Type: 'MusicArtist',
        DateCreated: created,
        ProviderIds: mbid ? { MusicBrainzArtist: mbid } : {},
      });
    }
    const albumKey = `${artistKey}\u0000${t.album.toLowerCase()}`;
    if (!albums.has(albumKey)) {
      const ids: Record<string, string> = {};
      if (t.providerIds.MusicBrainzAlbum) ids.MusicBrainzAlbum = t.providerIds.MusicBrainzAlbum;
      if (t.providerIds.MusicBrainzReleaseGroup) {
        ids.MusicBrainzReleaseGroup = t.providerIds.MusicBrainzReleaseGroup;
      }
      albums.set(albumKey, {
        Name: t.album,
        ServerId: JELLYFIN_SERVER_ID,
        Id: hex32(`album:${albumKey}`),
        Type: 'MusicAlbum',
        AlbumArtist: t.albumArtist,
        Path: t.path.slice(0, t.path.lastIndexOf('/')),
        DateCreated: created,
        ProviderIds: ids,
      });
    }
    items.push({
      Name: t.title,
      ServerId: JELLYFIN_SERVER_ID,
      Id: t.id,
      Type: 'Audio',
      Album: t.album,
      AlbumArtist: t.albumArtist,
      Artists: [t.artist],
      RunTimeTicks: t.durationTicks,
      Path: t.path,
      DateCreated: created,
      ProviderIds: t.providerIds,
    });
  }
  return [...artists.values(), ...albums.values(), ...items];
}

function legacyAuth(headers: IncomingHttpHeaders, url: URL): boolean {
  return (
    Object.keys(headers).some(
      (name) => name.startsWith('x-emby-') || name === 'x-mediabrowser-token',
    ) ||
    url.searchParams.has('api_key') ||
    url.searchParams.has('ApiKey')
  );
}

/**
 * A Jellyfin double: modern `Authorization: MediaBrowser ...` header only (legacy `X-Emby-*`
 * headers and `api_key` queries are rejected with 400, as Jellyfin 12 will). Serves
 * System/Info, Users, AuthenticateByName, Items (the audio files under `libraryDir`) and records
 * the rescan calls. Inspect with `GET /__mock/rescans` and `GET /__mock/calls`.
 */
export async function startJellyfinMock(options: JellyfinMockOptions): Promise<JellyfinMock> {
  const users: JellyfinTestUser[] = options.users ?? [
    { username: 'e2e-jellyfin', password: 'jellyfin-pass-1', admin: false },
  ];
  const scan = createLibraryScanner(options.libraryDir);
  const calls: RecordedCall[] = [];
  const rescans: RecordedCall[] = [];

  const service = await listen(async (req, res, url, raw) => {
    const text = raw.toString('utf8');
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = text;
    }
    const call: RecordedCall = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    };
    if (!url.pathname.startsWith('/__mock/')) calls.push(call);

    if (url.pathname === '/__mock/rescans') return sendJson(res, 200, rescans);
    if (url.pathname === '/__mock/calls') return sendJson(res, 200, calls);

    if (legacyAuth(req.headers, url)) {
      return sendJson(res, 400, { error: 'legacy authentication is not supported' });
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== '' && !auth.startsWith('MediaBrowser ')) return sendJson(res, 401);
    const hasKey = auth.includes(`Token="${JELLYFIN_API_KEY}"`);
    const route = `${call.method} ${call.path}`;

    switch (route) {
      case 'GET /System/Info':
        return hasKey
          ? sendJson(res, 200, {
              ...fixture('system-info.json'),
              Version: options.version ?? '10.11.0',
              Id: JELLYFIN_SERVER_ID,
            })
          : sendJson(res, 401);
      case 'POST /Users/AuthenticateByName': {
        const { Username, Pw } = (body ?? {}) as { Username?: string; Pw?: string };
        const user = users.find((u) => u.username === Username);
        if (!user || user.password !== Pw) return sendJson(res, 401);
        const template = fixture('authenticate-by-name.json') as {
          User: { Policy: Record<string, unknown> };
        };
        return sendJson(res, 200, {
          ...template,
          User: {
            ...template.User,
            Name: user.username,
            Id: hex32(`user:${user.username}`),
            Policy: { ...template.User.Policy, IsAdministrator: user.admin },
          },
        });
      }
      case 'POST /Sessions/Logout':
        return sendJson(res, 204);
      case 'GET /Users':
        return hasKey
          ? sendJson(
              res,
              200,
              users.map((u) => ({
                Name: u.username,
                ServerId: JELLYFIN_SERVER_ID,
                Id: hex32(`user:${u.username}`),
                Policy: { IsAdministrator: u.admin, IsDisabled: false, IsHidden: false },
              })),
            )
          : sendJson(res, 401);
      case 'GET /Items': {
        if (!hasKey) return sendJson(res, 401);
        const all = await scan();
        const start = Number(url.searchParams.get('StartIndex') ?? '0');
        const limit = Number(url.searchParams.get('Limit') ?? String(all.length));
        return sendJson(res, 200, {
          Items: all.slice(start, start + limit),
          TotalRecordCount: all.length,
          StartIndex: start,
        });
      }
      case 'POST /Library/Media/Updated':
      case 'POST /Library/Refresh':
        if (!hasKey) return sendJson(res, 401);
        rescans.push(call);
        return sendJson(res, 204);
      default:
        return sendJson(res, 404);
    }
  });

  return { ...service, rescans, calls };
}
