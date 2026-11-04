import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  MetadataError,
  type ArtistDetailBase,
  type MetadataProvider,
  type RecordingDetailBase,
  type ReleaseGroupBase,
  type ReleaseGroupDetailBase,
  type TrackBase,
} from '../../src/adapters/metadata/types.ts';
import { jobs as jobsTable, libraryItems, requests } from '../../src/db/schema.ts';
import type { JobContext } from '../../src/jobs/registry.ts';
import { indexKey } from '../../src/services/library.ts';

export const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ARTIST = ID(1);
export const ALBUM = ID(100);
export const TRACKS = [ID(201), ID(202), ID(203)] as const;

const credit = (name: string) => [{ mbid: ARTIST, name, joinPhrase: '' }];

export function releaseGroup(
  mbid: string,
  title: string,
  trackIds: readonly string[],
  artist = 'Radiohead',
): ReleaseGroupDetailBase {
  const tracks: TrackBase[] = trackIds.map((id, i) => ({
    mbid: id,
    title: `Track ${String(i + 1)}`,
    discNumber: 1,
    position: i + 1,
    number: String(i + 1),
    lengthMs: 200_000 + i * 1000,
    artistCredit: credit(artist),
    artistName: artist,
    isrcs: [],
  }));
  return {
    mbid,
    title,
    disambiguation: '',
    primaryType: 'Album',
    secondaryTypes: [],
    firstReleaseDate: '1997-05-21',
    artistCredit: credit(artist),
    artistName: artist,
    coverUrl: `https://coverartarchive.org/release-group/${mbid}/front-250`,
    score: null,
    releases: [],
    representativeRelease: null,
    tracks,
  };
}

export function recording(
  mbid: string,
  title: string,
  group: ReleaseGroupBase | null,
  artist = 'Radiohead',
): RecordingDetailBase {
  return {
    mbid,
    title,
    disambiguation: '',
    lengthMs: 200_000,
    artistCredit: credit(artist),
    artistName: artist,
    releaseGroup: group
      ? {
          mbid: group.mbid,
          title: group.title,
          primaryType: group.primaryType,
          coverUrl: group.coverUrl,
        }
      : null,
    coverUrl: group?.coverUrl ?? null,
    firstReleaseDate: '1997-05-21',
    score: null,
    isrcs: [],
    releaseGroups: group ? [group] : [],
  };
}

/** A MetadataProvider that serves the three lookups requests use from in-memory maps. */
export class FakeMetadata implements Partial<MetadataProvider> {
  artists = new Map<string, ArtistDetailBase>();
  groups = new Map<string, ReleaseGroupDetailBase>();
  recordings = new Map<string, RecordingDetailBase>();
  down = false;
  calls: string[] = [];

  constructor() {
    this.artists.set(ARTIST, {
      mbid: ARTIST,
      name: 'Radiohead',
      sortName: 'Radiohead',
      type: 'Group',
      country: 'GB',
      disambiguation: '',
      score: null,
      lifeSpan: null,
    });
    const album = releaseGroup(ALBUM, 'OK Computer', TRACKS);
    this.groups.set(ALBUM, album);
    TRACKS.forEach((id, i) => {
      this.recordings.set(id, recording(id, `Track ${String(i + 1)}`, album));
    });
  }

  /** Another album with the same tracks as ALBUM, for tests that need several requests. */
  addAlbum(mbid: string, title: string): void {
    const base = this.groups.get(ALBUM);
    if (!base) throw new Error('base album missing');
    this.groups.set(mbid, { ...base, mbid, title });
  }

  #get<T>(map: Map<string, T>, kind: string, mbid: string): Promise<T> {
    this.calls.push(`${kind}:${mbid}`);
    if (this.down) return Promise.reject(new MetadataError('unavailable', 'down'));
    const hit = map.get(mbid);
    return hit ? Promise.resolve(hit) : Promise.reject(new MetadataError('not_found', 'unknown'));
  }

  getArtist(mbid: string) {
    return this.#get(this.artists, 'artist', mbid);
  }
  getReleaseGroup(mbid: string) {
    return this.#get(this.groups, 'group', mbid);
  }
  getRecording(mbid: string) {
    return this.#get(this.recordings, 'recording', mbid);
  }
  getArtistReleaseGroups() {
    return Promise.resolve({ items: [], total: 0, offset: 0, limit: 50 });
  }

  asProvider(): MetadataProvider {
    return this as unknown as MetadataProvider;
  }
}

/** Seed library tracks that carry MusicBrainz recording ids. */
export function seedTracks(app: FastifyInstance, ids: readonly string[], album = ALBUM): void {
  const db = app.hearer.database.db;
  ids.forEach((id, i) => {
    db.insert(libraryItems)
      .values({
        serverItemId: `jf-${id}`,
        kind: 'track',
        name: `Track ${String(i + 1)}`,
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        durationMs: 200_000,
        mbRecordingId: id,
        mbReleaseGroupId: album,
        mbArtistId: ARTIST,
        normKey: indexKey({
          kind: 'track',
          name: `Track ${String(i + 1)}`,
          artistName: 'Radiohead',
        }),
      })
      .run();
  });
}

/** Run a registered job's handler directly (deterministic; no worker loop or backoff). */
export async function runJob(
  app: FastifyInstance,
  type: string,
  payload: unknown,
  attempt = 1,
): Promise<void> {
  const def = app.hearer.jobs.registry.get(type);
  if (!def) throw new Error(`job not registered: ${type}`);
  const ctx: JobContext = {
    jobId: 1,
    attempt,
    signal: new AbortController().signal,
    log: app.log,
    db: app.hearer.database.db,
    enqueue: () => 1,
  };
  await def.handler(def.payload.parse(payload), ctx);
}

export function queuedJobs(app: FastifyInstance, type: string) {
  return app.hearer.database.db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.type, type), eq(jobsTable.status, 'queued')))
    .all();
}

export function requestRow(app: FastifyInstance, id: string) {
  const row = app.hearer.database.db.select().from(requests).where(eq(requests.id, id)).get();
  if (!row) throw new Error('no such request');
  return row;
}
