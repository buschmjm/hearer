import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JellyfinAdapter,
  buildAuthorizationHeader,
  isSupportedVersion,
  mapItem,
  normalizeBaseUrl,
} from '../src/adapters/mediaserver/jellyfin.ts';
import {
  MediaServerAuthError,
  MediaServerError,
  MediaServerUnavailableError,
  type LibraryItem,
} from '../src/adapters/mediaserver/types.ts';
import {
  MOCK_API_KEY,
  deadUrl,
  startJellyfinMock,
  type JellyfinMock,
} from './helpers/jellyfin-mock.ts';

let mock: JellyfinMock;
beforeAll(async () => {
  mock = await startJellyfinMock();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.requests.length = 0;
  mock.behavior.mediaUpdated = 204;
  mock.behavior.version = '10.11.0';
  mock.behavior.delayMs = 0;
  mock.behavior.forceStatus = undefined;
});

const make = (overrides: Partial<ConstructorParameters<typeof JellyfinAdapter>[0]> = {}) =>
  new JellyfinAdapter({
    url: mock.url,
    apiKey: MOCK_API_KEY,
    deviceId: 'hearer-test-device',
    version: '1.2.3',
    pageSize: 3,
    ...overrides,
  });

async function collect(iter: AsyncIterable<LibraryItem>): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('authorization header', () => {
  it('uses the exact MediaBrowser format, with Token only when given', () => {
    const parts = { deviceId: 'dev-1', version: '0.9.0' };
    expect(buildAuthorizationHeader(parts)).toBe(
      'MediaBrowser Client="Hearer", Device="Hearer Server", DeviceId="dev-1", Version="0.9.0"',
    );
    expect(buildAuthorizationHeader(parts, 'tok')).toBe(
      'MediaBrowser Client="Hearer", Device="Hearer Server", DeviceId="dev-1", Version="0.9.0", Token="tok"',
    );
  });

  it('escapes quotes, backslashes, commas and control characters in values', () => {
    const header = buildAuthorizationHeader({ deviceId: 'a"b\\c,d\ne', version: '1' }, 't"x');
    expect(header).toContain('DeviceId="a%22b%5Cc%2Cd%0Ae"');
    expect(header).toContain('Token="t%22x"');
    expect(header.split('"').length).toBe(2 * 5 + 1); // five well-formed key="value" pairs
  });

  it('never sends legacy X-Emby headers or api_key query params on any call', async () => {
    const adapter = make();
    await adapter.testConnection();
    await adapter.authenticate('alice', 'alice-pass');
    await adapter.listUsers();
    await collect(adapter.iterateLibrary({ since: new Date('2026-01-01T00:00:00Z') }));
    await adapter.notifyPathsChanged(['/music/a.flac']);
    mock.behavior.mediaUpdated = 404;
    await adapter.notifyPathsChanged(['/music/b.flac']);
    await adapter.refreshLibrary();
    expect(mock.requests.length).toBeGreaterThan(8);
    for (const req of mock.requests) {
      const names = Object.keys(req.headers).map((n) => n.toLowerCase());
      expect(names.filter((n) => n.startsWith('x-emby') || n.startsWith('x-mediabrowser'))).toEqual(
        [],
      );
      expect([...req.query.keys()].map((k) => k.toLowerCase())).not.toContain('api_key');
      expect([...req.query.keys()].map((k) => k.toLowerCase())).not.toContain('apikey');
      expect(req.headers.authorization).toMatch(
        /^MediaBrowser Client="Hearer", Device="Hearer Server", DeviceId="hearer-test-device", Version="1.2.3"/,
      );
    }
  });

  it('omits the Token when authenticating a user, and includes it for API-key calls', async () => {
    const adapter = make();
    await adapter.authenticate('alice', 'alice-pass');
    await adapter.testConnection();
    const login = mock.requests.find((r) => r.path === '/Users/AuthenticateByName');
    const info = mock.requests.find((r) => r.path === '/System/Info');
    expect(login?.headers.authorization).not.toContain('Token=');
    expect(info?.headers.authorization).toContain(`Token="${MOCK_API_KEY}"`);
  });
});

describe('base URL normalization', () => {
  it('drops trailing slashes, query and fragment but keeps a sub-path', () => {
    expect(normalizeBaseUrl('http://host:8096/')).toBe('http://host:8096');
    expect(normalizeBaseUrl(' https://host/jellyfin/// ')).toBe('https://host/jellyfin');
    expect(normalizeBaseUrl('https://host/jf/?x=1#y')).toBe('https://host/jf');
  });

  it('rejects non-http URLs', () => {
    expect(() => normalizeBaseUrl('ftp://host')).toThrow(MediaServerError);
    expect(() => normalizeBaseUrl('nonsense')).toThrow(MediaServerError);
  });

  it('works behind a sub-path and with a trailing slash', async () => {
    // The mock only serves root paths, so a sub-path request must reach it as /sub/System/Info.
    const adapter = make({ url: `${mock.url}/sub/` });
    await expect(adapter.testConnection()).rejects.toBeInstanceOf(MediaServerError);
    expect(mock.requests.at(-1)?.path).toBe('/sub/System/Info');
  });
});

describe('testConnection', () => {
  it('returns name, version and id', async () => {
    const info = await make().testConnection();
    expect(info).toEqual({
      id: '8f1c5e0a7d2b4c6e9a3b1d4f5e6a7b8c',
      name: 'Test Jellyfin',
      version: '10.11.0',
      versionSupported: true,
    });
    expect(mock.requests[0]?.method).toBe('GET');
    expect(mock.requests[0]?.path).toBe('/System/Info');
  });

  it('flags servers older than 10.10', async () => {
    mock.behavior.version = '10.9.11';
    const info = await make().testConnection();
    expect(info.versionSupported).toBe(false);
    expect(info.warning).toContain('10.9.11');
  });

  it('rejects a wrong API key with MediaServerAuthError', async () => {
    await expect(make({ apiKey: 'nope' }).testConnection()).rejects.toThrow(/rejected the API key/);
    await expect(make({ apiKey: 'nope' }).testConnection()).rejects.toBeInstanceOf(
      MediaServerAuthError,
    );
  });

  it('reports an unreachable server as MediaServerUnavailableError', async () => {
    const adapter = make({ url: await deadUrl() });
    await expect(adapter.testConnection()).rejects.toBeInstanceOf(MediaServerUnavailableError);
  });

  it('reports 5xx as unavailable and 404 as a plain MediaServerError', async () => {
    mock.behavior.forceStatus = 503;
    await expect(make().testConnection()).rejects.toBeInstanceOf(MediaServerUnavailableError);
    mock.behavior.forceStatus = 404;
    const err = await make()
      .testConnection()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaServerError);
    expect(err).not.toBeInstanceOf(MediaServerUnavailableError);
    expect((err as MediaServerError).status).toBe(404);
  });

  it('times out slow servers', async () => {
    mock.behavior.delayMs = 400;
    const adapter = make({ timeoutMs: 100 });
    await expect(adapter.testConnection()).rejects.toThrow(/did not answer/);
  });
});

describe('authenticate', () => {
  it('maps the user, including the administrator policy', async () => {
    const adapter = make();
    expect(await adapter.authenticate('alice', 'alice-pass')).toEqual({
      id: '2b1ccd0f9d7a4a5a8f0f3c1d9e8b7a60',
      name: 'alice',
      isAdmin: false,
      isDisabled: false,
    });
    expect((await adapter.authenticate('jfadmin', 'admin-pass')).isAdmin).toBe(true);
  });

  it('posts {Username, Pw} and then ends the session it created', async () => {
    await make().authenticate('alice', 'alice-pass');
    const login = mock.requests.find((r) => r.path === '/Users/AuthenticateByName');
    expect(login?.method).toBe('POST');
    expect(login?.body).toEqual({ Username: 'alice', Pw: 'alice-pass' });
    const logout = mock.requests.find((r) => r.path === '/Sessions/Logout');
    expect(logout?.headers.authorization).toContain('Token="f00dfacecafebeef0123456789abcdef"');
  });

  it('turns a 401 into MediaServerAuthError', async () => {
    const err = await make()
      .authenticate('alice', 'wrong')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaServerAuthError);
    expect((err as MediaServerAuthError).status).toBe(401);
  });

  it('reports an unreachable server as unavailable', async () => {
    const adapter = make({ url: await deadUrl() });
    await expect(adapter.authenticate('alice', 'x')).rejects.toBeInstanceOf(
      MediaServerUnavailableError,
    );
  });
});

describe('listUsers', () => {
  it('returns every user with admin and disabled flags', async () => {
    const users = await make().listUsers();
    expect(users.map((u) => [u.name, u.isAdmin, u.isDisabled])).toEqual([
      ['alice', false, false],
      ['bob', false, false],
      ['jfadmin', true, false],
      ['mallory', false, true],
    ]);
    expect(mock.requests[0]?.path).toBe('/Users');
  });
});

describe('iterateLibrary', () => {
  it('pages through /Items and maps every kind', async () => {
    const items = await collect(make().iterateLibrary({}));
    expect(items.map((i) => [i.kind, i.name])).toEqual([
      ['artist', 'Radiohead'],
      ['album', 'OK Computer'],
      ['track', 'Paranoid Android'],
      ['track', 'Karma Police'],
      ['track', 'Untagged Demo'],
      ['album', 'Nameless Sampler'],
    ]);
    const pages = mock.requests.filter((r) => r.path === '/Items');
    expect(pages.map((p) => p.query.get('StartIndex'))).toEqual(['0', '3']);
    const first = pages[0]?.query;
    expect(first?.get('IncludeItemTypes')).toBe('Audio,MusicAlbum,MusicArtist');
    expect(first?.get('Recursive')).toBe('true');
    expect(first?.get('Fields')).toBe('ProviderIds,Path,DateCreated');
    expect(first?.get('Limit')).toBe('3');
    expect(first?.has('MinDateLastSaved')).toBe(false);
    expect(first?.has('ParentId')).toBe(false);
  });

  it('uses a page size of 500 by default', async () => {
    const adapter = make({ pageSize: undefined });
    await collect(adapter.iterateLibrary({}));
    expect(mock.requests.find((r) => r.path === '/Items')?.query.get('Limit')).toBe('500');
    // The first fixture page holds 3 of 6 items, which is "short" for a 500 page: stop there.
    expect(mock.requests.filter((r) => r.path === '/Items')).toHaveLength(1);
  });

  it('sends MinDateLastSaved when `since` is given', async () => {
    const since = new Date('2026-03-04T05:06:07.000Z');
    await collect(make().iterateLibrary({ since }));
    for (const page of mock.requests.filter((r) => r.path === '/Items')) {
      expect(page.query.get('MinDateLastSaved')).toBe('2026-03-04T05:06:07.000Z');
    }
  });

  it('iterates each configured library with ParentId', async () => {
    const adapter = make({ libraryIds: ['lib-a', 'lib-b'] });
    const items = await collect(adapter.iterateLibrary({}));
    expect(items).toHaveLength(12);
    const parents = mock.requests
      .filter((r) => r.path === '/Items')
      .map((r) => [r.query.get('ParentId'), r.query.get('StartIndex')]);
    expect(parents).toEqual([
      ['lib-a', '0'],
      ['lib-a', '3'],
      ['lib-b', '0'],
      ['lib-b', '3'],
    ]);
  });

  it('maps ProviderIds, ticks, names and paths', async () => {
    const items = await collect(make().iterateLibrary({}));
    const byName = (n: string) => items.find((i) => i.name === n);
    expect(byName('Radiohead')).toMatchObject({
      kind: 'artist',
      artistName: null,
      mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      mbRecordingId: null,
      mbReleaseGroupId: null,
    });
    expect(byName('OK Computer')).toMatchObject({
      kind: 'album',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      mbAlbumId: '5a1a1c9f-1f6b-4e83-a7a4-3a3f06b1b1f1',
      mbReleaseGroupId: 'b1392450-e666-3926-a536-22c65f834433',
      mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      path: '/music/Radiohead/OK Computer (1997)',
    });
    // MusicBrainzTrack variant, 2833520000 ticks = 283352 ms
    expect(byName('Paranoid Android')).toMatchObject({
      kind: 'track',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      durationMs: 283352,
      mbRecordingId: '0d1f1b8e-3c0a-4a3f-93a8-6d0b0f6d6c21',
      mbReleaseGroupId: 'b1392450-e666-3926-a536-22c65f834433',
      serverItemId: 'a3000000000000000000000000000003',
    });
    // MusicBrainzRecording variant
    expect(byName('Karma Police')).toMatchObject({
      mbRecordingId: '5b0c4a4e-2c0d-4c8b-8a3c-0a5b2f6f7e32',
      durationMs: 261900,
    });
    // No ProviderIds at all
    expect(byName('Untagged Demo')).toMatchObject({
      artistName: 'Some Band',
      albumName: null,
      mbRecordingId: null,
      mbReleaseGroupId: null,
      mbArtistId: null,
      mbAlbumId: null,
      durationMs: 180000,
    });
    expect(byName('Nameless Sampler')).toMatchObject({
      mbAlbumId: null,
      artistName: 'Various Artists',
    });
    expect(byName('Radiohead')?.dateCreated?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('stops when the server reports an auth failure', async () => {
    await expect(collect(make({ apiKey: 'bad' }).iterateLibrary({}))).rejects.toBeInstanceOf(
      MediaServerAuthError,
    );
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(make().iterateLibrary({ signal: controller.signal }))).rejects.toThrow();
  });
});

describe('mapItem', () => {
  const base = { Id: 'x', Type: 'Audio', Name: 'T' };
  it('prefers MusicBrainzRecording over MusicBrainzTrack and ignores keys case', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(
      mapItem({ ...base, ProviderIds: { MusicBrainzTrack: b, MusicBrainzRecording: a } })
        ?.mbRecordingId,
    ).toBe(a);
    expect(
      mapItem({ ...base, ProviderIds: { musicbrainztrack: b.toUpperCase() } })?.mbRecordingId,
    ).toBe(b);
  });

  it('drops values that are not UUIDs and falls back to the album artist id', () => {
    const artist = '33333333-3333-4333-8333-333333333333';
    const item = mapItem({
      ...base,
      ProviderIds: {
        MusicBrainzTrack: 'not-a-uuid',
        MusicBrainzArtist: null,
        MusicBrainzAlbumArtist: artist,
      },
    });
    expect(item?.mbRecordingId).toBeNull();
    expect(item?.mbArtistId).toBe(artist);
  });

  it('skips item types Hearer does not index', () => {
    expect(mapItem({ ...base, Type: 'Playlist' })).toBeUndefined();
  });

  it('keeps null duration when RunTimeTicks is missing', () => {
    expect(mapItem(base)?.durationMs).toBeNull();
  });
});

describe('notifyPathsChanged / refreshLibrary', () => {
  it('posts Updates with UpdateType Created', async () => {
    await make().notifyPathsChanged(['/music/A/1.flac', '/music/A/2.flac']);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({
      method: 'POST',
      path: '/Library/Media/Updated',
      body: {
        Updates: [
          { Path: '/music/A/1.flac', UpdateType: 'Created' },
          { Path: '/music/A/2.flac', UpdateType: 'Created' },
        ],
      },
    });
  });

  it('does nothing for an empty list', async () => {
    await make().notifyPathsChanged([]);
    expect(mock.requests).toHaveLength(0);
  });

  it.each([404, 405, 500])('falls back to /Library/Refresh on HTTP %i', async (status) => {
    mock.behavior.mediaUpdated = status;
    await make().notifyPathsChanged(['/music/x.flac']);
    expect(mock.requests.map((r) => r.path)).toEqual([
      '/Library/Media/Updated',
      '/Library/Refresh',
    ]);
  });

  it('does not retry with a full refresh when the API key is rejected', async () => {
    await expect(make({ apiKey: 'bad' }).notifyPathsChanged(['/m/x.flac'])).rejects.toBeInstanceOf(
      MediaServerAuthError,
    );
    expect(mock.requests).toHaveLength(1);
  });

  it('refreshLibrary posts /Library/Refresh', async () => {
    await make().refreshLibrary();
    expect(mock.requests[0]).toMatchObject({ method: 'POST', path: '/Library/Refresh' });
  });
});

describe('itemUrl and versions', () => {
  it('builds the web details link, using the external URL when set', () => {
    expect(make({ url: 'http://internal:8096/' }).itemUrl('abc')).toBe(
      'http://internal:8096/web/#/details?id=abc',
    );
    expect(
      make({
        url: 'http://internal:8096',
        externalUrl: 'https://jf.example.com/jellyfin/',
      }).itemUrl('a b'),
    ).toBe('https://jf.example.com/jellyfin/web/#/details?id=a%20b');
  });

  it('compares versions', () => {
    expect(isSupportedVersion('10.10.0')).toBe(true);
    expect(isSupportedVersion('10.11.4')).toBe(true);
    expect(isSupportedVersion('11.0.0')).toBe(true);
    expect(isSupportedVersion('10.9.11')).toBe(false);
    expect(isSupportedVersion('')).toBe(false);
  });
});
