import { REDACTED_SECRET, Permission, type LidarrSettings } from '@hearer/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LidarrProvider,
  parseLidarrRef,
  type LidarrRef,
} from '../src/adapters/fulfillment/lidarr.ts';
import {
  ProviderPermanentError,
  ProviderSkipError,
  ProviderTemporaryError,
  type RequestRecord,
} from '../src/adapters/fulfillment/types.ts';
import { LIDARR, LidarrMock, queueFixture } from './helpers/lidarr-mock.ts';
import { FakeMetadata, ID, recording } from './helpers/requests.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Harness,
} from './helpers/auth.ts';

// NOTE: the mock and its fixtures are synthesized from Lidarr's OpenAPI document and are
// unverified against a live Lidarr (test/fixtures/lidarr/README.md).

let mock: LidarrMock;
let meta: FakeMetadata;

beforeEach(async () => {
  mock = new LidarrMock();
  await mock.start();
  meta = new FakeMetadata();
});
afterEach(async () => {
  await mock.stop();
});

const config = (over: Partial<LidarrSettings> = {}): LidarrSettings => ({
  enabled: true,
  url: mock.url,
  apiKey: LIDARR.apiKey,
  rootFolder: '/music',
  qualityProfileId: 1,
  metadataProfileId: 2,
  trackPolicy: 'album',
  ...over,
});
const provider = (over: Partial<LidarrSettings> = {}, timeoutMs?: number) =>
  new LidarrProvider(config(over), { metadata: meta, timeoutMs });

const req = (over: Partial<RequestRecord>): RequestRecord => ({
  id: 'req-1',
  type: 'album',
  mbid: LIDARR.albumMbid,
  parentMbid: null,
  title: 'OK Computer',
  artistName: 'Radiohead',
  ...over,
});
const artistReq = () => req({ type: 'artist', mbid: LIDARR.artistMbid, title: 'Radiohead' });
const trackReq = (over: Partial<RequestRecord> = {}) =>
  req({ type: 'track', mbid: ID(201), title: 'Airbag', ...over });
const refOf = (ref: string): LidarrRef => parseLidarrRef(ref);
const body = (r: { body: unknown } | undefined) => (r?.body ?? {}) as Record<string, unknown>;

describe('requests to Lidarr', () => {
  it('sends the API key header on every call and never in the query string', async () => {
    await provider().submit(artistReq());
    expect(mock.log.length).toBeGreaterThan(2);
    for (const r of mock.log) {
      expect(r.headers['x-api-key']).toBe(LIDARR.apiKey);
      expect([...r.query.keys()]).not.toContain('apikey');
      expect(r.path).not.toMatch(/apikey/i);
    }
  });

  it('honours a sub-path in the base URL', async () => {
    const seen: string[] = [];
    const p = new LidarrProvider(config({ url: `${mock.url}/lidarr/` }), {
      metadata: meta,
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        seen.push(url);
        return fetch(url.replace('/lidarr', ''), init);
      },
    });
    await p.testConnection();
    expect(seen).toEqual([`${mock.url}/lidarr/api/v1/system/status`]);
  });

  describe('artist', () => {
    it('adds an artist Lidarr does not have: lookup, then POST with everything monitored and a search', async () => {
      const result = await provider().submit(artistReq());
      expect(result.status).toBe('PROCESSING');
      expect(mock.requests('GET', /^artist\/lookup$/)[0]?.query.get('term')).toBe(
        `lidarr:${LIDARR.artistMbid}`,
      );
      const post = mock.requests('POST', /^artist$/);
      expect(post).toHaveLength(1);
      expect(body(post[0])).toMatchObject({
        foreignArtistId: LIDARR.artistMbid,
        artistName: 'Radiohead',
        qualityProfileId: 1,
        metadataProfileId: 2,
        rootFolderPath: '/music',
        monitored: true,
        monitorNewItems: 'all',
        addOptions: { monitor: 'all', searchForMissingAlbums: true },
      });
      // Lidarr searches by itself on add, so no extra command.
      expect(mock.commands).toHaveLength(0);
      expect(refOf(result.ref)).toMatchObject({
        kind: 'artist',
        artistMbid: LIDARR.artistMbid,
        artistAdded: true,
      });
    });

    it('an artist already in Lidarr is monitored, all its albums are monitored and ArtistSearch runs', async () => {
      const existing = mock.seedArtist(false, true);
      const result = await provider().submit(artistReq());
      expect(mock.requests('POST', /^artist$/)).toHaveLength(0);
      expect(existing.monitored).toBe(true);
      expect(existing.monitorNewItems).toBe('all');
      expect(mock.albums.every((a) => a.monitored)).toBe(true);
      expect(mock.commands).toMatchObject([{ name: 'ArtistSearch', artistId: existing.id }]);
      const ref = refOf(result.ref);
      expect(ref).toMatchObject({ artistId: existing.id, artistAdded: false });
      expect(ref.commandId).toBe(mock.commands[0]?.id);
    });

    it('an unknown artist is a permanent error', async () => {
      const p = provider();
      await expect(p.submit({ ...artistReq(), mbid: ID(999) })).rejects.toBeInstanceOf(
        ProviderPermanentError,
      );
    });

    it('losing the add race to another request uses the artist that now exists', async () => {
      // The artist appears between our lookup and our POST, which then answers 400.
      mock.failures.push({
        match: /^POST artist$/,
        status: 400,
        body: JSON.stringify([{ errorMessage: 'This artist has already been added' }]),
        times: 1,
        onHit: () => {
          mock.seedArtist(true, true);
        },
      });
      const result = await provider().submit(artistReq());
      expect(refOf(result.ref)).toMatchObject({
        artistId: mock.artists[0]?.id,
        artistAdded: false,
      });
      expect(mock.commands[0]?.name).toBe('ArtistSearch');
    });
  });

  describe('album', () => {
    it('adds the artist unmonitored without a search, monitors the album and runs AlbumSearch', async () => {
      const result = await provider().submit(req({}));
      expect(result.status).toBe('PROCESSING');
      const post = mock.requests('POST', /^artist$/);
      expect(body(post[0])).toMatchObject({
        foreignArtistId: LIDARR.artistMbid,
        monitored: true,
        monitorNewItems: 'none',
        addOptions: { monitor: 'none', searchForMissingAlbums: false },
      });
      const monitor = mock.requests('PUT', /^album\/monitor$/);
      expect(body(monitor[0])).toEqual({ albumIds: [41], monitored: true });
      expect(mock.albums.find((a) => a.id === 41)?.monitored).toBe(true);
      expect(mock.albums.find((a) => a.id === 42)?.monitored).toBe(false);
      expect(mock.commands).toMatchObject([{ name: 'AlbumSearch', albumIds: [41] }]);
      expect(refOf(result.ref)).toMatchObject({
        kind: 'album',
        albumId: 41,
        albumMbid: LIDARR.albumMbid,
        artistMbid: LIDARR.artistMbid,
        commandId: mock.commands[0]?.id,
      });
      expect(result.note).toContain('OK Computer');
    });

    it('with the artist already in Lidarr nothing is added', async () => {
      mock.seedArtist(false, true);
      await provider().submit(req({}));
      expect(mock.requests('POST', /^artist$/)).toHaveLength(0);
      expect(mock.commands).toMatchObject([{ name: 'AlbumSearch', albumIds: [41] }]);
    });

    it('an album Lidarr already lists skips the lookups entirely', async () => {
      mock.seedArtist(true, true);
      mock.log.length = 0;
      await provider().submit(req({}));
      expect(mock.requests('GET', /lookup/)).toHaveLength(0);
    });

    it('an album that has not been imported yet is a temporary error, and the retry finishes the job', async () => {
      mock.holdRefresh = true;
      const p = provider();
      await expect(p.submit(req({}))).rejects.toBeInstanceOf(ProviderTemporaryError);
      await expect(p.submit(req({}))).rejects.toThrow(/has not imported "OK Computer" yet/);
      expect(mock.requests('POST', /^artist$/)).toHaveLength(1); // not added twice
      expect(mock.commands).toHaveLength(0);
      mock.finishRefresh();
      const result = await p.submit(req({}));
      expect(refOf(result.ref).albumId).toBe(41);
      expect(mock.requests('POST', /^artist$/)).toHaveLength(1);
      expect(mock.commands).toHaveLength(1);
    });

    it('an album Lidarr cannot find is a permanent error', async () => {
      await expect(provider().submit(req({ mbid: ID(998) }))).rejects.toBeInstanceOf(
        ProviderPermanentError,
      );
    });
  });

  describe('track', () => {
    it('requests the parent release group as an album', async () => {
      const result = await provider().submit(trackReq({ parentMbid: LIDARR.albumMbid }));
      expect(result.note).toContain('Track request');
      expect(refOf(result.ref)).toMatchObject({ kind: 'album', albumMbid: LIDARR.albumMbid });
      expect(mock.commands[0]?.name).toBe('AlbumSearch');
    });

    it('looks the release group up when the request does not carry it', async () => {
      meta.recordings.set(
        ID(201),
        recording(ID(201), 'Airbag', {
          mbid: LIDARR.albumMbid,
          title: 'OK Computer',
          primaryType: 'Album',
          coverUrl: '',
        } as never),
      );
      const result = await provider().submit(trackReq());
      expect(refOf(result.ref).albumMbid).toBe(LIDARR.albumMbid);
      expect(meta.calls).toContain(`recording:${ID(201)}`);
    });

    it('a track on no album is skipped so Manual can take it', async () => {
      meta.recordings.set(ID(201), recording(ID(201), 'Loose', null));
      await expect(provider().submit(trackReq())).rejects.toBeInstanceOf(ProviderSkipError);
      expect(mock.log).toHaveLength(0);
    });

    it("trackPolicy 'skip' skips and stops claiming tracks", async () => {
      const p = provider({ trackPolicy: 'skip' });
      expect(p.supports).toEqual({ track: false, album: true, artist: true });
      await expect(p.submit(trackReq({ parentMbid: LIDARR.albumMbid }))).rejects.toBeInstanceOf(
        ProviderSkipError,
      );
      expect(mock.log).toHaveLength(0);
      expect(provider().supports.track).toBe(true);
    });

    it('a catalog outage while resolving the album is temporary', async () => {
      meta.down = true;
      await expect(provider().submit(trackReq())).rejects.toBeInstanceOf(ProviderTemporaryError);
    });
  });

  describe('errors', () => {
    it('refuses to start with an incomplete config and says what is missing', async () => {
      await expect(
        provider({ rootFolder: '', qualityProfileId: 0 }).submit(req({})),
      ).rejects.toThrow(/incomplete: choose a root folder, a quality profile/);
      await expect(provider({ apiKey: '' }).submit(req({}))).rejects.toThrow(/URL and an API key/);
      expect(mock.log).toHaveLength(0);
    });

    it('a rejected key is permanent', async () => {
      const err = await provider({ apiKey: 'wrong' })
        .submit(req({}))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderPermanentError);
      expect((err as Error).message).toBe('Lidarr rejected the API key');
    });

    it('server errors and rate limits are temporary', async () => {
      for (const status of [500, 502, 503, 429]) {
        mock.failures.push({ match: /./, status, times: 1 });
        await expect(provider().submit(artistReq())).rejects.toBeInstanceOf(ProviderTemporaryError);
      }
    });

    it('an unreachable Lidarr is temporary and a slow one times out', async () => {
      await mock.stop();
      await expect(provider().submit(artistReq())).rejects.toBeInstanceOf(ProviderTemporaryError);
      mock = new LidarrMock();
      await mock.start();
      const slow = mock.route.bind(mock);
      mock.route = (m, p, q, b, send) => {
        setTimeout(() => {
          slow(m, p, q, b, send);
        }, 300);
      };
      await expect(provider({}, 50).submit(artistReq())).rejects.toBeInstanceOf(
        ProviderTemporaryError,
      );
    });

    it("includes Lidarr's validation message in a refused call", async () => {
      mock.failures.push({
        match: /^POST artist$/,
        status: 400,
        body: JSON.stringify([{ errorMessage: 'Path is invalid' }]),
        times: 5,
      });
      await expect(provider().submit(artistReq())).rejects.toThrow(
        /refused POST artist \(400\): Path is invalid/,
      );
    });

    it('a non-JSON success response is temporary (a proxy page)', async () => {
      const p = new LidarrProvider(config(), {
        metadata: meta,
        fetch: () => Promise.resolve(new Response('<html>login</html>', { status: 200 })),
      });
      await expect(p.submit(artistReq())).rejects.toBeInstanceOf(ProviderTemporaryError);
    });

    it('stops when the caller aborts', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(provider().submit(artistReq(), { signal: controller.signal })).rejects.toThrow();
      expect(mock.log).toHaveLength(0);
    });
  });
});

describe('poll', () => {
  const albumRef = (over: Partial<LidarrRef> = {}) =>
    JSON.stringify({
      v: 1,
      kind: 'album',
      artistId: 5,
      artistMbid: LIDARR.artistMbid,
      artistAdded: false,
      albumId: 41,
      albumMbid: LIDARR.albumMbid,
      ...over,
    });

  it('reports a running download with its progress and asks the queue for the album', async () => {
    mock.queue = queueFixture();
    const result = await provider().poll(albumRef());
    expect(result).toEqual({ state: 'pending', detail: 'Downloading 1 item (75%)' });
    const q = mock.requests('GET', /^queue\/details$/)[0];
    expect(q?.query.getAll('albumIds')).toEqual(['41']);
  });

  it('asks by artist for an artist reference', async () => {
    await provider().poll(albumRef({ kind: 'artist', albumId: undefined }));
    expect(mock.requests('GET', /^queue\/details$/)[0]?.query.get('artistId')).toBe('5');
  });

  it('a finished search with an empty queue is done (still waiting for the library)', async () => {
    mock.commands.push({ id: 7, name: 'AlbumSearch', status: 'completed' });
    expect(await provider().poll(albumRef({ commandId: 7 }))).toEqual({
      state: 'done',
      detail: 'The Lidarr search finished and nothing is downloading',
    });
  });

  it('a failed command is a permanent failure', async () => {
    mock.commands.push({ id: 8, name: 'AlbumSearch', status: 'failed', message: 'No indexers' });
    expect(await provider().poll(albumRef({ commandId: 8 }))).toEqual({
      state: 'failed',
      detail: 'The Lidarr search failed: No indexers',
    });
  });

  it('a queued or running command is pending; a forgotten command (404) is ignored', async () => {
    mock.commands.push({ id: 9, name: 'AlbumSearch', status: 'started' });
    expect(await provider().poll(albumRef({ commandId: 9 }))).toEqual({
      state: 'pending',
      detail: 'Lidarr search started',
    });
    expect(await provider().poll(albumRef({ commandId: 12345 }))).toEqual({
      state: 'pending',
      detail: 'Waiting for Lidarr',
    });
  });

  it('surfaces a stuck download without failing the request', async () => {
    mock.queue = [
      {
        title: 'Radiohead - OK Computer',
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importBlocked',
        errorMessage: 'No audio files found',
      },
    ];
    const result = await provider().poll(albumRef());
    expect(result.state).toBe('pending');
    expect(result.detail).toBe('Radiohead - OK Computer: importBlocked (No audio files found)');
  });

  it('a bad reference is permanent; Lidarr being down is temporary', async () => {
    await expect(provider().poll('not json')).rejects.toBeInstanceOf(ProviderPermanentError);
    await expect(provider().poll('{"v":2}')).rejects.toBeInstanceOf(ProviderPermanentError);
    mock.failures.push({ match: /./, status: 503, times: 1 });
    await expect(provider().poll(albumRef())).rejects.toBeInstanceOf(ProviderTemporaryError);
  });
});

describe('cancel', () => {
  it('unmonitors the album', async () => {
    mock.seedArtist(true, true);
    await provider().submit(req({}));
    expect(mock.albums.find((a) => a.id === 41)?.monitored).toBe(true);
    const ref = mock.commands.length
      ? JSON.stringify({
          v: 1,
          kind: 'album',
          artistId: 100,
          artistMbid: LIDARR.artistMbid,
          artistAdded: false,
          albumId: 41,
        })
      : '';
    await provider().cancel(ref);
    expect(mock.albums.find((a) => a.id === 41)?.monitored).toBe(false);
    expect(body(mock.requests('PUT', /^album\/monitor$/).at(-1))).toEqual({
      albumIds: [41],
      monitored: false,
    });
  });

  it('unmonitors an artist this request added, but leaves a pre-existing one alone', async () => {
    const added = await provider().submit(artistReq());
    expect(mock.artists[0]?.monitored).toBe(true);
    await provider().cancel(added.ref);
    expect(mock.artists[0]?.monitored).toBe(false);

    const before = mock.log.length;
    const ref = JSON.stringify({
      v: 1,
      kind: 'artist',
      artistId: 100,
      artistMbid: LIDARR.artistMbid,
      artistAdded: false,
    });
    const first = mock.artists[0];
    if (first) first.monitored = true;
    await provider().cancel(ref);
    expect(mock.artists[0]?.monitored).toBe(true);
    expect(mock.log.length).toBe(before);
  });
});

describe('testConnection, options and config', () => {
  it('testConnection reads system/status', async () => {
    const result = await provider().testConnection();
    expect(result).toEqual({
      ok: true,
      version: '2.9.6.4552',
      message: 'Connected to Lidarr 2.9.6.4552',
    });
    expect(mock.log.map((r) => r.path)).toEqual(['system/status']);
  });

  it('testConnection reports a wrong key, a missing URL and an unreachable server', async () => {
    expect(await provider({ apiKey: 'nope' }).testConnection()).toEqual({
      ok: false,
      message: 'Lidarr rejected the API key',
    });
    expect((await provider({ url: '' }).testConnection()).ok).toBe(false);
    await mock.stop();
    const down = await provider().testConnection();
    expect(down.ok).toBe(false);
    expect(down.message).toContain('not reachable');
  });

  it('options lists quality profiles, metadata profiles and root folders', async () => {
    expect(await provider().options()).toEqual({
      qualityProfiles: [
        { id: 1, name: 'Any' },
        { id: 2, name: 'Lossless' },
      ],
      metadataProfiles: [
        { id: 1, name: 'Standard' },
        { id: 2, name: 'None' },
      ],
      rootFolders: [{ id: 1, path: '/music', name: 'Music', freeSpace: 512000000000 }],
    });
  });

  it('describeConfig masks the API key', () => {
    expect(provider().describeConfig()).toMatchObject({ apiKey: REDACTED_SECRET, url: mock.url });
    expect(provider({ apiKey: '' }).describeConfig()).toMatchObject({ apiKey: '' });
  });
});

describe('admin routes', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  async function setup() {
    h = await createHarness({ deps: { metadata: meta.asProvider() } });
    const admin = await completeSetup(h);
    return admin;
  }
  const save = (over: Partial<LidarrSettings> = {}) =>
    h.app.hearer.settings.set('fulfillment', {
      manual: { enabled: true },
      lidarr: config(over),
    });

  it('GET /fulfillment/providers lists providers with a JSON schema and masked config', async () => {
    const admin = await setup();
    save();
    const res = await call(h.app, admin, 'GET', '/api/v1/fulfillment/providers');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      providers: {
        id: string;
        enabled: boolean;
        settingsPath: string;
        supports: Record<string, boolean>;
        configSchema: { properties: Record<string, Record<string, unknown>> };
        config: Record<string, unknown>;
      }[];
    }>();
    expect(body.providers.map((p) => p.id)).toEqual(['lidarr', 'manual']);
    const lidarr = body.providers[0];
    expect(lidarr).toMatchObject({ enabled: true, settingsPath: 'fulfillment.lidarr' });
    expect(Object.keys(lidarr?.configSchema.properties ?? {})).toEqual([
      'enabled',
      'url',
      'apiKey',
      'rootFolder',
      'qualityProfileId',
      'metadataProfileId',
      'trackPolicy',
    ]);
    expect(lidarr?.configSchema.properties.apiKey).toMatchObject({
      type: 'string',
      'x-secret': true,
    });
    expect(lidarr?.configSchema.properties.trackPolicy).toMatchObject({
      enum: ['album', 'skip'],
      default: 'album',
    });
    expect(lidarr?.config.apiKey).toBe(REDACTED_SECRET);
    expect(res.body).not.toContain(LIDARR.apiKey);
    expect(body.providers[1]).toMatchObject({
      id: 'manual',
      enabled: true,
      settingsPath: 'fulfillment.manual',
    });
  });

  it('Lidarr ships disabled by default', async () => {
    const admin = await setup();
    const res = await call(h.app, admin, 'GET', '/api/v1/fulfillment/providers');
    const lidarr = res.json<{ providers: { id: string; enabled: boolean }[] }>().providers[0];
    expect(lidarr).toMatchObject({ id: 'lidarr', enabled: false });
  });

  it('POST test: a candidate config is tested without saving; a masked key means the stored key', async () => {
    const admin = await setup();
    const url = '/api/v1/settings/fulfillment/lidarr/test';
    const candidate = await call(h.app, admin, 'POST', url, {
      url: mock.url,
      apiKey: LIDARR.apiKey,
    });
    expect(candidate.json()).toEqual({
      ok: true,
      version: '2.9.6.4552',
      message: 'Connected to Lidarr 2.9.6.4552',
    });
    expect(h.app.hearer.settings.get('fulfillment').lidarr.url).toBe('');

    const bad = await call(h.app, admin, 'POST', url, { url: mock.url, apiKey: 'wrong' });
    expect(bad.json()).toEqual({ ok: false, message: 'Lidarr rejected the API key' });

    // Masked: nothing stored yet, so the (empty) stored key is used and the test fails cleanly.
    const masked = await call(h.app, admin, 'POST', url, {
      url: mock.url,
      apiKey: REDACTED_SECRET,
    });
    expect(masked.json<{ ok: boolean }>().ok).toBe(false);
    save();
    const stored = await call(h.app, admin, 'POST', url, {
      url: mock.url,
      apiKey: REDACTED_SECRET,
    });
    expect(stored.json<{ ok: boolean }>().ok).toBe(true);
    expect(mock.log.at(-1)?.headers['x-api-key']).toBe(LIDARR.apiKey);

    const invalid = await call(h.app, admin, 'POST', url, { url: 'not a url' });
    expect(invalid.statusCode).toBe(400);
  });

  it("GET options returns the stored Lidarr's profiles and root folders", async () => {
    const admin = await setup();
    const missing = await call(h.app, admin, 'GET', '/api/v1/settings/fulfillment/lidarr/options');
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('provider_rejected');
    save();
    const res = await call(h.app, admin, 'GET', '/api/v1/settings/fulfillment/lidarr/options');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ rootFolders: { path: string }[] }>().rootFolders[0]?.path).toBe('/music');
    save({ apiKey: 'wrong' });
    expect(
      (await call(h.app, admin, 'GET', '/api/v1/settings/fulfillment/lidarr/options')).statusCode,
    ).toBe(400);
    await mock.stop();
    save();
    const down = await call(h.app, admin, 'GET', '/api/v1/settings/fulfillment/lidarr/options');
    expect(down.statusCode).toBe(502);
    expect(down.json<{ error: { code: string } }>().error.code).toBe('provider_unavailable');
    mock = new LidarrMock();
    await mock.start();
  });

  it('is limited to MANAGE_SETTINGS', async () => {
    await setup();
    await addUser(h.app, 'plain', Permission.REQUEST);
    await addUser(h.app, 'settings', Permission.MANAGE_SETTINGS);
    const plain = await login(h.app, 'plain');
    const settings = await login(h.app, 'settings');
    for (const [method, url] of [
      ['GET', '/api/v1/fulfillment/providers'],
      ['POST', '/api/v1/settings/fulfillment/lidarr/test'],
      ['GET', '/api/v1/settings/fulfillment/lidarr/options'],
    ] as const) {
      expect((await call(h.app, plain, method, url, {})).statusCode, url).toBe(403);
      expect((await call(h.app, undefined, method, url, {})).statusCode, url).toBe(401);
    }
    expect((await call(h.app, settings, 'GET', '/api/v1/fulfillment/providers')).statusCode).toBe(
      200,
    );
  });

  it('the stored API key is encrypted at rest and masked in the settings API', async () => {
    const admin = await setup();
    save();
    const res = await call(h.app, admin, 'GET', '/api/v1/settings/fulfillment');
    expect(res.body).not.toContain(LIDARR.apiKey);
    expect(res.json<{ lidarr: { apiKey: string } }>().lidarr.apiKey).toBe(REDACTED_SECRET);
    const row = h.app.hearer.database.sqlite
      .prepare("select value_json from settings where key = 'fulfillment'")
      .get() as { value_json: string };
    expect(row.value_json).not.toContain(LIDARR.apiKey);
  });
});
