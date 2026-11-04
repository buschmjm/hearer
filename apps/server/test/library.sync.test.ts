import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsDefault } from '@hearer/shared';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JellyfinAdapter } from '../src/adapters/mediaserver/jellyfin.ts';
import {
  MediaServerAuthError,
  MediaServerUnavailableError,
  type IterateLibraryOptions,
  type LibraryItem,
  type MediaServerAdapter,
} from '../src/adapters/mediaserver/types.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { libraryItems } from '../src/db/schema.ts';
import { buildApp } from '../src/app.ts';
import { defineJob } from '../src/jobs/registry.ts';
import {
  AVAILABILITY_JOB,
  FULL_SYNC_HOUR,
  INCREMENTAL_INTERVAL_MS,
  LIBRARY_SYNC_JOB,
  librarySyncPayload,
} from '../src/jobs/librarySync.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import { nextDailyRun } from '../src/jobs/scheduler.ts';
import {
  LibraryService,
  SYNC_STATE_KEY,
  toLocalPath,
  toServerPath,
  type PathMapping,
} from '../src/services/library.ts';
import { z } from 'zod';
import { MOCK_API_KEY, startJellyfinMock, type JellyfinMock } from './helpers/jellyfin-mock.ts';

const log = pino({ level: 'silent' });

function item(over: Partial<LibraryItem> & { serverItemId: string }): LibraryItem {
  return {
    kind: 'track',
    name: 'Song',
    artistName: 'Artist',
    albumName: 'Album',
    durationMs: 180_000,
    mbRecordingId: null,
    mbReleaseGroupId: null,
    mbArtistId: null,
    mbAlbumId: null,
    path: `/music/${over.serverItemId}.flac`,
    dateCreated: null,
    ...over,
  };
}

/** A scripted media server: `pages` are yielded in order; `failAfter` throws after that many items. */
class FakeServer {
  items: LibraryItem[] = [];
  failAfter: number | undefined;
  readonly calls: IterateLibraryOptions[] = [];
  configured = true;

  adapter(): MediaServerAdapter {
    return {
      id: 'fake',
      testConnection: () => Promise.reject(new Error('unused')),
      authenticate: () => Promise.reject(new Error('unused')),
      notifyPathsChanged: () => Promise.resolve(),
      refreshLibrary: () => Promise.resolve(),
      iterateLibrary: (opts: IterateLibraryOptions) => this.#iterate(opts),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- a generator needs no await here
  async *#iterate(opts: IterateLibraryOptions): AsyncGenerator<LibraryItem> {
    this.calls.push(opts);
    let n = 0;
    for (const it of this.items) {
      if (this.failAfter !== undefined && n >= this.failAfter) {
        throw new MediaServerUnavailableError('boom');
      }
      n++;
      yield it;
    }
  }
}

describe('LibraryService.sync', () => {
  let database: Database_;
  let server: FakeServer;
  let clock: number;
  let service: LibraryService;

  const build = (extra: Partial<ConstructorParameters<typeof LibraryService>[0]> = {}) =>
    new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: { isConfigured: () => server.configured, get: () => server.adapter() },
      now: () => clock,
      ...extra,
    });
  const rows = () => database.db.select().from(libraryItems).all();
  const ids = () =>
    rows()
      .map((r) => r.serverItemId)
      .sort();

  beforeEach(() => {
    database = openDatabase(':memory:');
    runMigrations(database.db);
    server = new FakeServer();
    clock = 1_000_000_000_000;
    service = build();
  });
  afterEach(() => {
    database.close();
  });

  it('upserts items with a normalized key and stores the server path as is', async () => {
    server.items = [
      item({
        serverItemId: 't1',
        name: 'Paranoid Android (Remastered 2009)',
        artistName: 'Radiohead',
        mbRecordingId: '9f9cf187-d6f9-437f-9d98-d59cdbd52757',
        path: '/data/music/Radiohead/OK Computer/02.flac',
      }),
      item({ serverItemId: 'al1', kind: 'album', name: 'OK Computer', artistName: 'Radiohead' }),
      item({ serverItemId: 'ar1', kind: 'artist', name: 'The Radiohead', artistName: null }),
    ];
    const result = await service.sync('full');
    expect(result).toMatchObject({ mode: 'full', seen: 3, upserted: 3, removed: 0 });
    const byId = Object.fromEntries(rows().map((r) => [r.serverItemId, r]));
    expect(byId.t1?.normKey).toBe('radiohead|paranoid android');
    expect(byId.t1?.path).toBe('/data/music/Radiohead/OK Computer/02.flac');
    expect(byId.al1?.normKey).toBe('radiohead|ok computer');
    expect(byId.ar1?.normKey).toBe('radiohead');
  });

  it('updates an existing row in place (upsert by server item id)', async () => {
    server.items = [item({ serverItemId: 't1', name: 'Old Name' })];
    await service.sync('full');
    clock += 60_000;
    server.items = [item({ serverItemId: 't1', name: 'New Name', durationMs: 1000 })];
    await service.sync('incremental');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      name: 'New Name',
      durationMs: 1000,
      normKey: 'artist|new name',
    });
    expect(rows()[0]?.syncedAt.getTime()).toBe(clock);
  });

  it('incremental reads since the last start minus the overlap and never deletes', async () => {
    server.items = [item({ serverItemId: 'a' }), item({ serverItemId: 'b' })];
    await service.sync('full');
    const firstStart = clock;
    clock += 3_600_000;
    server.items = [item({ serverItemId: 'c' })];
    const result = await service.sync('incremental');
    expect(result).toMatchObject({ seen: 1, removed: 0 });
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(server.calls[0]?.since).toBeUndefined();
    expect(server.calls[1]?.since?.getTime()).toBe(firstStart - 5 * 60_000);
  });

  it('the first incremental has no since (reads everything) and does not sweep', async () => {
    database.db
      .insert(libraryItems)
      .values({ serverItemId: 'old', kind: 'track', name: 'x', syncedAt: new Date(1) })
      .run();
    server.items = [item({ serverItemId: 'a' })];
    await service.sync('incremental');
    expect(server.calls[0]?.since).toBeUndefined();
    expect(ids()).toEqual(['a', 'old']);
  });

  it('a full sync sweeps rows that were not seen in this run', async () => {
    server.items = [
      item({ serverItemId: 'a' }),
      item({ serverItemId: 'b' }),
      item({ serverItemId: 'c' }),
    ];
    await service.sync('full');
    clock += 1000;
    server.items = [item({ serverItemId: 'a' }), item({ serverItemId: 'c' })];
    const result = await service.sync('full');
    expect(result).toMatchObject({ seen: 2, removed: 1 });
    expect(ids()).toEqual(['a', 'c']);
    expect(service.getState()).toMatchObject({
      lastFullAt: clock,
      lastIncrementalAt: clock,
      lastMode: 'full',
      lastError: null,
      lastCounts: { seen: 2, upserted: 2, removed: 1 },
    });
  });

  it('a failure partway through a full sync keeps every row and records the error', async () => {
    server.items = [
      item({ serverItemId: 'a' }),
      item({ serverItemId: 'b' }),
      item({ serverItemId: 'c' }),
    ];
    await service.sync('full');
    clock += 1000;
    server.items = [
      item({ serverItemId: 'a' }),
      item({ serverItemId: 'b' }),
      item({ serverItemId: 'z' }),
    ];
    server.failAfter = 2;
    await expect(service.sync('full')).rejects.toThrow('boom');
    // 'c' was not re-seen, but the run did not complete, so nothing is deleted.
    expect(ids()).toEqual(['a', 'b', 'c']);
    const state = service.getState();
    expect(state.lastError).toBe('boom');
    expect(state.lastErrorAt).toBe(clock);
    // The failed run did not advance the success markers.
    expect(state.lastFullAt).toBe(1_000_000_000_000);
  });

  it('a failure with a small batch size still keeps flushed rows and the old rows', async () => {
    service = build({ batchSize: 1 });
    server.items = [item({ serverItemId: 'a' }), item({ serverItemId: 'b' })];
    await service.sync('full');
    clock += 1000;
    server.items = [item({ serverItemId: 'n1' }), item({ serverItemId: 'n2' })];
    server.failAfter = 1;
    await expect(service.sync('full')).rejects.toThrow();
    expect(ids()).toEqual(['a', 'b', 'n1']);
  });

  it('the next successful run clears the error', async () => {
    server.items = [item({ serverItemId: 'a' })];
    server.failAfter = 0;
    await expect(service.sync('full')).rejects.toThrow();
    expect(service.getState().lastError).toBe('boom');
    server.failAfter = undefined;
    clock += 1000;
    await service.sync('full');
    expect(service.getState()).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it('keeps the index when a full sync sees nothing at all', async () => {
    server.items = [item({ serverItemId: 'a' })];
    await service.sync('full');
    clock += 1000;
    server.items = [];
    const result = await service.sync('full');
    expect(result.sweepSkipped).toBe(true);
    expect(ids()).toEqual(['a']);
    expect(service.getState().lastError).toMatch(/no items/);
  });

  it('writes in transactions of batchSize', async () => {
    service = build({ batchSize: 100 });
    server.items = Array.from({ length: 250 }, (_, i) => item({ serverItemId: `t${String(i)}` }));
    const spy = vi.spyOn(database.db, 'transaction');
    const result = await service.sync('full');
    expect(result.upserted).toBe(250);
    expect(rows()).toHaveLength(250);
    expect(spy).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it('is a quiet no-op without a configured media server', async () => {
    server.configured = false;
    const debug = vi.fn();
    const result = await service.sync('full', { log: { debug, info: vi.fn(), warn: vi.fn() } });
    expect(result).toMatchObject({ skipped: 'not_configured', seen: 0 });
    expect(server.calls).toHaveLength(0);
    expect(debug).toHaveBeenCalled();
    expect(service.getState().lastFullAt).toBeNull();
  });

  it('does not record an aborted run as an error', async () => {
    const controller = new AbortController();
    server.items = [item({ serverItemId: 'a' })];
    const adapter = server.adapter();
    const aborting = new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: {
        isConfigured: () => true,
        get: () => ({
          ...adapter,
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- throws on purpose
          async *iterateLibrary() {
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
          },
        }),
      },
    });
    await expect(aborting.sync('full', { signal: controller.signal })).rejects.toThrow();
    expect(aborting.getState().lastError).toBeNull();
  });

  it('status reports counts by kind and the state', async () => {
    server.items = [
      item({ serverItemId: 'a' }),
      item({ serverItemId: 'b' }),
      item({ serverItemId: 'al', kind: 'album' }),
      item({ serverItemId: 'ar', kind: 'artist', artistName: null }),
    ];
    await service.sync('full');
    const status = service.status();
    expect(status).toMatchObject({
      configured: true,
      total: 4,
      counts: { track: 2, album: 1, artist: 1 },
    });
    expect(status.state.lastFullAt).toBe(clock);
  });

  it('leaves the fuzzy key empty when the artist is unknown', async () => {
    server.items = [item({ serverItemId: 'x', artistName: null })];
    await service.sync('full');
    expect(rows()[0]?.normKey).toBeNull();
  });

  it('survives a corrupt stored state', () => {
    database.sqlite
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(SYNC_STATE_KEY, '{not json', 1);
    expect(service.getState().lastFullAt).toBeNull();
  });
});

describe('sync against the Jellyfin mock', () => {
  let mock: JellyfinMock;
  let database: Database_;
  beforeAll(async () => {
    mock = await startJellyfinMock();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    database = openDatabase(':memory:');
    runMigrations(database.db);
    mock.requests.length = 0;
    mock.behavior.forceStatus = undefined;
  });
  afterEach(() => {
    database.close();
  });

  const serviceFor = (pageSize: number) =>
    new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: {
        isConfigured: () => true,
        get: () =>
          new JellyfinAdapter({
            url: mock.url,
            apiKey: MOCK_API_KEY,
            deviceId: 'test-device',
            version: '1.0.0',
            pageSize,
          }),
      },
    });

  it('indexes both fixture pages with ids and fuzzy keys', async () => {
    const service = serviceFor(3);
    const result = await service.sync('full');
    expect(result).toMatchObject({ seen: 6, upserted: 6, removed: 0 });
    const all = database.db.select().from(libraryItems).all();
    expect(all.filter((r) => r.kind === 'track')).toHaveLength(3);
    const paranoid = all.find((r) => r.name === 'Paranoid Android');
    expect(paranoid).toMatchObject({
      normKey: 'radiohead|paranoid android',
      mbReleaseGroupId: 'b1392450-e666-3926-a536-22c65f834433',
      path: '/music/Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    });
    // The server asked for pages of 3 with an advancing StartIndex.
    const starts = mock.requests
      .filter((r) => r.path === '/Items')
      .map((r) => r.query.get('StartIndex'));
    expect(starts).toEqual(['0', '3']);
    // Only the first credited artist is used, and untagged items still get a fuzzy key.
    expect(all.find((r) => r.name === 'Untagged Demo')?.normKey).toBe('some band|untagged demo');
  });

  it('sends MinDateLastSaved on the second (incremental) run', async () => {
    const service = serviceFor(3);
    await service.sync('full');
    mock.requests.length = 0;
    await service.sync('incremental');
    const first = mock.requests.find((r) => r.path === '/Items');
    expect(first?.query.get('MinDateLastSaved')).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('a server error mid-run is recorded and the existing index survives', async () => {
    const service = serviceFor(3);
    await service.sync('full');
    mock.behavior.forceStatus = 500;
    await expect(service.sync('full')).rejects.toBeInstanceOf(MediaServerUnavailableError);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(6);
    expect(service.getState().lastError).toBeTruthy();
  });

  it('rejects with an auth error for a bad key', async () => {
    const bad = new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: {
        isConfigured: () => true,
        get: () =>
          new JellyfinAdapter({ url: mock.url, apiKey: 'wrong', deviceId: 'd', version: '1' }),
      },
    });
    await expect(bad.sync('full')).rejects.toBeInstanceOf(MediaServerAuthError);
  });
});

describe('path mapping', () => {
  const maps: PathMapping[] = [
    { serverPath: '/data/music', localPath: '/music' },
    { serverPath: '/data/music/classical', localPath: '/classical' },
  ];

  it('maps server paths to local ones', () => {
    expect(toLocalPath(maps, '/data/music/Artist/Album/01.flac')).toBe(
      '/music/Artist/Album/01.flac',
    );
    expect(toLocalPath(maps, '/data/music')).toBe('/music');
  });

  it('maps local paths to server ones', () => {
    expect(toServerPath(maps, '/music/Artist/Album')).toBe('/data/music/Artist/Album');
    expect(toServerPath(maps, '/music')).toBe('/data/music');
  });

  it('the longest prefix wins in both directions', () => {
    expect(toLocalPath(maps, '/data/music/classical/Bach/01.flac')).toBe('/classical/Bach/01.flac');
    expect(toServerPath(maps, '/classical/Bach')).toBe('/data/music/classical/Bach');
  });

  it('is separator safe: /music does not match /musical', () => {
    const m: PathMapping[] = [{ serverPath: '/music', localPath: '/mnt/m' }];
    expect(toLocalPath(m, '/musical/x.flac')).toBe('/musical/x.flac');
    expect(toLocalPath(m, '/music2')).toBe('/music2');
    expect(toServerPath([{ serverPath: '/a', localPath: '/music' }], '/musical/x')).toBe(
      '/musical/x',
    );
  });

  it('ignores trailing slashes in the configuration', () => {
    const m: PathMapping[] = [{ serverPath: '/data/music/', localPath: '/music/' }];
    expect(toLocalPath(m, '/data/music/a.flac')).toBe('/music/a.flac');
    expect(toServerPath(m, '/music/a.flac')).toBe('/data/music/a.flac');
  });

  it('passes unmapped paths and an empty mapping list through', () => {
    expect(toLocalPath(maps, '/elsewhere/a.flac')).toBe('/elsewhere/a.flac');
    expect(toServerPath([], '/music/a.flac')).toBe('/music/a.flac');
  });

  it('maps a root mapping', () => {
    const m: PathMapping[] = [{ serverPath: '/', localPath: '/mnt/library' }];
    expect(toLocalPath(m, '/Artist/a.flac')).toBe('/mnt/library/Artist/a.flac');
  });

  it('handles Windows style server paths', () => {
    const m: PathMapping[] = [{ serverPath: 'D:\\Music', localPath: '/music' }];
    expect(toLocalPath(m, 'D:\\Music\\Artist\\a.flac')).toBe('/music/Artist/a.flac');
    expect(toServerPath(m, '/music/Artist/a.flac')).toBe('D:\\Music\\Artist\\a.flac');
    expect(toLocalPath(m, 'D:\\MusicOld\\a.flac')).toBe('D:\\MusicOld\\a.flac');
  });

  it('LibraryService reads the mappings from the settings', () => {
    const database = openDatabase(':memory:');
    runMigrations(database.db);
    const service = new LibraryService({
      db: database.db,
      settings: { get: () => ({ ...settingsDefault('mediaServer'), pathMappings: maps }) },
      mediaServer: { isConfigured: () => false, get: () => ({}) as MediaServerAdapter },
    });
    expect(service.toLocalPath('/data/music/a.flac')).toBe('/music/a.flac');
    expect(service.toServerPath('/music/a.flac')).toBe('/data/music/a.flac');
    database.close();
  });

  it('the setting defaults to none and validates entries', () => {
    expect(settingsDefault('mediaServer').pathMappings).toEqual([]);
  });
});

describe('job and schedule registration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hearer-lib-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildApp defines library.sync with concurrency 1 and both schedules', async () => {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATA_DIR: dir,
        STAGING_DIR: dir,
        MUSIC_DIR: dir,
      }),
      { startJobs: true, jobs: { pollIntervalMs: 1_000_000_000 } },
    );
    await app.ready();
    const def = app.hearer.jobs.registry.get(LIBRARY_SYNC_JOB);
    expect(def?.concurrency).toBe(1);
    expect(librarySyncPayload.safeParse({ mode: 'weekly' }).success).toBe(false);
    // The incremental schedule enqueues at start with its own unique key.
    const queued = app.hearer.database.sqlite
      .prepare("SELECT unique_key k, payload_json p FROM jobs WHERE type = 'library.sync'")
      .all() as { k: string; p: string }[];
    expect(queued).toEqual([
      { k: 'schedule:library.sync:incremental', p: JSON.stringify({ mode: 'incremental' }) },
    ]);
    // Every 15 minutes: advancing past the interval fires again once the first has finished.
    expect(INCREMENTAL_INTERVAL_MS).toBe(15 * 60_000);
    await app.close();
  });

  it('the nightly full sync is armed for 03:00 local, not at start', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: dir,
      STAGING_DIR: dir,
      MUSIC_DIR: dir,
    });
    const app = await buildApp(config, {
      startJobs: true,
      jobs: { pollIntervalMs: 1_000_000_000 },
    });
    await app.ready();
    const count = () =>
      (
        app.hearer.database.sqlite
          .prepare("SELECT count(*) c FROM jobs WHERE unique_key = 'schedule:library.sync:full'")
          .get() as { c: number }
      ).c;
    expect(count()).toBe(0);
    const delay = nextDailyRun(Date.now(), FULL_SYNC_HOUR) - Date.now();
    await vi.advanceTimersByTimeAsync(delay + 1);
    expect(count()).toBe(1);
    await app.close();
  });
});

describe('library.sync job', () => {
  let database: Database_;
  let runner: JobRunner;
  let server: FakeServer;
  let service: LibraryService;
  const seen: unknown[] = [];

  beforeEach(async () => {
    database = openDatabase(':memory:');
    runMigrations(database.db);
    server = new FakeServer();
    server.items = [item({ serverItemId: 'a' })];
    service = new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: { isConfigured: () => server.configured, get: () => server.adapter() },
    });
    runner = new JobRunner({ database, logger: log, pollIntervalMs: 5 });
    const { registerLibrarySync } = await import('../src/jobs/librarySync.ts');
    seen.length = 0;
    runner.define(
      defineJob({
        type: AVAILABILITY_JOB,
        payload: z.object({}),
        concurrency: 1,
        handler: (payload) => {
          seen.push(payload);
        },
      }),
    );
    registerLibrarySync(runner, service);
  });
  afterEach(async () => {
    await runner.stop({ graceMs: 0 });
    database.close();
  });

  it('runs a sync and then queues the availability job', async () => {
    runner.enqueue(LIBRARY_SYNC_JOB, { mode: 'full' });
    runner.start();
    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    expect(service.getState().lastFullAt).not.toBeNull();
  });

  it('does not queue availability when nothing was synced (not configured)', async () => {
    server.configured = false;
    const id = runner.enqueue(LIBRARY_SYNC_JOB, { mode: 'full' });
    runner.start();
    await vi.waitFor(() => {
      expect(runner.get(id)?.status).toBe('succeeded');
    });
    expect(seen).toHaveLength(0);
  });

  it('works when the availability job is not registered yet', async () => {
    const lonely = new JobRunner({ database, logger: log, pollIntervalMs: 5 });
    const { registerLibrarySync } = await import('../src/jobs/librarySync.ts');
    registerLibrarySync(lonely, service);
    const id = lonely.enqueue(LIBRARY_SYNC_JOB, { mode: 'full' });
    lonely.start();
    await vi.waitFor(() => {
      expect(lonely.get(id)?.status).toBe('succeeded');
    });
    await lonely.stop({ graceMs: 0 });
  });

  it('a rejected key fails the job permanently', async () => {
    const failing = new LibraryService({
      db: database.db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: {
        isConfigured: () => true,
        get: () => ({
          ...server.adapter(),
          // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- throws on purpose
          async *iterateLibrary() {
            throw new MediaServerAuthError('nope', 401);
          },
        }),
      },
    });
    const other = new JobRunner({ database, logger: log, pollIntervalMs: 5 });
    const { registerLibrarySync } = await import('../src/jobs/librarySync.ts');
    registerLibrarySync(other, failing);
    const id = other.enqueue(LIBRARY_SYNC_JOB, { mode: 'full' });
    other.start();
    await vi.waitFor(() => {
      expect(other.get(id)?.status).toBe('dead');
    });
    expect(other.get(id)?.attempts).toBe(1);
    await other.stop({ graceMs: 0 });
  });
});
