import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  escapeLucene,
  MusicBrainzProvider,
  pickRepresentativeRelease,
  type ReleaseCandidate,
} from '../src/adapters/metadata/musicbrainz.ts';
import { MetadataError } from '../src/adapters/metadata/types.ts';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { mbCache } from '../src/db/schema.ts';
import { RateLimiter } from '../src/lib/ratelimit.ts';
import { SecretBox } from '../src/lib/secrets.ts';
import { SettingsService } from '../src/services/settings.ts';
import { FixtureServer, IDS, nth } from './helpers/mbServer.ts';

const DAY = 86_400_000;
const UA = 'Hearer/1.2.3 ( https://github.com/buschmjm/hearer )';
const PAGE = { offset: 0, limit: 20 };

let server: FixtureServer;
let database: Database_;
let settings: SettingsService;
let clock: number;
const warn = vi.fn();

function makeProvider(extra: Partial<ConstructorParameters<typeof MusicBrainzProvider>[0]> = {}) {
  return new MusicBrainzProvider({
    db: database.db,
    settings,
    logger: { warn },
    version: '1.2.3',
    limiter: new RateLimiter({ intervalMs: 0 }),
    now: () => clock,
    ...extra,
  });
}

beforeAll(async () => {
  server = await FixtureServer.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => {
  database = openDatabase(':memory:');
  runMigrations(database.db);
  settings = new SettingsService(
    database.db,
    new SecretBox('test-secret'),
    pino({ level: 'silent' }),
  );
  settings.set('metadata', { musicBrainzBaseUrl: server.baseUrl });
  server.requests.length = 0;
  server.override = undefined;
  clock = 1_800_000_000_000;
  warn.mockClear();
});
afterEach(() => {
  database.close();
});

describe('requests', () => {
  it('send the Hearer User-Agent and ask for JSON on every call', async () => {
    const mb = makeProvider();
    await mb.searchArtists('Radiohead', PAGE);
    await mb.getArtist(IDS.artist);
    await mb.getRecording(IDS.recording);
    expect(server.requests).toHaveLength(3);
    for (const request of server.requests) {
      expect(request.headers['user-agent']).toBe(UA);
      expect(request.query.get('fmt')).toBe('json');
    }
  });

  it('use the repository URL from shared and the default version otherwise', async () => {
    const mb = makeProvider({ version: undefined });
    await mb.getArtist(IDS.artist);
    expect(server.requests[0]?.headers['user-agent']).toBe(
      'Hearer/0.0.0 ( https://github.com/buschmjm/hearer )',
    );
  });

  it('follow the base URL setting (mirrors)', async () => {
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    settings.set('metadata', { musicBrainzBaseUrl: `${server.baseUrl}/` });
    await mb.getArtist(IDS.artist);
    // A different base URL is a different cache key; a trailing slash is normalised away.
    expect(server.requests).toHaveLength(1);
    settings.set('metadata', { musicBrainzBaseUrl: 'http://127.0.0.1:1/ws/2' });
    await expect(mb.getArtist(IDS.artist)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('share one limiter between providers, so concurrent callers stay under the rate', async () => {
    // Count the turns taken from the one shared limiter. Spacing itself is covered
    // deterministically (fake clock) in metadata.ratelimit.test.ts; asserting wall-clock gaps
    // here was flaky under load.
    let turns = 0;
    class CountingLimiter extends RateLimiter {
      override async acquire(signal?: AbortSignal): Promise<void> {
        await super.acquire(signal);
        turns++;
      }
    }
    const limiter = new CountingLimiter({ intervalMs: 20 });
    const route = makeProvider({ limiter });
    const job = makeProvider({ limiter });
    await Promise.all([
      route.getArtist(IDS.artist),
      job.getRecording(IDS.recording),
      route.searchArtists('a', PAGE),
      job.searchArtists('b', PAGE),
      route.getRelease(IDS.release),
    ]);
    expect(server.requests).toHaveLength(5);
    expect(turns).toBe(5);
  });
});

describe('query building', () => {
  it('escapes Lucene syntax in user input', () => {
    expect(escapeLucene('AC/DC')).toBe('AC\\/DC');
    expect(escapeLucene('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLucene('title: (live) [x] {y}')).toBe('title\\: \\(live\\) \\[x\\] \\{y\\}');
    expect(escapeLucene('a && b || !c')).toBe('a \\&\\& b \\|\\| \\!c');
    expect(escapeLucene('+must -not ^2 ~3 *wild? back\\slash')).toBe(
      '\\+must \\-not \\^2 \\~3 \\*wild\\? back\\\\slash',
    );
  });

  it('quotes bare boolean operators and collapses whitespace', () => {
    expect(escapeLucene('  Rock   AND   Roll  ')).toBe('Rock "AND" Roll');
    expect(escapeLucene('NOT OR')).toBe('"NOT" "OR"');
    expect(escapeLucene('and or')).toBe('and or');
    expect(escapeLucene('   ')).toBe('');
  });

  it('sends field-scoped queries across title and artist, per search type', async () => {
    const mb = makeProvider();
    await mb.searchReleaseGroups('AC/DC: Back "in" Black (1980)', PAGE);
    await mb.searchArtists('AC/DC', PAGE);
    await mb.searchRecordings('Hells Bells', PAGE);
    const [rg, artist, recording] = server.requests;
    expect(rg?.query.get('query')).toBe(
      'releasegroup:(AC\\/DC\\: Back \\"in\\" Black \\(1980\\)) OR artist:(AC\\/DC\\: Back \\"in\\" Black \\(1980\\))',
    );
    expect(artist?.query.get('query')).toBe('artist:(AC\\/DC) OR alias:(AC\\/DC)');
    expect(recording?.query.get('query')).toBe('recording:(Hells Bells) OR artist:(Hells Bells)');
  });

  it('passes offset and limit, and puts the artist browse filters in the URL', async () => {
    const mb = makeProvider();
    await mb.searchReleaseGroups('x', { offset: 40, limit: 10 });
    await mb.getArtistReleaseGroups(IDS.artist, { offset: 5, limit: 7, type: 'ep' });
    expect(server.requests[0]?.query.get('offset')).toBe('40');
    expect(server.requests[0]?.query.get('limit')).toBe('10');
    const browse = nth(server.requests, 1);
    expect(browse.path).toBe('release-group');
    expect(browse.query.get('artist')).toBe(IDS.artist);
    expect(browse.query.get('type')).toBe('ep');
    expect(browse.query.get('offset')).toBe('5');
  });

  it('ranks "Radiohead OK Computer" with OK Computer first (fixture of the real response)', async () => {
    const page = await makeProvider().searchReleaseGroups('Radiohead OK Computer', PAGE);
    expect(page.items[0]).toMatchObject({ mbid: IDS.releaseGroup, title: 'OK Computer' });
    expect(server.requests[0]?.query.get('query')).toBe(
      'releasegroup:(Radiohead OK Computer) OR artist:(Radiohead OK Computer)',
    );
  });
});

describe('DTO mapping', () => {
  it('maps release group search results', async () => {
    const page = await makeProvider().searchReleaseGroups('x', PAGE);
    expect(page).toMatchObject({ total: 3895, offset: 0, limit: 20 });
    expect(page.items[0]).toEqual({
      mbid: IDS.releaseGroup,
      title: 'OK Computer',
      disambiguation: '',
      primaryType: 'Album',
      secondaryTypes: [],
      firstReleaseDate: '1997-05-21',
      artistCredit: [{ mbid: IDS.artist, name: 'Radiohead', joinPhrase: '' }],
      artistName: 'Radiohead',
      coverUrl: `https://coverartarchive.org/release-group/${IDS.releaseGroup}/front-250`,
      score: 100,
    });
  });

  it('builds cover URLs from the configured Cover Art Archive base', async () => {
    settings.set('metadata', {
      musicBrainzBaseUrl: server.baseUrl,
      coverArtBaseUrl: 'https://covers.example.org/',
    });
    const page = await makeProvider().searchReleaseGroups('x', PAGE);
    expect(page.items[0]?.coverUrl).toBe(
      `https://covers.example.org/release-group/${IDS.releaseGroup}/front-250`,
    );
  });

  it('maps artists and artist details', async () => {
    const mb = makeProvider();
    const page = await mb.searchArtists('Radiohead', PAGE);
    expect(page.items[0]).toMatchObject({ mbid: IDS.artist, name: 'Radiohead', type: 'Group' });
    expect(page.items[0]?.score).toBeTypeOf('number');
    const artist = await mb.getArtist(IDS.artist);
    expect(artist).toMatchObject({
      mbid: IDS.artist,
      name: 'Radiohead',
      sortName: 'Radiohead',
      disambiguation: '',
      lifeSpan: null,
      score: null,
    });
  });

  it('maps an artist browse into a page of release groups', async () => {
    const page = await makeProvider().getArtistReleaseGroups(IDS.artist, {
      ...PAGE,
      type: 'album',
    });
    expect(page.total).toBe(388);
    expect(page.items[0]).toMatchObject({ mbid: IDS.releaseGroup, primaryType: 'Album' });
    expect(page.items[0]?.artistCredit).toEqual([]);
  });

  it('maps a release group with releases and the tracklist of its representative release', async () => {
    const mb = makeProvider();
    const album = await mb.getReleaseGroup(IDS.releaseGroup);
    expect(album).toMatchObject({
      mbid: IDS.releaseGroup,
      title: 'OK Computer',
      artistName: 'Radiohead',
    });
    expect(album.releases).toHaveLength(8);
    expect(album.representativeRelease).toMatchObject({
      mbid: IDS.release,
      status: 'Official',
      date: '1997-05-21',
      format: 'CD',
      trackCount: 12,
    });
    expect(album.tracks).toHaveLength(12);
    expect(album.tracks[0]).toEqual({
      mbid: IDS.airbag,
      title: 'Airbag',
      discNumber: 1,
      position: 1,
      number: null,
      lengthMs: 284_400,
      artistCredit: [{ mbid: IDS.artist, name: 'Radiohead', joinPhrase: '' }],
      artistName: 'Radiohead',
      isrcs: ['GBAYE9701274', 'GBBKS1700107'],
    });
    expect(album.tracks[1]).toMatchObject({ mbid: IDS.recording, title: 'Paranoid Android' });
    // Lookup, release browse, then the representative release (3 calls, all cached after).
    expect(server.requests.map((r) => r.path)).toEqual([
      `release-group/${IDS.releaseGroup}`,
      'release',
      `release/${IDS.release}`,
    ]);
    expect(server.requests[1]?.query.get('release-group')).toBe(IDS.releaseGroup);
    expect(server.requests[1]?.query.get('limit')).toBe('100');
    await mb.getReleaseGroup(IDS.releaseGroup);
    expect(server.requests).toHaveLength(3);
  });

  it('maps a recording with its length, ISRCs and the release groups it appears on', async () => {
    const recording = await makeProvider().getRecording(IDS.recording);
    expect(recording).toMatchObject({
      mbid: IDS.recording,
      title: 'Paranoid Android',
      lengthMs: 384_000,
      isrcs: ['GBAYE9701376', 'GBBKS1700108'],
      artistName: 'Radiohead',
    });
    // The studio album outranks the singles it was also released on.
    expect(recording.releaseGroups.map((rg) => rg.title)).toEqual([
      'OK Computer',
      'Paranoid Android',
    ]);
    expect(recording.releaseGroup).toMatchObject({ mbid: IDS.releaseGroup, primaryType: 'Album' });
    expect(recording.coverUrl).toContain(`/release-group/${IDS.releaseGroup}/front-250`);
  });

  it('maps recording search results, preferring a release group that is a studio album', async () => {
    const page = await makeProvider().searchRecordings('Paranoid Android', PAGE);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toMatchObject({ title: 'Paranoid Android', lengthMs: 388_000 });
    expect(page.items[0]?.releaseGroup?.mbid).toBeTypeOf('string');
  });

  it('turns an unknown id into not_found and a malformed answer into bad_response', async () => {
    const mb = makeProvider();
    server.override = () => ({ status: 404, body: '{"error":"Not Found"}' });
    await expect(mb.getArtist(IDS.artist)).rejects.toMatchObject({ kind: 'not_found' });
    server.override = () => ({ body: '{"unexpected":true}' });
    await expect(mb.getRecording(IDS.recording)).rejects.toMatchObject({ kind: 'bad_response' });
    server.override = () => ({ body: 'not json' });
    await expect(mb.getRelease(IDS.release)).rejects.toBeInstanceOf(MetadataError);
    // Failed answers are never cached.
    expect(database.db.select().from(mbCache).all()).toHaveLength(0);
  });
});

describe('cache', () => {
  it('serves repeat requests from mb_cache and stores one row per normalised URL', async () => {
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    await mb.getArtist(IDS.artist);
    // A fresh provider (e.g. after a restart) shares the same table.
    await makeProvider().getArtist(IDS.artist);
    expect(server.requests).toHaveLength(1);
    const rows = database.db.select().from(mbCache).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.urlKey).toBe(`${server.baseUrl}/artist/${IDS.artist}?fmt=json`);
    expect(rows[0]?.ttlSeconds).toBe(7 * 86_400);
  });

  it('keys searches by their sorted parameters, so parameter order is irrelevant', async () => {
    const mb = makeProvider();
    await mb.searchArtists('Radiohead', { offset: 0, limit: 5 });
    await mb.searchArtists('Radiohead', { offset: 0, limit: 5 });
    await mb.searchArtists('Radiohead', { offset: 5, limit: 5 });
    expect(server.requests).toHaveLength(2);
    const key = new URL(nth(database.db.select().from(mbCache).all(), 0).urlKey);
    expect([...key.searchParams.keys()]).toEqual(['fmt', 'limit', 'offset', 'query']);
  });

  it('expires searches after a day and entities after a week (configurable)', async () => {
    const mb = makeProvider();
    await mb.searchArtists('Radiohead', PAGE);
    await mb.getArtist(IDS.artist);
    expect(
      database.db
        .select()
        .from(mbCache)
        .all()
        .map((r) => r.ttlSeconds)
        .sort((a, b) => a - b),
    ).toEqual([86_400, 7 * 86_400]);

    clock += DAY - 1000;
    await mb.searchArtists('Radiohead', PAGE);
    expect(server.requests).toHaveLength(2);
    clock += 2000;
    await mb.searchArtists('Radiohead', PAGE);
    expect(server.requests).toHaveLength(3); // search expired
    await mb.getArtist(IDS.artist);
    expect(server.requests).toHaveLength(3); // entity still fresh at +1 day
    clock += 7 * DAY;
    await mb.getArtist(IDS.artist);
    expect(server.requests).toHaveLength(4);
  });

  it('uses the configured TTLs when writing rows', async () => {
    settings.set('metadata', {
      musicBrainzBaseUrl: server.baseUrl,
      cacheTtl: { entityDays: 3, searchDays: 2 },
    });
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    await mb.searchArtists('x', PAGE);
    const ttls = database.db
      .select()
      .from(mbCache)
      .all()
      .map((r) => r.ttlSeconds);
    expect(ttls.sort((a, b) => a - b)).toEqual([2 * 86_400, 3 * 86_400]);
  });

  it('serves a stale row and logs when MusicBrainz fails', async () => {
    const mb = makeProvider();
    const fresh = await mb.getArtist(IDS.artist);
    clock += 30 * DAY;
    server.override = () => ({ status: 500, body: 'boom' });
    const stale = await mb.getArtist(IDS.artist);
    expect(stale).toEqual(fresh);
    expect(server.requests).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).toContain('stale');
    // The stale row is kept (not refreshed), so the next call retries upstream.
    await mb.getArtist(IDS.artist);
    expect(server.requests).toHaveLength(3);
  });

  it('serves a stale row when MusicBrainz is unreachable', async () => {
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    clock += 30 * DAY;
    settings.set('metadata', { musicBrainzBaseUrl: server.baseUrl });
    const key = `${server.baseUrl}/artist/${IDS.artist}?fmt=json`;
    expect(database.db.select().from(mbCache).where(eq(mbCache.urlKey, key)).get()).toBeDefined();
    const dead = makeProvider({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(dead.getArtist(IDS.artist)).resolves.toMatchObject({ name: 'Radiohead' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails with unavailable when there is nothing cached', async () => {
    server.override = () => ({ status: 500 });
    await expect(makeProvider().getArtist(IDS.artist)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('does not hide a 404 behind a stale row', async () => {
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    clock += 30 * DAY;
    server.override = () => ({ status: 404 });
    await expect(mb.getArtist(IDS.artist)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refetches when a fresh row no longer parses', async () => {
    const mb = makeProvider();
    await mb.getArtist(IDS.artist);
    database.db.update(mbCache).set({ bodyJson: '{"garbage":1}' }).run();
    await expect(mb.getArtist(IDS.artist)).resolves.toMatchObject({ name: 'Radiohead' });
    expect(server.requests).toHaveLength(2);
  });
});

describe('single flight', () => {
  it('coalesces concurrent identical requests into one upstream call', async () => {
    server.override = () => ({ delayMs: 60 });
    const mb = makeProvider();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => mb.getRecording(IDS.recording)),
    );
    expect(server.requests).toHaveLength(1);
    expect(new Set(results.map((r) => r.mbid))).toEqual(new Set([IDS.recording]));
  });

  it('does not coalesce different requests', async () => {
    const mb = makeProvider();
    await Promise.all([mb.getRecording(IDS.recording), mb.getArtist(IDS.artist)]);
    expect(server.requests).toHaveLength(2);
  });

  it('shares a failure with every waiter, then allows a retry', async () => {
    server.override = () => ({ status: 500, delayMs: 30 });
    const mb = makeProvider();
    const settled = await Promise.allSettled([
      mb.getArtist(IDS.artist),
      mb.getArtist(IDS.artist),
      mb.getArtist(IDS.artist),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(server.requests).toHaveLength(1);
    server.override = undefined;
    await expect(mb.getArtist(IDS.artist)).resolves.toMatchObject({ name: 'Radiohead' });
  });

  it('lets one waiter abort without cancelling the others', async () => {
    server.override = () => ({ delayMs: 60 });
    const mb = makeProvider();
    const controller = new AbortController();
    const quitter = mb.getArtist(IDS.artist, { signal: controller.signal });
    const stayer = mb.getArtist(IDS.artist);
    controller.abort();
    await expect(quitter).rejects.toThrow();
    await expect(stayer).resolves.toMatchObject({ name: 'Radiohead' });
    expect(server.requests).toHaveLength(1);
  });

  it('drops the upstream request when the only waiter leaves', async () => {
    const limiter = new RateLimiter({ intervalMs: 10_000 });
    await limiter.acquire(); // the next acquire would wait ten seconds
    const mb = makeProvider({ limiter });
    const controller = new AbortController();
    const pending = mb.getArtist(IDS.artist, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(limiter.pending).toBe(0);
    expect(server.requests).toHaveLength(0);
  });
});

describe('503 and Retry-After', () => {
  it('waits for Retry-After, then retries and succeeds', async () => {
    let calls = 0;
    server.override = () =>
      ++calls === 1 ? { status: 503, headers: { 'retry-after': '1' }, body: '{}' } : undefined;
    const started = Date.now();
    const artist = await makeProvider().getArtist(IDS.artist);
    expect(artist.name).toBe('Radiohead');
    expect(server.requests).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(nth(server.requests, 1).at - nth(server.requests, 0).at).toBeGreaterThanOrEqual(950);
  });

  it('holds back other callers of the same limiter while backing off', async () => {
    let calls = 0;
    server.override = (request) =>
      request.path.startsWith('artist/') && ++calls === 1
        ? { status: 503, headers: { 'retry-after': '1' } }
        : undefined;
    const limiter = new RateLimiter({ intervalMs: 0 });
    const a = makeProvider({ limiter });
    const b = makeProvider({ limiter });
    const first = a.getArtist(IDS.artist);
    // Let the 503 land before the other caller asks.
    await vi.waitFor(() => {
      expect(server.requests).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = b.getRecording(IDS.recording);
    await Promise.all([first, second]);
    const recording = nth(server.to('recording/'), 0);
    expect(recording.at - nth(server.requests, 0).at).toBeGreaterThanOrEqual(900);
  });

  it('gives up after a bounded number of retries (429 too)', async () => {
    server.override = () => ({ status: 429, headers: { 'retry-after': '0' } });
    await expect(makeProvider({ maxRetries: 2 }).getArtist(IDS.artist)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(server.requests).toHaveLength(3);
  });

  it('backs off exponentially when Retry-After is missing', async () => {
    server.override = () => ({ status: 503 });
    const limiter = new RateLimiter({ intervalMs: 0 });
    const penalize = vi.spyOn(limiter, 'penalize');
    await expect(
      makeProvider({ limiter, maxRetries: 2, backoffMs: 5 }).getArtist(IDS.artist),
    ).rejects.toBeInstanceOf(MetadataError);
    expect(penalize.mock.calls.map(([ms]) => ms)).toEqual([5, 10]);
  });

  it('caps an absurd Retry-After', async () => {
    server.override = () => ({ status: 503, headers: { 'retry-after': '86400' } });
    const limiter = new RateLimiter({ intervalMs: 0 });
    const penalize = vi.spyOn(limiter, 'penalize');
    vi.spyOn(limiter, 'acquire').mockResolvedValue(); // do not really wait a minute
    await expect(
      makeProvider({ limiter, maxRetries: 1 }).getArtist(IDS.artist),
    ).rejects.toBeInstanceOf(MetadataError);
    expect(penalize).toHaveBeenCalledWith(60_000);
  });
});

describe('pickRepresentativeRelease', () => {
  const release = (id: string, over: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({
    mbid: id,
    status: 'Official',
    date: '2000-01-01',
    formats: ['CD'],
    trackCount: 10,
    ...over,
  });
  const pick = (releases: ReleaseCandidate[]) => pickRepresentativeRelease(releases)?.mbid;

  it('returns null when there are no releases', () => {
    expect(pick([])).toBeUndefined();
    expect(pickRepresentativeRelease([])).toBeNull();
  });

  it('ignores bootlegs and promos when an official release exists', () => {
    expect(
      pick([
        release('boot', { status: 'Bootleg', date: '1990-01-01' }),
        release('promo', { status: 'Promotion', date: '1991-01-01' }),
        release('official', { date: '2005-01-01' }),
      ]),
    ).toBe('official');
  });

  it('falls back to every release when none is official', () => {
    expect(
      pick([
        release('b', { status: 'Bootleg', date: '2001-01-01' }),
        release('a', { status: null, date: '1999-01-01' }),
      ]),
    ).toBe('a');
  });

  it('prefers CD and digital releases over vinyl, cassette and multi-format sets', () => {
    expect(
      pick([
        release('vinyl', { formats: ['12" Vinyl'], date: '1990-01-01' }),
        release('dvd', { formats: ['CD', 'DVD-Video'], date: '1991-01-01' }),
        release('digital', { formats: ['Digital Media'], date: '2010-01-01' }),
      ]),
    ).toBe('digital');
    expect(pick([release('vinyl', { formats: ['12" Vinyl'] })])).toBe('vinyl');
  });

  it('prefers the most common track count over deluxe and bonus editions', () => {
    expect(
      pick([
        release('deluxe', { trackCount: 23, date: '1997-01-01' }),
        release('std-late', { trackCount: 12, date: '2005-01-01' }),
        release('std-early', { trackCount: 12, date: '2001-01-01' }),
        release('bonus', { trackCount: 13, date: '1998-01-01' }),
      ]),
    ).toBe('std-early');
  });

  it('breaks a count tie in favour of the earliest release', () => {
    expect(
      pick([
        release('twelve', { trackCount: 12, date: '2003-01-01' }),
        release('fourteen', { trackCount: 14, date: '1999-01-01' }),
      ]),
    ).toBe('fourteen');
  });

  it('sorts a full date before a bare year, and undated releases last', () => {
    expect(
      pick([
        release('year', { date: '1997' }),
        release('undated', { date: null }),
        release('full', { date: '1997-06-16' }),
      ]),
    ).toBe('full');
    expect(pick([release('undated', { date: null }), release('dated', { date: '2020' })])).toBe(
      'dated',
    );
  });

  it('is deterministic whatever order MusicBrainz returns', () => {
    const releases = [release('c'), release('a'), release('b')];
    expect(pick(releases)).toBe('a');
    expect(pick([...releases].reverse())).toBe('a');
  });

  it('picks the 1997-05-21 CD for the OK Computer fixture', async () => {
    const album = await makeProvider().getReleaseGroup(IDS.releaseGroup);
    expect(album.representativeRelease?.mbid).toBe(IDS.release);
  });
});
