import { randomUUID } from 'node:crypto';
import {
  Permission,
  type ArtistDetail,
  type Page,
  type RecordingDetail,
  type ReleaseGroupDetail,
  type ReleaseGroupSummary,
  type SearchResponse,
} from '@hearer/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryLookup } from '../src/services/badges.ts';
import { libraryItems, requests } from '../src/db/schema.ts';
import { RateLimiter } from '../src/lib/ratelimit.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import { FixtureServer, IDS, nth } from './helpers/mbServer.ts';

let server: FixtureServer;
let h: Harness;
let creds: Credentials;
let userId: string;

beforeAll(async () => {
  server = await FixtureServer.start();
});
afterAll(async () => {
  await server.stop();
});

async function start(deps: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness({
    ...deps,
    deps: {
      metadataOptions: { limiter: new RateLimiter({ intervalMs: 0 }), version: '1.2.3' },
      ...deps.deps,
    },
  });
  h.app.hearer.settings.set('metadata', { musicBrainzBaseUrl: server.baseUrl });
  await completeSetup(h);
  userId = await addUser(h.app, 'listener', Permission.REQUEST);
  creds = await login(h.app, 'listener');
}

beforeEach(() => {
  server.requests.length = 0;
  server.override = undefined;
});
afterEach(async () => {
  await h.cleanup();
});

const get = (url: string, as: Credentials | undefined = creds) => call(h.app, as, 'GET', url);

function seedRequest(
  type: 'artist' | 'album' | 'track',
  mbid: string,
  status: (typeof requests.$inferInsert)['status'],
  createdAt: number,
) {
  const id = randomUUID();
  h.app.hearer.database.db
    .insert(requests)
    .values({
      id,
      type,
      mbid,
      title: 'x',
      status,
      requestedBy: userId,
      createdAt: new Date(createdAt),
    })
    .run();
  return id;
}

describe('authentication and validation', () => {
  it('answers 401 to anonymous callers on every catalog route', async () => {
    await start();
    for (const url of [
      '/api/v1/search?q=radiohead',
      `/api/v1/artists/${IDS.artist}`,
      `/api/v1/artists/${IDS.artist}/albums`,
      `/api/v1/albums/${IDS.releaseGroup}`,
      `/api/v1/tracks/${IDS.recording}`,
    ]) {
      const res = await call(h.app, undefined, 'GET', url);
      expect(res.statusCode, url).toBe(401);
    }
    expect(server.requests).toHaveLength(0);
  });

  it('lets any signed-in user, even one without permissions, search', async () => {
    await start();
    await addUser(h.app, 'nobody', 0);
    const nobody = await login(h.app, 'nobody');
    expect((await get('/api/v1/search?q=radiohead', nobody)).statusCode).toBe(200);
  });

  it('rejects malformed ids with 400 before calling MusicBrainz', async () => {
    await start();
    for (const url of [
      '/api/v1/artists/not-a-uuid',
      '/api/v1/artists/not-a-uuid/albums',
      '/api/v1/albums/12345',
      `/api/v1/tracks/${IDS.recording}0`,
      '/api/v1/tracks/..%2F..%2Fetc',
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('accepts upper-case ids and queries MusicBrainz with the lower-case form', async () => {
    await start();
    const res = await get(`/api/v1/artists/${IDS.artist.toUpperCase()}`);
    expect(res.statusCode).toBe(200);
    expect(server.requests[0]?.path).toBe(`artist/${IDS.artist}`);
  });

  it('validates search parameters and pagination bounds', async () => {
    await start();
    const bad = [
      '/api/v1/search',
      '/api/v1/search?q=',
      '/api/v1/search?q=%20%20',
      `/api/v1/search?q=${'a'.repeat(201)}`,
      '/api/v1/search?q=x&type=playlist',
      '/api/v1/search?q=x&limit=0',
      '/api/v1/search?q=x&limit=51',
      '/api/v1/search?q=x&limit=abc',
      '/api/v1/search?q=x&offset=-1',
      '/api/v1/search?q=x&offset=10001',
      `/api/v1/artists/${IDS.artist}/albums?limit=51`,
      `/api/v1/artists/${IDS.artist}/albums?type=bootleg`,
    ];
    for (const url of bad) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
    expect(server.requests).toHaveLength(0);
    expect((await get('/api/v1/search?q=x&limit=50&offset=10000')).statusCode).toBe(200);
    expect(server.requests[0]?.query.get('limit')).toBe('50');
    expect(server.requests[0]?.query.get('offset')).toBe('10000');
  });
});

describe('search', () => {
  it('defaults to album search, 20 per page, and returns the page envelope', async () => {
    await start();
    const res = await get('/api/v1/search?q=Radiohead%20OK%20Computer');
    expect(res.statusCode).toBe(200);
    const body = res.json<Extract<SearchResponse, { type: 'album' }>>();
    expect(body).toMatchObject({ type: 'album', total: 3895, offset: 0, limit: 20 });
    expect(body.items[0]).toMatchObject({
      mbid: IDS.releaseGroup,
      title: 'OK Computer',
      inLibrary: 'no',
      request: null,
    });
    expect(server.requests[0]?.query.get('limit')).toBe('20');
  });

  it('searches artists and tracks', async () => {
    await start();
    const artists = (await get('/api/v1/search?q=Radiohead&type=artist')).json<
      Extract<SearchResponse, { type: 'artist' }>
    >();
    expect(artists.type).toBe('artist');
    expect(artists.items[0]).toMatchObject({ name: 'Radiohead', inLibrary: 'no', request: null });
    const tracks = (await get('/api/v1/search?q=Paranoid&type=track&limit=3')).json<
      Extract<SearchResponse, { type: 'track' }>
    >();
    expect(tracks.type).toBe('track');
    expect(tracks.items).toHaveLength(3);
    expect(tracks.limit).toBe(3);
  });

  it('serves repeated searches from the cache', async () => {
    await start();
    await get('/api/v1/search?q=radiohead');
    await get('/api/v1/search?q=radiohead');
    expect(server.requests).toHaveLength(1);
  });

  it('adds library and request badges to results', async () => {
    await start();
    const db = h.app.hearer.database.db;
    db.insert(libraryItems)
      .values({
        serverItemId: 'jf-1',
        kind: 'album',
        name: 'OK Computer',
        mbReleaseGroupId: IDS.releaseGroup,
      })
      .run();
    seedRequest('album', IDS.releaseGroup, 'APPROVED', 1_000);
    const res = await get('/api/v1/search?q=Radiohead%20OK%20Computer');
    const items = res.json<Page<ReleaseGroupSummary>>().items;
    expect(items[0]).toMatchObject({
      inLibrary: 'yes',
      request: { status: 'APPROVED' },
    });
    expect(items.slice(1).every((i) => i.inLibrary === 'no' && i.request === null)).toBe(true);
  });

  it('reports the latest non-cancelled request, never a cancelled one', async () => {
    await start();
    const older = seedRequest('album', IDS.releaseGroup, 'DECLINED', 1_000);
    seedRequest('album', IDS.releaseGroup, 'CANCELLED', 3_000);
    const read = async () =>
      (await get('/api/v1/search?q=OK%20Computer')).json<Page<ReleaseGroupSummary>>().items[0];
    expect((await read())?.request).toEqual({ id: older, status: 'DECLINED' });
    const newest = seedRequest('album', IDS.releaseGroup, 'PENDING', 2_000);
    expect((await read())?.request).toEqual({ id: newest, status: 'PENDING' });
  });

  it('keys request badges by type, so a track request does not mark the album', async () => {
    await start();
    seedRequest('track', IDS.releaseGroup, 'PENDING', 1_000);
    seedRequest('artist', IDS.releaseGroup, 'PENDING', 1_000);
    const items = (await get('/api/v1/search?q=OK%20Computer')).json<Page<ReleaseGroupSummary>>()
      .items;
    expect(items[0]?.request).toBeNull();
  });

  it('answers 502 when MusicBrainz is down, with a stable error code', async () => {
    await start({
      deps: { metadataOptions: { limiter: new RateLimiter({ intervalMs: 0 }), maxRetries: 0 } },
    });
    server.override = () => ({ status: 503 });
    const res = await get('/api/v1/search?q=anything');
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('metadata_unavailable');
  });

  it('is rate limited per user, not per address', async () => {
    await start({ deps: { searchRateLimitMax: 2 } });
    await addUser(h.app, 'second', Permission.REQUEST);
    const second = await login(h.app, 'second');
    expect((await get('/api/v1/search?q=a')).statusCode).toBe(200);
    expect((await get('/api/v1/search?q=b')).statusCode).toBe(200);
    const limited = await get('/api/v1/search?q=c');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    // Same IP, different user: unaffected.
    expect((await get('/api/v1/search?q=d', second)).statusCode).toBe(200);
  });
});

describe('browse', () => {
  it('returns an artist with badges', async () => {
    await start();
    h.app.hearer.database.db
      .insert(libraryItems)
      .values({ serverItemId: 'jf-a', kind: 'artist', name: 'Radiohead', mbArtistId: IDS.artist })
      .run();
    const artist = (await get(`/api/v1/artists/${IDS.artist}`)).json<ArtistDetail>();
    expect(artist).toMatchObject({
      mbid: IDS.artist,
      name: 'Radiohead',
      inLibrary: 'yes',
      request: null,
    });
  });

  it("lists an artist's albums, filtered by primary type, in pages", async () => {
    await start();
    seedRequest('album', IDS.releaseGroup, 'AVAILABLE', 1_000);
    const res = await get(`/api/v1/artists/${IDS.artist}/albums?type=album&limit=5&offset=10`);
    expect(res.statusCode).toBe(200);
    const page = res.json<Page<ReleaseGroupSummary>>();
    expect(page).toMatchObject({ total: 388, offset: 10, limit: 5 });
    expect(page.items[0]).toMatchObject({
      mbid: IDS.releaseGroup,
      request: { status: 'AVAILABLE' },
    });
    const sent = nth(server.requests, 0);
    expect(sent.query.get('type')).toBe('album');
    expect(sent.query.get('offset')).toBe('10');
    expect(sent.query.get('limit')).toBe('5');
  });

  it('returns an album with tracklist badges resolved in a fixed number of queries', async () => {
    await start();
    const db = h.app.hearer.database;
    db.db
      .insert(libraryItems)
      .values({ serverItemId: 'jf-t', kind: 'track', name: 'Airbag', mbRecordingId: IDS.airbag })
      .run();
    seedRequest('track', IDS.recording, 'PENDING', 1_000);
    const prepare = vi.spyOn(db.sqlite, 'prepare');
    const res = await get(`/api/v1/albums/${IDS.releaseGroup}`);
    expect(res.statusCode).toBe(200);
    const sql = prepare.mock.calls.map(([text]) => text);
    expect(sql.filter((q) => /from "requests"/i.test(q))).toHaveLength(1);
    // One exact and one fuzzy (name hint) query per kind, however many tracks the album has.
    expect(sql.filter((q) => /from "library_items"/i.test(q)).length).toBeLessThanOrEqual(4);

    const album = res.json<ReleaseGroupDetail>();
    expect(album.tracks).toHaveLength(12);
    expect(album.representativeRelease?.mbid).toBe(IDS.release);
    expect(album.tracks[0]).toMatchObject({ title: 'Airbag', inLibrary: 'yes', request: null });
    expect(album.tracks[1]).toMatchObject({
      title: 'Paranoid Android',
      inLibrary: 'no',
      request: { status: 'PENDING' },
    });
    expect(album).toMatchObject({ inLibrary: 'no', request: null });
  });

  it('returns a track with its ISRCs, length and album badges', async () => {
    await start();
    seedRequest('album', IDS.releaseGroup, 'PROCESSING', 1_000);
    const track = (await get(`/api/v1/tracks/${IDS.recording}`)).json<RecordingDetail>();
    expect(track).toMatchObject({
      mbid: IDS.recording,
      lengthMs: 384_000,
      isrcs: ['GBAYE9701376', 'GBBKS1700108'],
      inLibrary: 'no',
    });
    expect(track.releaseGroups[0]).toMatchObject({
      mbid: IDS.releaseGroup,
      request: { status: 'PROCESSING' },
    });
  });

  it('maps MusicBrainz 404 to 404 and does not leak upstream details', async () => {
    await start();
    server.override = () => ({ status: 404, body: '{"error":"secret upstream text"}' });
    const res = await get(`/api/v1/albums/${IDS.releaseGroup}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret upstream text');
  });
});

describe('library lookup seam', () => {
  it('uses an injected lookup, so fuzzy matching can report "possible"', async () => {
    const fuzzy: LibraryLookup = {
      lookup: (ids) => ({
        artists: new Map(),
        albums: new Map(ids.albums.slice(0, 1).map((id) => [id, 'possible' as const])),
        tracks: new Map(),
      }),
    };
    await start({ deps: { libraryLookup: fuzzy } });
    const items = (await get('/api/v1/search?q=OK%20Computer')).json<Page<ReleaseGroupSummary>>()
      .items;
    expect(items[0]?.inLibrary).toBe('possible');
    expect(items[1]?.inLibrary).toBe('no');
  });
});
