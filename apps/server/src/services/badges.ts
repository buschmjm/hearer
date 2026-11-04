import type { Badges, InLibrary, RequestBadge, RequestType } from '@hearer/shared';
import { and, desc, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { libraryItems, requests } from '../db/schema.ts';

/**
 * Names for fuzzy matching, keyed by MusicBrainz id. Callers that have the catalog items at hand
 * (search results, detail pages) pass these so a lookup can answer 'possible' for items whose
 * library copy carries no MusicBrainz ids. Optional: an id without a hint only matches exactly.
 */
export interface CatalogHints {
  artists?: ReadonlyMap<string, { name: string }>;
  /** `artists` lists alternative credit spellings (joined credit, first credit). */
  albums?: ReadonlyMap<string, { artists: readonly string[]; title: string }>;
  tracks?: ReadonlyMap<
    string,
    { artists: readonly string[]; title: string; durationMs: number | null }
  >;
}

/** MusicBrainz ids to check, grouped by what they identify. */
export interface CatalogIds {
  artists: readonly string[];
  albums: readonly string[];
  tracks: readonly string[];
  hints?: CatalogHints | undefined;
}

export interface LibraryStatuses {
  artists: ReadonlyMap<string, InLibrary>;
  albums: ReadonlyMap<string, InLibrary>;
  tracks: ReadonlyMap<string, InLibrary>;
}

/**
 * Answers "is this in the library?" for a page of ids at once. Ids absent from the result
 * count as 'no'. `MbidLibraryLookup` answers exact matches only; `FuzzyLibraryLookup`
 * (services/availability.ts, the app default) also answers 'possible' from name hints.
 */
export interface LibraryLookup {
  lookup: (ids: CatalogIds) => LibraryStatuses;
}

const CHUNK = 500;
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** Exact MBID matches against the synced library index. One query per kind of id. */
export class MbidLibraryLookup implements LibraryLookup {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  lookup(ids: CatalogIds): LibraryStatuses {
    return {
      artists: this.#match(ids.artists, libraryItems.mbArtistId),
      albums: this.#match(ids.albums, libraryItems.mbReleaseGroupId),
      tracks: this.#match(ids.tracks, libraryItems.mbRecordingId),
    };
  }

  #match(
    ids: readonly string[],
    column:
      | typeof libraryItems.mbArtistId
      | typeof libraryItems.mbReleaseGroupId
      | typeof libraryItems.mbRecordingId,
  ): Map<string, InLibrary> {
    const found = new Map<string, InLibrary>();
    const wanted = unique(ids);
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const rows = this.#db
        .selectDistinct({ id: column })
        .from(libraryItems)
        .where(inArray(column, wanted.slice(i, i + CHUNK)))
        .all();
      for (const row of rows) if (row.id) found.set(row.id, 'yes');
    }
    return found;
  }
}

/** The latest non-cancelled request per `type:mbid`, for a page of ids, in one query. */
export function lookupRequests(db: Db, ids: CatalogIds): ReadonlyMap<string, RequestBadge> {
  const all = unique([...ids.artists, ...ids.albums, ...ids.tracks]);
  const result = new Map<string, RequestBadge>();
  for (let i = 0; i < all.length; i += CHUNK) {
    const rows = db
      .select({
        id: requests.id,
        type: requests.type,
        mbid: requests.mbid,
        status: requests.status,
      })
      .from(requests)
      .where(and(inArray(requests.mbid, all.slice(i, i + CHUNK)), ne(requests.status, 'CANCELLED')))
      // Newest first: the first row seen per key is the latest request.
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .all();
    for (const row of rows) {
      const key = requestKey(row.type, row.mbid);
      if (!result.has(key)) result.set(key, { id: row.id, status: row.status });
    }
  }
  return result;
}

export const requestKey = (type: RequestType, mbid: string): string => `${type}:${mbid}`;

/** Library and request badges for one page of results, resolved with batched queries. */
export class BadgeService {
  readonly #db: Db;
  readonly #library: LibraryLookup;

  constructor(db: Db, library: LibraryLookup = new MbidLibraryLookup(db)) {
    this.#db = db;
    this.#library = library;
  }

  resolve(ids: Partial<CatalogIds>): {
    artist: (mbid: string) => Badges;
    album: (mbid: string) => Badges;
    track: (mbid: string) => Badges;
  } {
    const full: CatalogIds = {
      artists: ids.artists ?? [],
      albums: ids.albums ?? [],
      tracks: ids.tracks ?? [],
      hints: ids.hints,
    };
    const library = this.#library.lookup(full);
    const reqs = lookupRequests(this.#db, full);
    const badge = (
      statuses: ReadonlyMap<string, InLibrary>,
      type: RequestType,
      mbid: string,
    ): Badges => ({
      inLibrary: statuses.get(mbid) ?? 'no',
      request: reqs.get(requestKey(type, mbid)) ?? null,
    });
    return {
      artist: (mbid) => badge(library.artists, 'artist', mbid),
      album: (mbid) => badge(library.albums, 'album', mbid),
      track: (mbid) => badge(library.tracks, 'track', mbid),
    };
  }
}
