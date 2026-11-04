/* eslint-disable @typescript-eslint/no-confusing-void-expression -- terse early-return style in a test double */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * A small stateful stand-in for the Lidarr v1 API, built from the synthesized fixtures in
 * test/fixtures/lidarr (UNVERIFIED against a real Lidarr; see the README there).
 */
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'lidarr');
const load = (name: string): never =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as never;

export const LIDARR = {
  apiKey: 'lidarr-secret-key',
  artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  albumMbid: 'b1392450-e666-3926-a536-22c65f834433',
  otherAlbumMbid: 'c3b6a1d4-5c1f-4c34-9a0f-0d6a1b7e2f10',
};

interface Artist {
  id: number;
  foreignArtistId: string;
  artistName: string;
  monitored: boolean;
  [key: string]: unknown;
}
interface Album {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  artist: { foreignArtistId: string; artistName: string };
}
interface Command {
  id: number;
  name: string;
  status: string;
  message?: string;
  [key: string]: unknown;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export class LidarrMock {
  server!: Server;
  url = '';
  artists: Artist[] = [];
  albums: Album[] = [];
  /** Albums Lidarr would import for an artist after adding it, keyed by artist mbid. */
  catalog = new Map<string, Album[]>();
  commands: Command[] = [];
  queue: unknown[] = [];
  /** Status given to new commands. */
  commandStatus = 'completed';
  commandMessage: string | undefined;
  /** When true, a newly added artist's albums only appear after `finishRefresh()`. */
  holdRefresh = false;
  #held: Album[] = [];
  /** Respond with this status to the next request whose path matches. */
  failures: {
    match: RegExp;
    status: number;
    body?: string;
    times: number;
    /** Runs when the failure fires (e.g. to change the mock's state first). */
    onHit?: () => void;
  }[] = [];
  log: Recorded[] = [];
  #nextId = 100;

  constructor() {
    const albums = load('artist-albums') as { id: number; title: string; foreignAlbumId: string }[];
    this.catalog.set(
      LIDARR.artistMbid,
      albums.map((a) => ({
        ...a,
        artistId: 0,
        monitored: false,
        artist: { foreignArtistId: LIDARR.artistMbid, artistName: 'Radiohead' },
      })),
    );
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Put an artist (and optionally its albums) straight into Lidarr's database. */
  seedArtist(monitored = false, withAlbums = true): Artist {
    const artist: Artist = {
      id: this.#nextId++,
      foreignArtistId: LIDARR.artistMbid,
      artistName: 'Radiohead',
      monitored,
      monitorNewItems: 'none',
    };
    this.artists.push(artist);
    if (withAlbums) this.#importAlbums(artist);
    return artist;
  }

  finishRefresh(): void {
    this.albums.push(...this.#held);
    this.#held = [];
  }

  requests(method: string, pathPattern: RegExp): Recorded[] {
    return this.log.filter((r) => r.method === method && pathPattern.test(r.path));
  }

  #importAlbums(artist: Artist): void {
    const albums = (this.catalog.get(artist.foreignArtistId) ?? []).map((a) => ({
      ...a,
      id: a.id,
      artistId: artist.id,
    }));
    if (this.holdRefresh) this.#held.push(...albums);
    else this.albums.push(...albums);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    this.log.push({ method, path, query: url.searchParams, headers: req.headers, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (!url.pathname.startsWith('/api/v1/')) return send(404, { message: 'NotFound' });
    if (req.headers['x-api-key'] !== LIDARR.apiKey) return send(401, { error: 'Unauthorized' });
    const failure = this.failures.find((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    if (failure) {
      failure.times -= 1;
      failure.onHit?.();
      res.writeHead(failure.status, { 'content-type': 'application/json' });
      res.end(failure.body ?? '');
      return;
    }
    this.route(method, path, url.searchParams, body, send);
  }

  route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    send: (status: number, payload: unknown) => void,
  ): void {
    const rec = (value: unknown) => value as Record<string, unknown>;
    if (method === 'GET' && path === 'system/status') return send(200, load('system-status'));
    if (method === 'GET' && path === 'qualityprofile') return send(200, load('quality-profiles'));
    if (method === 'GET' && path === 'metadataprofile') return send(200, load('metadata-profiles'));
    if (method === 'GET' && path === 'rootfolder') return send(200, load('root-folders'));

    if (method === 'GET' && path === 'artist') {
      const mbid = query.get('mbId');
      return send(
        200,
        this.artists.filter((a) => !mbid || a.foreignArtistId === mbid),
      );
    }
    if (method === 'GET' && path === 'artist/lookup') {
      const term = query.get('term') ?? '';
      const all = load('artist-lookup') as Record<string, unknown>[];
      return send(
        200,
        all.filter((a) => term === `lidarr:${String(a.foreignArtistId)}`),
      );
    }
    const artistById = /^artist\/(\d+)$/.exec(path);
    if (artistById) {
      const artist = this.artists.find((a) => a.id === Number(artistById[1]));
      if (!artist) return send(404, { message: 'NotFound' });
      if (method === 'GET') return send(200, artist);
      if (method === 'PUT') {
        Object.assign(artist, rec(body));
        return send(202, artist);
      }
    }
    if (method === 'POST' && path === 'artist') {
      const b = rec(body);
      const errors: { errorMessage: string }[] = [];
      for (const field of ['foreignArtistId', 'artistName', 'rootFolderPath']) {
        if (!b[field]) errors.push({ errorMessage: `'${field}' must not be empty.` });
      }
      for (const field of ['qualityProfileId', 'metadataProfileId']) {
        if (typeof b[field] !== 'number' || b[field] <= 0) {
          errors.push({ errorMessage: `Invalid ${field}` });
        }
      }
      if (errors.length > 0) return send(400, errors);
      if (this.artists.some((a) => a.foreignArtistId === b.foreignArtistId)) {
        return send(400, [{ errorMessage: 'This artist has already been added' }]);
      }
      const artist = { ...b, id: this.#nextId++ } as Artist;
      this.artists.push(artist);
      this.#importAlbums(artist);
      return send(201, artist);
    }

    if (method === 'GET' && path === 'album') {
      const foreign = query.get('foreignAlbumId');
      const artistId = query.get('artistId');
      return send(
        200,
        this.albums.filter(
          (a) =>
            (!foreign || a.foreignAlbumId === foreign) &&
            (!artistId || a.artistId === Number(artistId)),
        ),
      );
    }
    if (method === 'GET' && path === 'album/lookup') {
      const term = query.get('term') ?? '';
      const all = load('album-lookup') as Record<string, unknown>[];
      return send(
        200,
        all.filter((a) => term === `lidarr:${String(a.foreignAlbumId)}`),
      );
    }
    if (method === 'PUT' && path === 'album/monitor') {
      const b = rec(body) as { albumIds: number[]; monitored: boolean };
      const touched = this.albums.filter((a) => b.albumIds.includes(a.id));
      for (const album of touched) album.monitored = b.monitored;
      return send(202, touched);
    }

    if (method === 'POST' && path === 'command') {
      const command: Command = {
        ...rec(body),
        id: this.#nextId++,
        name: String(rec(body).name),
        status: this.commandStatus,
        ...(this.commandMessage ? { message: this.commandMessage } : {}),
      };
      this.commands.push(command);
      return send(201, command);
    }
    const commandById = /^command\/(\d+)$/.exec(path);
    if (method === 'GET' && commandById) {
      const command = this.commands.find((c) => c.id === Number(commandById[1]));
      return command ? send(200, command) : send(404, { message: 'NotFound' });
    }
    if (method === 'GET' && path === 'queue/details') return send(200, this.queue);
    send(404, { message: 'NotFound' });
  }
}

export const queueFixture = (): unknown[] => load('queue-details') as unknown[];
