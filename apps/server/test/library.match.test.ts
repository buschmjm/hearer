import { Permission, type Page, type RecordingSummary } from '@hearer/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MetadataError,
  type MetadataProvider,
  type RecordingDetailBase,
  type ReleaseGroupBase,
  type ReleaseGroupDetailBase,
  type TrackBase,
} from '../src/adapters/metadata/types.ts';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { libraryItems } from '../src/db/schema.ts';
import { indexKey } from '../src/services/library.ts';
import {
  AvailabilityMatcher,
  FuzzyLibraryLookup,
  durationsCompatible,
  durationsMatch,
  type AvailabilityRequest,
} from '../src/services/availability.ts';
import type { CatalogHints } from '../src/services/badges.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Harness,
} from './helpers/auth.ts';

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RG = ID(1000);
const ARTIST = ID(2000);

let database: Database_;
beforeEach(() => {
  database = openDatabase(':memory:');
  runMigrations(database.db);
});
afterEach(() => {
  database.close();
});

interface Seed {
  id: string;
  kind?: 'track' | 'album' | 'artist';
  name: string;
  artist?: string | null;
  album?: string | null;
  ms?: number | null;
  rec?: string;
  rg?: string;
  mbArtist?: string;
}
function seed(...rows: Seed[]): void {
  for (const r of rows) {
    const kind = r.kind ?? 'track';
    const artistName = r.artist === undefined ? 'Radiohead' : r.artist;
    database.db
      .insert(libraryItems)
      .values({
        serverItemId: r.id,
        kind,
        name: r.name,
        artistName: kind === 'artist' ? null : artistName,
        albumName: r.album ?? null,
        durationMs: r.ms ?? null,
        mbRecordingId: r.rec ?? null,
        mbReleaseGroupId: r.rg ?? null,
        mbArtistId: r.mbArtist ?? null,
        normKey: indexKey({
          kind,
          name: r.name,
          artistName: kind === 'artist' ? null : artistName,
        }),
      })
      .run();
  }
}

// --- LibraryLookup ---------------------------------------------------------------------------

describe('FuzzyLibraryLookup', () => {
  const lookup = () => new FuzzyLibraryLookup(database.db);
  const trackHints = (
    id: string,
    over: { artists?: string[]; title?: string; durationMs?: number | null } = {},
  ): CatalogHints => ({
    tracks: new Map([
      [
        id,
        {
          artists: over.artists ?? ['Radiohead'],
          title: over.title ?? 'Paranoid Android',
          durationMs: over.durationMs === undefined ? 383_000 : over.durationMs,
        },
      ],
    ]),
  });
  const trackStatus = (id: string, hints?: CatalogHints) =>
    lookup()
      .lookup({ artists: [], albums: [], tracks: [id], hints })
      .tracks.get(id) ?? 'no';

  describe('tracks', () => {
    it('exact MBID is yes, with or without hints', () => {
      seed({ id: 't', name: 'Whatever', rec: ID(1) });
      expect(trackStatus(ID(1))).toBe('yes');
      expect(trackStatus(ID(1), trackHints(ID(1), { title: 'Other' }))).toBe('yes');
    });

    it('a name match with a close duration is possible', () => {
      seed({ id: 't', name: 'Paranoid Android', ms: 383_500 });
      expect(trackStatus(ID(1), trackHints(ID(1)))).toBe('possible');
    });

    it('the duration boundary: 3.0 s matches, 3.1 s does not', () => {
      seed({ id: 't', name: 'Paranoid Android', ms: 386_000 });
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: 383_000 }))).toBe('possible');
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: 382_900 }))).toBe('no');
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: 389_000 }))).toBe('possible');
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: 389_100 }))).toBe('no');
    });

    it('an unknown duration on either side still gives possible', () => {
      seed({ id: 't', name: 'Paranoid Android', ms: null });
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: 383_000 }))).toBe('possible');
      database.db.delete(libraryItems).run();
      seed({ id: 't2', name: 'Paranoid Android', ms: 100_000 });
      expect(trackStatus(ID(1), trackHints(ID(1), { durationMs: null }))).toBe('possible');
    });

    it('ignores noise in the names and the artist spelling', () => {
      seed({
        id: 't',
        name: 'Paranoid Android (Remastered 2009)',
        artist: 'Radiohead',
        ms: 383_000,
      });
      expect(
        trackStatus(ID(1), trackHints(ID(1), { artists: ['The Radiohead feat. Someone'] })),
      ).toBe('possible');
    });

    it('tries every artist spelling', () => {
      seed({ id: 't', name: 'Song', artist: 'Simon', ms: 1000 });
      expect(
        trackStatus(
          ID(1),
          trackHints(ID(1), {
            artists: ['Simon & Garfunkel', 'Simon'],
            title: 'Song',
            durationMs: 1000,
          }),
        ),
      ).toBe('possible');
    });

    it('different artist, different title, or a live version is no', () => {
      seed({ id: 't', name: 'Paranoid Android', artist: 'Someone Else', ms: 383_000 });
      expect(trackStatus(ID(1), trackHints(ID(1)))).toBe('no');
      database.db.delete(libraryItems).run();
      seed({ id: 't', name: 'Paranoid Android (Live)', ms: 383_000 });
      expect(trackStatus(ID(1), trackHints(ID(1)))).toBe('no');
    });

    it('only tracks count for a track hint', () => {
      seed({ id: 'a', kind: 'album', name: 'Paranoid Android' });
      expect(trackStatus(ID(1), trackHints(ID(1)))).toBe('no');
    });

    it('without a hint, nothing fuzzy is attempted', () => {
      seed({ id: 't', name: 'Paranoid Android', ms: 383_000 });
      expect(trackStatus(ID(1))).toBe('no');
    });
  });

  describe('albums', () => {
    const hints = (title = 'OK Computer', artists = ['Radiohead']): CatalogHints => ({
      albums: new Map([[RG, { artists, title }]]),
    });
    const status = (h?: CatalogHints) =>
      lookup()
        .lookup({ artists: [], albums: [RG], tracks: [], hints: h })
        .albums.get(RG) ?? 'no';

    it('exact release group id on any item is yes', () => {
      seed({ id: 't', name: 'Airbag', rg: RG });
      expect(status()).toBe('yes');
    });

    it('album artist and name match is possible', () => {
      seed({ id: 'al', kind: 'album', name: 'OK Computer (Deluxe Edition)' });
      expect(status(hints())).toBe('possible');
      expect(status(hints('ok computer', ['The Radiohead']))).toBe('possible');
    });

    it('another artist with the same album name is no', () => {
      seed({ id: 'al', kind: 'album', name: 'OK Computer', artist: 'Cover Band' });
      expect(status(hints())).toBe('no');
    });
  });

  describe('artists', () => {
    const status = (h?: CatalogHints) =>
      lookup()
        .lookup({ artists: [ARTIST], albums: [], tracks: [], hints: h })
        .artists.get(ARTIST) ?? 'no';
    const hints = (name: string): CatalogHints => ({ artists: new Map([[ARTIST, { name }]]) });

    it('mb_artist_id is yes', () => {
      seed({ id: 'ar', kind: 'artist', name: 'Anything', mbArtist: ARTIST });
      expect(status()).toBe('yes');
    });

    it('a normalized name match is possible', () => {
      seed({ id: 'ar', kind: 'artist', name: 'The Radiohead' });
      expect(status(hints('Radiohead'))).toBe('possible');
      expect(status(hints('Other Band'))).toBe('no');
    });
  });

  it('answers a whole page with a fixed number of queries', () => {
    const tracks = Array.from({ length: 50 }, (_, i) => ID(i + 1));
    const albums = Array.from({ length: 50 }, (_, i) => ID(i + 100));
    const artists = Array.from({ length: 50 }, (_, i) => ID(i + 200));
    const hints: CatalogHints = {
      tracks: new Map(
        tracks.map((t, i) => [t, { artists: ['A'], title: `T${String(i)}`, durationMs: 1 }]),
      ),
      albums: new Map(albums.map((t, i) => [t, { artists: ['A'], title: `B${String(i)}` }])),
      artists: new Map(artists.map((t, i) => [t, { name: `N${String(i)}` }])),
    };
    seed({ id: 'x', name: 'T3', artist: 'A', ms: 1 });
    const prepare = vi.spyOn(database.sqlite, 'prepare');
    const result = lookup().lookup({ artists, albums, tracks, hints });
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.tracks.get(tracks[3] ?? '')).toBe('possible');
    expect(result.tracks.size).toBe(1);
  });

  it('duration helpers', () => {
    expect(durationsMatch(1000, 4000)).toBe(true);
    expect(durationsMatch(1000, 4001)).toBe(false);
    expect(durationsMatch(null, 1000)).toBe(false);
    expect(durationsCompatible(null, 1000)).toBe(true);
    expect(durationsCompatible(1000, 4001)).toBe(false);
  });
});

// --- evaluateRequest -------------------------------------------------------------------------

const credit = (name: string) => [{ mbid: ARTIST, name, joinPhrase: '' }];
function mbTrack(
  n: number,
  title: string,
  lengthMs: number | null,
  artist = 'Radiohead',
): TrackBase {
  return {
    mbid: ID(n),
    title,
    discNumber: 1,
    position: n,
    number: String(n),
    lengthMs,
    artistCredit: credit(artist),
    artistName: artist,
    isrcs: [],
  };
}
function mbGroup(over: Partial<ReleaseGroupBase> = {}): ReleaseGroupBase {
  return {
    mbid: RG,
    title: 'OK Computer',
    disambiguation: '',
    primaryType: 'Album',
    secondaryTypes: [],
    firstReleaseDate: '1997',
    artistCredit: credit('Radiohead'),
    artistName: 'Radiohead',
    coverUrl: '',
    score: null,
    ...over,
  };
}

interface Stub {
  provider: MetadataProvider;
  groups: Map<string, ReleaseGroupDetailBase>;
  recordings: Map<string, RecordingDetailBase>;
  artistGroups: Map<string, ReleaseGroupBase[]>;
  calls: string[];
  failWith?: MetadataError | undefined;
}
function stubProvider(): Stub {
  const stub: Stub = {
    groups: new Map(),
    recordings: new Map(),
    artistGroups: new Map(),
    calls: [],
    provider: undefined as unknown as MetadataProvider,
  };
  const guard = (call: string) => {
    stub.calls.push(call);
    if (stub.failWith) throw stub.failWith;
  };
  // Only the methods the matcher uses are implemented; anything else is a test bug.
  stub.provider = {
    getReleaseGroup: (mbid: string) => {
      guard(`rg:${mbid}`);
      const found = stub.groups.get(mbid);
      return found ? Promise.resolve(found) : Promise.reject(new MetadataError('not_found', 'nf'));
    },
    getRecording: (mbid: string) => {
      guard(`rec:${mbid}`);
      const found = stub.recordings.get(mbid);
      return found ? Promise.resolve(found) : Promise.reject(new MetadataError('not_found', 'nf'));
    },
    getArtistReleaseGroups: (mbid: string, page: { offset: number; limit: number }) => {
      guard(`artist:${mbid}:${String(page.offset)}`);
      const all = stub.artistGroups.get(mbid) ?? [];
      return Promise.resolve({
        items: all.slice(page.offset, page.offset + page.limit),
        total: all.length,
        offset: page.offset,
        limit: page.limit,
      });
    },
  } as unknown as MetadataProvider;
  return stub;
}

function group(tracks: TrackBase[], over: Partial<ReleaseGroupBase> = {}): ReleaseGroupDetailBase {
  return { ...mbGroup(over), releases: [], representativeRelease: null, tracks };
}
function recording(n: number, title: string, lengthMs: number | null): RecordingDetailBase {
  return {
    mbid: ID(n),
    title,
    disambiguation: '',
    lengthMs,
    artistCredit: credit('Radiohead'),
    artistName: 'Radiohead',
    releaseGroup: null,
    coverUrl: null,
    firstReleaseDate: null,
    score: null,
    isrcs: [],
    releaseGroups: [],
  };
}
const req = (
  type: AvailabilityRequest['type'],
  mbid: string,
  title: string,
): AvailabilityRequest => ({
  type,
  mbid,
  title,
  artistName: 'Radiohead',
});

describe('AvailabilityMatcher.evaluateRequest', () => {
  let stub: Stub;
  let matcher: AvailabilityMatcher;
  beforeEach(() => {
    stub = stubProvider();
    matcher = new AvailabilityMatcher(database.db, stub.provider);
  });

  describe('track', () => {
    it('an exact recording id is AVAILABLE without asking MusicBrainz', async () => {
      seed({ id: 't1', name: 'Anything', rec: ID(1) });
      const result = await matcher.evaluateRequest(req('track', ID(1), 'Airbag'));
      expect(result).toEqual({ status: 'AVAILABLE', matched: ['t1'], possible: [], confidence: 1 });
      expect(stub.calls).toEqual([]);
    });

    it('artist + title + duration within 3 s is AVAILABLE', async () => {
      stub.recordings.set(ID(1), recording(1, 'Airbag', 284_000));
      seed({ id: 't1', name: 'Airbag (Remastered)', ms: 287_000 });
      const result = await matcher.evaluateRequest(req('track', ID(1), 'Airbag'));
      expect(result).toMatchObject({ status: 'AVAILABLE', matched: ['t1'], confidence: 0.8 });
    });

    it('3.1 s apart is not enough, but is reported as possible', async () => {
      stub.recordings.set(ID(1), recording(1, 'Airbag', 284_000));
      seed({ id: 't1', name: 'Airbag', ms: 287_100 });
      const result = await matcher.evaluateRequest(req('track', ID(1), 'Airbag'));
      expect(result).toEqual({
        status: 'NOT_AVAILABLE',
        matched: [],
        possible: ['t1'],
        confidence: 0,
      });
    });

    it('an unknown duration on either side is never AVAILABLE', async () => {
      stub.recordings.set(ID(1), recording(1, 'Airbag', 284_000));
      seed({ id: 't1', name: 'Airbag', ms: null });
      expect((await matcher.evaluateRequest(req('track', ID(1), 'Airbag'))).status).toBe(
        'NOT_AVAILABLE',
      );
      stub.recordings.set(ID(2), recording(2, 'Airbag', null));
      database.db.delete(libraryItems).run();
      seed({ id: 't2', name: 'Airbag', ms: 284_000 });
      const result = await matcher.evaluateRequest(req('track', ID(2), 'Airbag'));
      expect(result).toMatchObject({ status: 'NOT_AVAILABLE', possible: ['t2'] });
    });

    it('a different artist or a live version is NOT_AVAILABLE', async () => {
      stub.recordings.set(ID(1), recording(1, 'Airbag', 284_000));
      seed(
        { id: 'other', name: 'Airbag', artist: 'Someone Else', ms: 284_000 },
        { id: 'live', name: 'Airbag (Live)', ms: 284_000 },
      );
      expect(await matcher.evaluateRequest(req('track', ID(1), 'Airbag'))).toMatchObject({
        status: 'NOT_AVAILABLE',
        possible: [],
      });
    });

    it('falls back to the request fields when MusicBrainz does not know the recording', async () => {
      seed({ id: 't1', name: 'Airbag', ms: 284_000 });
      const result = await matcher.evaluateRequest(req('track', ID(9), 'Airbag'));
      // Without a known length the match cannot be confirmed.
      expect(result).toMatchObject({ status: 'NOT_AVAILABLE', possible: ['t1'] });
    });

    it('lets a MusicBrainz outage propagate so the job can retry', async () => {
      stub.failWith = new MetadataError('unavailable', 'down');
      await expect(matcher.evaluateRequest(req('track', ID(1), 'Airbag'))).rejects.toThrow('down');
    });
  });

  describe('album', () => {
    const tracks = [
      mbTrack(1, 'Airbag', 284_000),
      mbTrack(2, 'Paranoid Android', 383_000),
      mbTrack(3, 'Subterranean Homesick Alien', 267_000),
      mbTrack(4, 'Exit Music (For a Film)', 264_000),
    ];
    beforeEach(() => {
      stub.groups.set(RG, group(tracks));
    });

    it('every track present by recording id is AVAILABLE', async () => {
      seed(...tracks.map((t, i) => ({ id: `t${String(i)}`, name: t.title, rec: t.mbid })));
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result.status).toBe('AVAILABLE');
      expect(result.matched).toHaveLength(4);
      expect(result.confidence).toBe(1);
    });

    it('some tracks is PARTIALLY_AVAILABLE', async () => {
      seed(
        { id: 't0', name: 'Airbag', rec: ID(1) },
        { id: 't1', name: 'Paranoid Android', rec: ID(2) },
      );
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result).toMatchObject({
        status: 'PARTIALLY_AVAILABLE',
        matched: ['t0', 't1'],
        confidence: 0.5,
      });
    });

    it('matches untagged tracks by name inside the same album only', async () => {
      seed(
        { id: 't0', name: 'Airbag', album: 'OK Computer', ms: 284_500 },
        {
          id: 't1',
          name: 'Paranoid Android (Remastered)',
          album: 'OK Computer (Deluxe)',
          ms: 383_000,
        },
        // Same song on a compilation: not part of this album.
        { id: 'comp', name: 'Subterranean Homesick Alien', album: 'Greatest Hits', ms: 267_000 },
        // Right album, wrong duration.
        { id: 'bad', name: 'Exit Music (For a Film)', album: 'OK Computer', ms: 300_000 },
      );
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result.status).toBe('PARTIALLY_AVAILABLE');
      expect(result.matched.sort()).toEqual(['t0', 't1']);
      expect(result.confidence).toBeCloseTo(0.4, 5);
    });

    it('matches untagged tracks through the release group id too', async () => {
      seed(
        ...tracks.map((t, i) => ({
          id: `t${String(i)}`,
          name: t.title,
          rg: RG,
          album: 'x',
          ms: t.lengthMs,
        })),
      );
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result.status).toBe('AVAILABLE');
    });

    it('mixes exact and fuzzy track matches', async () => {
      seed(
        { id: 't0', name: 'Airbag', rec: ID(1) },
        { id: 't1', name: 'Paranoid Android', album: 'OK Computer', ms: 383_000 },
        { id: 't2', name: 'Subterranean Homesick Alien', album: 'OK Computer', ms: 267_000 },
        { id: 't3', name: 'Exit Music (For a Film)', rec: ID(4) },
      );
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result.status).toBe('AVAILABLE');
      expect(result.confidence).toBeCloseTo((2 + 2 * 0.8) / 4, 5);
    });

    it('an album item with the exact release group id is AVAILABLE when no track matches', async () => {
      seed({ id: 'al', kind: 'album', name: 'OK Computer', rg: RG });
      const result = await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(result).toEqual({
        status: 'AVAILABLE',
        matched: ['al'],
        possible: [],
        confidence: 0.6,
      });
    });

    it('the album item fallback also covers an empty MusicBrainz tracklist', async () => {
      stub.groups.set(RG, group([]));
      seed({ id: 'al', kind: 'album', name: 'OK Computer', rg: RG });
      expect((await matcher.evaluateRequest(req('album', RG, 'OK Computer'))).status).toBe(
        'AVAILABLE',
      );
    });

    it('a name-only album item is not enough', async () => {
      seed({ id: 'al', kind: 'album', name: 'OK Computer' });
      expect((await matcher.evaluateRequest(req('album', RG, 'OK Computer'))).status).toBe(
        'NOT_AVAILABLE',
      );
    });

    it('an empty library is NOT_AVAILABLE', async () => {
      expect(await matcher.evaluateRequest(req('album', RG, 'OK Computer'))).toEqual({
        status: 'NOT_AVAILABLE',
        matched: [],
        possible: [],
        confidence: 0,
      });
    });

    it('partial track coverage wins over the album item fallback', async () => {
      seed(
        { id: 'al', kind: 'album', name: 'OK Computer', rg: RG },
        { id: 't0', name: 'Airbag', rec: ID(1) },
      );
      expect((await matcher.evaluateRequest(req('album', RG, 'OK Computer'))).status).toBe(
        'PARTIALLY_AVAILABLE',
      );
    });

    it('memoizes metadata per run', async () => {
      seed({ id: 't0', name: 'Airbag', rec: ID(1) });
      const run = matcher.newRun();
      await matcher.evaluateRequest(req('album', RG, 'OK Computer'), run);
      await matcher.evaluateRequest(req('album', RG, 'OK Computer'), run);
      expect(stub.calls).toEqual([`rg:${RG}`]);
      await matcher.evaluateRequest(req('album', RG, 'OK Computer'));
      expect(stub.calls).toHaveLength(2);
    });

    it('does not cache a failed call in the run', async () => {
      const run = matcher.newRun();
      stub.failWith = new MetadataError('unavailable', 'down');
      await expect(matcher.evaluateRequest(req('album', RG, 'x'), run)).rejects.toThrow('down');
      stub.failWith = undefined;
      seed({ id: 't0', name: 'Airbag', rec: ID(1) });
      expect((await matcher.evaluateRequest(req('album', RG, 'x'), run)).status).toBe(
        'PARTIALLY_AVAILABLE',
      );
    });
  });

  describe('artist', () => {
    const studio = (n: number, title: string, over: Partial<ReleaseGroupBase> = {}) =>
      mbGroup({ mbid: ID(3000 + n), title, ...over });
    const albums = [studio(1, 'Pablo Honey'), studio(2, 'The Bends'), studio(3, 'OK Computer')];
    beforeEach(() => {
      stub.artistGroups.set(ARTIST, [
        ...albums,
        studio(4, 'I Might Be Wrong', { secondaryTypes: ['Live'] }),
        studio(5, 'Greatest Hits', { secondaryTypes: ['Compilation'] }),
        studio(6, 'Some EP', { primaryType: 'EP' }),
      ]);
    });
    const artistReq = (): AvailabilityRequest => ({
      type: 'artist',
      mbid: ARTIST,
      title: 'Radiohead',
      artistName: null,
    });

    it('no items by the artist is NOT_AVAILABLE and costs no metadata calls', async () => {
      seed({ id: 'other', kind: 'artist', name: 'Someone Else' });
      expect((await matcher.evaluateRequest(artistReq())).status).toBe('NOT_AVAILABLE');
      expect(stub.calls).toEqual([]);
    });

    it('every studio album is AVAILABLE (live, compilations and EPs are ignored)', async () => {
      seed(
        { id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST },
        ...albums.map((a, i) => ({
          id: `al${String(i)}`,
          kind: 'album' as const,
          name: a.title,
          rg: a.mbid,
        })),
      );
      const result = await matcher.evaluateRequest(artistReq());
      expect(result.status).toBe('AVAILABLE');
      expect(result.matched).toEqual(['ar']);
      expect(result.confidence).toBe(1);
    });

    it('a release group id on a track counts as having the album', async () => {
      seed(
        { id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST },
        ...albums.map((a, i) => ({ id: `t${String(i)}`, name: 'x', rg: a.mbid })),
      );
      expect((await matcher.evaluateRequest(artistReq())).status).toBe('AVAILABLE');
    });

    it('same-named album items count when they have no ids', async () => {
      seed(
        { id: 'ar', kind: 'artist', name: 'The Radiohead' },
        { id: 'a1', kind: 'album', name: 'Pablo Honey' },
        { id: 'a2', kind: 'album', name: 'The Bends (Deluxe Edition)' },
        { id: 'a3', kind: 'album', name: 'OK Computer' },
      );
      const result = await matcher.evaluateRequest(artistReq());
      expect(result.status).toBe('AVAILABLE');
      expect(result.confidence).toBe(0.8);
    });

    it('some albums is PARTIALLY_AVAILABLE', async () => {
      seed(
        { id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST },
        { id: 'al', kind: 'album', name: 'The Bends', rg: ID(3002) },
      );
      const result = await matcher.evaluateRequest(artistReq());
      expect(result.status).toBe('PARTIALLY_AVAILABLE');
      expect(result.confidence).toBeCloseTo(1 / 3, 3);
    });

    it('an artist item with none of the albums is PARTIALLY_AVAILABLE', async () => {
      seed({ id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST });
      expect((await matcher.evaluateRequest(artistReq())).status).toBe('PARTIALLY_AVAILABLE');
    });

    it('an artist without studio albums is at most PARTIALLY_AVAILABLE', async () => {
      stub.artistGroups.set(ARTIST, [studio(6, 'Some EP', { primaryType: 'EP' })]);
      seed({ id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST });
      expect((await matcher.evaluateRequest(artistReq())).status).toBe('PARTIALLY_AVAILABLE');
    });

    it('reads every page of the artist browse once per run', async () => {
      const many = Array.from({ length: 120 }, (_, i) => studio(10 + i, `Album ${String(i)}`));
      stub.artistGroups.set(ARTIST, many);
      seed({ id: 'ar', kind: 'artist', name: 'Radiohead', mbArtist: ARTIST });
      const run = matcher.newRun();
      await matcher.evaluateRequest(artistReq(), run);
      await matcher.evaluateRequest(artistReq(), run);
      expect(stub.calls).toEqual([
        `artist:${ARTIST}:0`,
        `artist:${ARTIST}:50`,
        `artist:${ARTIST}:100`,
      ]);
    });
  });
});

// --- through the API -------------------------------------------------------------------------

describe('badges and admin routes', () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  const recordingPage = (): Page<RecordingSummary> => ({
    items: [
      {
        mbid: ID(1),
        title: 'Airbag',
        disambiguation: '',
        lengthMs: 284_000,
        artistCredit: credit('Radiohead'),
        artistName: 'Radiohead',
        releaseGroup: null,
        coverUrl: null,
        firstReleaseDate: null,
        score: 100,
        inLibrary: 'no',
        request: null,
      },
    ],
    total: 1,
    offset: 0,
    limit: 20,
  });

  it('shows a tag-less library track as "possible" in /search, and "yes" by id', async () => {
    const metadata = {
      searchRecordings: () => Promise.resolve(recordingPage()),
    } as unknown as MetadataProvider;
    h = await createHarness({ deps: { metadata } });
    const creds = await completeSetup(h);
    const dbHandle = h.app.hearer.database.db;
    dbHandle
      .insert(libraryItems)
      .values({
        serverItemId: 'jf',
        kind: 'track',
        name: 'Airbag (Remastered 2017)',
        artistName: 'Radiohead',
        durationMs: 285_000,
        normKey: 'radiohead|airbag',
      })
      .run();
    const search = () =>
      call(h.app, creds, 'GET', '/api/v1/search?q=airbag&type=track').then(
        (r) => r.json<Page<RecordingSummary>>().items[0]?.inLibrary,
      );
    expect(await search()).toBe('possible');
    dbHandle
      .update(libraryItems)
      .set({ mbRecordingId: ID(1) })
      .run();
    expect(await search()).toBe('yes');
    dbHandle.delete(libraryItems).run();
    expect(await search()).toBe('no');
  });

  it('GET /library/status needs MANAGE_SETTINGS and reports state and counts', async () => {
    h = await createHarness();
    const admin = await completeSetup(h);
    await addUser(h.app, 'plain', Permission.REQUEST);
    const plain = await login(h.app, 'plain');
    expect((await call(h.app, undefined, 'GET', '/api/v1/library/status')).statusCode).toBe(401);
    expect((await call(h.app, plain, 'GET', '/api/v1/library/status')).statusCode).toBe(403);
    h.app.hearer.database.db
      .insert(libraryItems)
      .values([
        { serverItemId: 'a', kind: 'track', name: 'x' },
        { serverItemId: 'b', kind: 'album', name: 'y' },
      ])
      .run();
    const res = await call(h.app, admin, 'GET', '/api/v1/library/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: false,
      total: 2,
      counts: { artist: 0, album: 1, track: 1 },
      state: { lastIncrementalAt: null, lastFullAt: null, lastError: null },
    });
  });

  it('POST /library/sync refuses without a media server, then queues and de-duplicates', async () => {
    h = await createHarness();
    const admin = await completeSetup(h);
    await addUser(h.app, 'plain', Permission.REQUEST);
    const plain = await login(h.app, 'plain');
    const post = (c: typeof admin | undefined, body: unknown) =>
      call(h.app, c, 'POST', '/api/v1/library/sync', body);
    expect((await post(undefined, { mode: 'full' })).statusCode).toBe(401);
    expect((await post(plain, { mode: 'full' })).statusCode).toBe(403);
    const none = await post(admin, { mode: 'full' });
    expect(none.statusCode).toBe(409);
    expect(none.json<{ error: { code: string } }>().error.code).toBe('media_server_not_configured');

    h.app.hearer.settings.set('mediaServer', { url: 'http://jellyfin.invalid:8096', apiKey: 'k' });
    expect((await post(admin, { mode: 'weekly' })).statusCode).toBe(400);
    expect((await post(admin, {})).statusCode).toBe(400);
    const first = await post(admin, { mode: 'full' });
    expect(first.statusCode).toBe(202);
    const { jobId } = first.json<{ jobId: number; mode: string }>();
    expect(first.json()).toMatchObject({ mode: 'full' });
    expect((await post(admin, { mode: 'full' })).json<{ jobId: number }>().jobId).toBe(jobId);
    const other = await post(admin, { mode: 'incremental' });
    expect(other.json<{ jobId: number }>().jobId).not.toBe(jobId);
    const job = h.app.hearer.jobs.get(jobId);
    expect(job).toMatchObject({
      type: 'library.sync',
      status: 'queued',
      uniqueKey: 'library.sync:full',
    });
  });
});
