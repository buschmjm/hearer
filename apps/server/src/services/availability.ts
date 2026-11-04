/**
 * Library matching. Two consumers, one set of rules (full write-up in docs/MATCHING.md):
 *
 * 1. `FuzzyLibraryLookup` answers the catalog badge ('yes' | 'possible' | 'no') for a page of
 *    search results, in a fixed number of queries per page.
 *      track   exact `mb_recording_id`                          -> yes
 *              else `norm_key` (artist|title) match and the durations are within 3 s, or one
 *              of them is unknown                               -> possible
 *      album   exact `mb_release_group_id` on any item          -> yes
 *              else album item with the same album-artist|album -> possible
 *      artist  exact `mb_artist_id` on any item                 -> yes
 *              else artist item with the same normalized name   -> possible
 *    Fuzzy answers need name hints (`CatalogIds.hints`); without a hint only exact ids count.
 *
 * 2. `AvailabilityMatcher.evaluateRequest` decides a request's availability for the
 *    `requests.availability` job (H-11), stricter than the badge:
 *      track   AVAILABLE on exact MBID, or on a fuzzy match where artist, title AND duration
 *              (both known, within 3 s) all match. Anything weaker is NOT_AVAILABLE (reported
 *              under `possible`).
 *      album   the representative tracklist of the release group (MetadataProvider) against
 *              the library's tracks: all tracks present -> AVAILABLE, some -> PARTIALLY.
 *              A track is present on an exact recording id, or on a fuzzy match inside the
 *              album (same release group id, or the same album name) within 3 s. When no track
 *              matches (or MusicBrainz lists no tracks) an album item with the exact release
 *              group id still counts as AVAILABLE, for libraries whose tracks lack ids.
 *      artist  every studio album of the artist (primary type Album, no secondary types) is in
 *              the library (exact release group id on any item, or a same-named album item)
 *              -> AVAILABLE; at least one item by the artist -> PARTIALLY. An artist without
 *              studio albums can therefore be at most PARTIALLY (completeness is unknowable).
 *    Metadata calls go through the rate-limited cached provider and are memoized per `Run`.
 */
import type {
  InLibrary,
  ReleaseGroupBase,
  ReleaseGroupDetailBase,
  RequestType,
} from '@hearer/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { MetadataProvider, RecordingDetailBase } from '../adapters/metadata/types.ts';
import { MetadataError } from '../adapters/metadata/types.ts';
import type { Db } from '../db/client.ts';
import { libraryItems } from '../db/schema.ts';
import { normKey, normalizeArtist, normalizeTitle } from '../lib/normalize.ts';
import {
  MbidLibraryLookup,
  type CatalogIds,
  type LibraryLookup,
  type LibraryStatuses,
} from './badges.ts';

/** Two durations describe the same recording when they differ by at most this much. */
export const DURATION_TOLERANCE_MS = 3_000;
const CHUNK = 500;
const MAX_ARTIST_ALBUM_PAGES = 20;

/** Both known and within tolerance. */
export const durationsMatch = (a: number | null, b: number | null): boolean =>
  a !== null && b !== null && Math.abs(a - b) <= DURATION_TOLERANCE_MS;
/** Within tolerance, or at least one side unknown (cannot rule the match out). */
export const durationsCompatible = (a: number | null, b: number | null): boolean =>
  a === null || b === null || Math.abs(a - b) <= DURATION_TOLERANCE_MS;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

/** All `artist|title` keys for a title under several artist spellings. */
function keysFor(artists: readonly string[], title: string): string[] {
  return unique(
    artists.map((artist) => normKey(artist, title)).filter((key): key is string => key !== null),
  );
}

/** Index rows of one kind whose norm_key is among `keys`. */
function rowsByKey(db: Db, kind: 'artist' | 'album' | 'track', keys: readonly string[]) {
  const rows: {
    serverItemId: string;
    normKey: string;
    durationMs: number | null;
    albumName: string | null;
    mbReleaseGroupId: string | null;
  }[] = [];
  for (const part of chunked(keys)) {
    for (const row of db
      .select({
        serverItemId: libraryItems.serverItemId,
        normKey: libraryItems.normKey,
        durationMs: libraryItems.durationMs,
        albumName: libraryItems.albumName,
        mbReleaseGroupId: libraryItems.mbReleaseGroupId,
      })
      .from(libraryItems)
      .where(and(eq(libraryItems.kind, kind), inArray(libraryItems.normKey, part)))
      .all()) {
      if (row.normKey !== null) rows.push({ ...row, normKey: row.normKey });
    }
  }
  return rows;
}

/** Exact MBID matches plus name-based 'possible' matches (see the block comment above). */
export class FuzzyLibraryLookup implements LibraryLookup {
  readonly #db: Db;
  readonly #exact: MbidLibraryLookup;

  constructor(db: Db) {
    this.#db = db;
    this.#exact = new MbidLibraryLookup(db);
  }

  lookup(ids: CatalogIds): LibraryStatuses {
    const exact = this.#exact.lookup(ids);
    const hints = ids.hints;
    if (!hints) return exact;
    return {
      artists: this.#artists(ids.artists, exact.artists, hints.artists),
      albums: this.#albums(ids.albums, exact.albums, hints.albums),
      tracks: this.#tracks(ids.tracks, exact.tracks, hints.tracks),
    };
  }

  #artists(
    ids: readonly string[],
    exact: ReadonlyMap<string, InLibrary>,
    hints: NonNullable<CatalogIds['hints']>['artists'],
  ): Map<string, InLibrary> {
    const result = new Map(exact);
    const wanted = new Map<string, string>(); // mbid -> key
    for (const id of unique(ids)) {
      const name = hints?.get(id)?.name;
      const key = name === undefined ? '' : normalizeArtist(name);
      if (!exact.has(id) && key !== '') wanted.set(id, key);
    }
    const found = new Set(
      rowsByKey(this.#db, 'artist', unique([...wanted.values()])).map((r) => r.normKey),
    );
    for (const [id, key] of wanted) if (found.has(key)) result.set(id, 'possible');
    return result;
  }

  #albums(
    ids: readonly string[],
    exact: ReadonlyMap<string, InLibrary>,
    hints: NonNullable<CatalogIds['hints']>['albums'],
  ): Map<string, InLibrary> {
    const result = new Map(exact);
    const wanted = new Map<string, string[]>();
    for (const id of unique(ids)) {
      const hint = hints?.get(id);
      if (exact.has(id) || !hint) continue;
      const keys = keysFor(hint.artists, hint.title);
      if (keys.length > 0) wanted.set(id, keys);
    }
    const found = new Set(
      rowsByKey(this.#db, 'album', unique([...wanted.values()].flat())).map((r) => r.normKey),
    );
    for (const [id, keys] of wanted) if (keys.some((k) => found.has(k))) result.set(id, 'possible');
    return result;
  }

  #tracks(
    ids: readonly string[],
    exact: ReadonlyMap<string, InLibrary>,
    hints: NonNullable<CatalogIds['hints']>['tracks'],
  ): Map<string, InLibrary> {
    const result = new Map(exact);
    const wanted = new Map<string, { keys: string[]; durationMs: number | null }>();
    for (const id of unique(ids)) {
      const hint = hints?.get(id);
      if (exact.has(id) || !hint) continue;
      const keys = keysFor(hint.artists, hint.title);
      if (keys.length > 0) wanted.set(id, { keys, durationMs: hint.durationMs });
    }
    const rows = rowsByKey(this.#db, 'track', unique([...wanted.values()].flatMap((w) => w.keys)));
    const byKey = new Map<string, (number | null)[]>();
    for (const row of rows) {
      const list = byKey.get(row.normKey) ?? [];
      list.push(row.durationMs);
      byKey.set(row.normKey, list);
    }
    for (const [id, want] of wanted) {
      const hit = want.keys.some((key) =>
        (byKey.get(key) ?? []).some((duration) => durationsCompatible(want.durationMs, duration)),
      );
      if (hit) result.set(id, 'possible');
    }
    return result;
  }
}

// --- request evaluation ----------------------------------------------------------------------

export type AvailabilityStatus = 'AVAILABLE' | 'PARTIALLY_AVAILABLE' | 'NOT_AVAILABLE';

export interface AvailabilityRequest {
  type: RequestType;
  mbid: string;
  title: string;
  artistName: string | null;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  /** `server_item_id`s of the library items that satisfy the request. */
  matched: string[];
  /** Weaker candidates that did not meet the bar for a match (tracks only). */
  possible: string[];
  /** 0 to 1: 1 means every part matched by exact MusicBrainz id. */
  confidence: number;
}

const NOT_AVAILABLE: AvailabilityResult = {
  status: 'NOT_AVAILABLE',
  matched: [],
  possible: [],
  confidence: 0,
};
const FUZZY_CONFIDENCE = 0.8;
const ALBUM_ITEM_CONFIDENCE = 0.6;

/** Memoized metadata calls for one evaluation pass (shared across the requests of a job run). */
export class AvailabilityRun {
  readonly #provider: MetadataProvider;
  readonly #signal: AbortSignal | undefined;
  readonly #groups = new Map<string, Promise<ReleaseGroupDetailBase>>();
  readonly #recordings = new Map<string, Promise<RecordingDetailBase | null>>();
  readonly #artistAlbums = new Map<string, Promise<ReleaseGroupBase[]>>();

  constructor(provider: MetadataProvider, signal?: AbortSignal) {
    this.#provider = provider;
    this.#signal = signal;
  }

  releaseGroup(mbid: string): Promise<ReleaseGroupDetailBase> {
    return this.#memo(this.#groups, mbid, () =>
      this.#provider.getReleaseGroup(mbid, this.#options()),
    );
  }

  /** The recording, or null when MusicBrainz does not know it (the request's own fields are used then). */
  recording(mbid: string): Promise<RecordingDetailBase | null> {
    return this.#memo(this.#recordings, mbid, async () => {
      try {
        return await this.#provider.getRecording(mbid, this.#options());
      } catch (err) {
        if (err instanceof MetadataError && err.kind === 'not_found') return null;
        throw err;
      }
    });
  }

  /** Studio albums only: primary type Album and no secondary types. */
  studioAlbums(artistMbid: string): Promise<ReleaseGroupBase[]> {
    return this.#memo(this.#artistAlbums, artistMbid, async () => {
      const all: ReleaseGroupBase[] = [];
      const limit = 50;
      for (let page = 0; page < MAX_ARTIST_ALBUM_PAGES; page++) {
        const result = await this.#provider.getArtistReleaseGroups(
          artistMbid,
          { offset: page * limit, limit, type: 'album' },
          this.#options(),
        );
        all.push(...result.items);
        if (result.items.length === 0 || (page + 1) * limit >= result.total) break;
      }
      return all.filter(
        (rg) => rg.primaryType?.toLowerCase() === 'album' && rg.secondaryTypes.length === 0,
      );
    });
  }

  #options(): { signal?: AbortSignal } {
    return this.#signal ? { signal: this.#signal } : {};
  }

  #memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      cache.set(key, hit);
      // A failed call must be retried by the next request of the run, not replayed forever.
      hit.catch(() => cache.delete(key));
    }
    return hit;
  }
}

export class AvailabilityMatcher {
  readonly #db: Db;
  readonly #metadata: MetadataProvider;

  constructor(db: Db, metadata: MetadataProvider) {
    this.#db = db;
    this.#metadata = metadata;
  }

  newRun(signal?: AbortSignal): AvailabilityRun {
    return new AvailabilityRun(this.#metadata, signal);
  }

  /** Throws MetadataError when MusicBrainz is needed and unavailable (the job retries). */
  evaluateRequest(
    request: AvailabilityRequest,
    run: AvailabilityRun = this.newRun(),
  ): Promise<AvailabilityResult> {
    switch (request.type) {
      case 'track':
        return this.#track(request, run);
      case 'album':
        return this.#album(request, run);
      case 'artist':
        return this.#artist(request, run);
    }
  }

  async #track(request: AvailabilityRequest, run: AvailabilityRun): Promise<AvailabilityResult> {
    const exact = this.#db
      .select({ id: libraryItems.serverItemId })
      .from(libraryItems)
      .where(and(eq(libraryItems.kind, 'track'), eq(libraryItems.mbRecordingId, request.mbid)))
      .all();
    if (exact.length > 0) {
      return { status: 'AVAILABLE', matched: exact.map((r) => r.id), possible: [], confidence: 1 };
    }

    const recording = await run.recording(request.mbid);
    const artists = unique(
      [
        recording?.artistName,
        ...(recording?.artistCredit.map((c) => c.name) ?? []),
        request.artistName,
      ].filter((a): a is string => !!a),
    );
    const keys = keysFor(artists, recording?.title ?? request.title);
    if (keys.length === 0) return NOT_AVAILABLE;
    const wantMs = recording?.lengthMs ?? null;
    const matched: string[] = [];
    const possible: string[] = [];
    for (const row of rowsByKey(this.#db, 'track', keys)) {
      if (durationsMatch(wantMs, row.durationMs)) matched.push(row.serverItemId);
      else possible.push(row.serverItemId);
    }
    if (matched.length > 0) {
      return { status: 'AVAILABLE', matched, possible, confidence: FUZZY_CONFIDENCE };
    }
    return { ...NOT_AVAILABLE, possible };
  }

  async #album(request: AvailabilityRequest, run: AvailabilityRun): Promise<AvailabilityResult> {
    const group = await run.releaseGroup(request.mbid);
    const wanted = group.tracks;

    const exactAlbum = this.#db
      .select({ id: libraryItems.serverItemId })
      .from(libraryItems)
      .where(and(eq(libraryItems.kind, 'album'), eq(libraryItems.mbReleaseGroupId, request.mbid)))
      .all();

    // Exact recording ids first.
    const exactByRecording = new Map<string, string>();
    for (const part of chunked(unique(wanted.map((t) => t.mbid)))) {
      for (const row of this.#db
        .select({ id: libraryItems.serverItemId, rec: libraryItems.mbRecordingId })
        .from(libraryItems)
        .where(and(eq(libraryItems.kind, 'track'), inArray(libraryItems.mbRecordingId, part)))
        .all()) {
        if (row.rec !== null && !exactByRecording.has(row.rec))
          exactByRecording.set(row.rec, row.id);
      }
    }

    // Fuzzy, only inside this album: same release group id or the same album name.
    const albumName = normalizeTitle(group.title);
    const pending = wanted.filter((t) => !exactByRecording.has(t.mbid));
    const keyOf = (t: (typeof wanted)[number]) =>
      keysFor(
        unique([t.artistName, ...t.artistCredit.map((c) => c.name), group.artistName]),
        t.title,
      );
    const rows = rowsByKey(this.#db, 'track', unique(pending.flatMap(keyOf)));
    const used = new Set<string>();
    const fuzzyByTrack = new Map<string, string>();
    for (const track of pending) {
      const keys = keyOf(track);
      const row = rows.find(
        (r) =>
          !used.has(r.serverItemId) &&
          keys.includes(r.normKey) &&
          (r.mbReleaseGroupId === request.mbid ||
            (r.albumName !== null && normalizeTitle(r.albumName) === albumName)) &&
          durationsCompatible(track.lengthMs, r.durationMs),
      );
      if (row) {
        used.add(row.serverItemId);
        fuzzyByTrack.set(track.mbid, row.serverItemId);
      }
    }

    const matched = [...exactByRecording.entries()]
      .filter(([rec]) => wanted.some((t) => t.mbid === rec))
      .map(([, id]) => id)
      .concat([...fuzzyByTrack.values()]);
    const present = unique(
      wanted
        .filter((t) => exactByRecording.has(t.mbid) || fuzzyByTrack.has(t.mbid))
        .map((t) => t.mbid),
    ).length;
    const distinctTotal = unique(wanted.map((t) => t.mbid)).length;

    if (distinctTotal > 0 && present > 0) {
      const exactCount = unique(
        wanted.filter((t) => exactByRecording.has(t.mbid)).map((t) => t.mbid),
      ).length;
      const confidence = (exactCount + (present - exactCount) * FUZZY_CONFIDENCE) / distinctTotal;
      return {
        status: present === distinctTotal ? 'AVAILABLE' : 'PARTIALLY_AVAILABLE',
        matched,
        possible: [],
        confidence: Math.round(confidence * 1000) / 1000,
      };
    }
    if (exactAlbum.length > 0) {
      return {
        status: 'AVAILABLE',
        matched: exactAlbum.map((r) => r.id),
        possible: [],
        confidence: ALBUM_ITEM_CONFIDENCE,
      };
    }
    return NOT_AVAILABLE;
  }

  async #artist(request: AvailabilityRequest, run: AvailabilityRun): Promise<AvailabilityResult> {
    const byId = this.#db
      .select({ id: libraryItems.serverItemId })
      .from(libraryItems)
      .where(eq(libraryItems.mbArtistId, request.mbid))
      .all()
      .map((r) => r.id);
    const names = unique(
      [request.title, request.artistName]
        .filter((n): n is string => !!n)
        .map(normalizeArtist)
        .filter((n) => n !== ''),
    );
    const byName = rowsByKey(this.#db, 'artist', names).map((r) => r.serverItemId);
    const artistItems = unique([...byId, ...byName]);
    if (artistItems.length === 0) return NOT_AVAILABLE;

    const studio = await run.studioAlbums(request.mbid);
    if (studio.length === 0) {
      return { status: 'PARTIALLY_AVAILABLE', matched: artistItems, possible: [], confidence: 0.5 };
    }

    const exactIds = new Set<string>();
    for (const part of chunked(studio.map((rg) => rg.mbid))) {
      for (const row of this.#db
        .selectDistinct({ id: libraryItems.mbReleaseGroupId })
        .from(libraryItems)
        .where(inArray(libraryItems.mbReleaseGroupId, part))
        .all()) {
        if (row.id) exactIds.add(row.id);
      }
    }
    const fuzzyKeys = new Map<string, string[]>();
    for (const rg of studio) {
      if (exactIds.has(rg.mbid)) continue;
      fuzzyKeys.set(
        rg.mbid,
        keysFor([rg.artistName, request.title, request.artistName ?? ''], rg.title),
      );
    }
    const fuzzyFound = new Set(
      rowsByKey(this.#db, 'album', unique([...fuzzyKeys.values()].flat())).map((r) => r.normKey),
    );
    let exactCount = 0;
    let fuzzyCount = 0;
    for (const rg of studio) {
      if (exactIds.has(rg.mbid)) exactCount++;
      else if ((fuzzyKeys.get(rg.mbid) ?? []).some((k) => fuzzyFound.has(k))) fuzzyCount++;
    }
    const present = exactCount + fuzzyCount;
    const confidence =
      Math.round(((exactCount + fuzzyCount * FUZZY_CONFIDENCE) / studio.length) * 1000) / 1000;
    return {
      status: present === studio.length ? 'AVAILABLE' : 'PARTIALLY_AVAILABLE',
      matched: artistItems,
      possible: [],
      confidence: present === 0 ? 0.5 : confidence,
    };
  }
}
