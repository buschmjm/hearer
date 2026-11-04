import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { settingsDefault } from '@hearer/shared';
import { eq, like } from 'drizzle-orm';
import { parseFile } from 'music-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryItem, MediaServerAdapter } from '../src/adapters/mediaserver/types.ts';
import { jobs, libraryItems, requests, uploads } from '../src/db/schema.ts';
import {
  LibraryService,
  PROVISIONAL_ID_PREFIX,
  PROVISIONAL_MAX_AGE_MS,
} from '../src/services/library.ts';
import { makeAudio } from './helpers/analyze.ts';
import { call } from './helpers/auth.ts';
import {
  FIXTURE_TRACKS,
  SERVER_MUSIC,
  listFiles,
  seedApproved,
  seedOtherTracks,
  startImportRig,
  type ImportRig,
} from './helpers/importRig.ts';
import { IDS } from './helpers/mbServer.ts';
import { tusUpload, waitFor, type UploadHarness } from './helpers/uploads.ts';

let rig: ImportRig;
afterEach(async () => {
  await rig.closeAll();
});

const EXPECTED = 'Radiohead/OK Computer (1997)/02 - Paranoid Android.mp3';

describe('acceptance 6: an untagged MP3 lands tagged in the library and Jellyfin hears about it', () => {
  it('upload via tus -> analyze -> auto-approve -> import -> request AVAILABLE', async () => {
    rig = await startImportRig({ startJobs: true });
    const { app } = rig.h;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const ctx = { base, tusUrl: `${base}/api/v1/uploads/tus` } as unknown as UploadHarness;

    // A manual track request: the requester asks, an admin approves, Manual waits for an upload.
    const created = await call(app, rig.trusted, 'POST', '/api/v1/requests', {
      type: 'track',
      mbid: IDS.recording,
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json<{ id: string }>().id;
    expect(
      (await call(app, rig.admin, 'POST', `/api/v1/requests/${requestId}/approve`)).statusCode,
    ).toBe(200);
    await waitFor(
      () =>
        app.hearer.database.db.select().from(requests).where(eq(requests.id, requestId)).get()
          ?.status === 'AWAITING_UPLOAD',
    );

    // The file: untagged, as long as the recording (the fixture says 6 minutes 24).
    const file = makeAudio(rig.audioDir, 'untagged.mp3', { seconds: 384 });
    const { uploadId } = await tusUpload(ctx, rig.trusted, file, {
      filename: 'My Download (1).mp3',
      metadata: { targetRequestId: requestId },
    });
    expect(uploadId).toBeTruthy();

    const row = await waitFor(() => {
      const r = app.hearer.database.db
        .select()
        .from(uploads)
        .where(eq(uploads.id, uploadId ?? ''))
        .get();
      return r?.status === 'IMPORTED' || r?.status === 'FAILED' ? r : null;
    }, 60_000);
    expect(row.error).toBeNull();
    expect(row.status).toBe('IMPORTED');

    // Filed by the template, tagged with MusicBrainz ids and the cover.
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
    const { common } = await parseFile(join(rig.musicDir, EXPECTED));
    expect(common).toMatchObject({
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      musicbrainz_recordingid: IDS.recording,
      musicbrainz_releasegroupid: IDS.releaseGroup,
    });
    expect(common.picture).toHaveLength(1);
    expect(rig.caa.requests).toHaveLength(1);
    // The cleanup follows the status change by a moment.
    await waitFor(() => !existsSync(join(rig.stagingDir, uploadId ?? 'x')));

    // Jellyfin was told about exactly this file, by the path it knows.
    const updates = rig.jellyfin.requests.filter(
      (r) => r.method === 'POST' && r.path === '/Library/Media/Updated',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toEqual({
      Updates: [{ Path: `${SERVER_MUSIC}/${EXPECTED}`, UpdateType: 'Created' }],
    });
    expect(String(updates[0]?.headers.authorization)).toMatch(/^MediaBrowser /u);

    // The index knows the track at once, and the request ends AVAILABLE, linked to the upload.
    const item = app.hearer.database.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.mbRecordingId, IDS.recording))
      .get();
    expect(item?.serverItemId).toBe(`${PROVISIONAL_ID_PREFIX}${uploadId ?? ''}`);
    const request = app.hearer.database.db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .get();
    expect(request).toMatchObject({ status: 'AVAILABLE', fulfilledByUploadId: uploadId });
    // A follow-up library sync was scheduled.
    const queued = app.hearer.database.db.select().from(jobs).all();
    expect(queued.some((j) => j.type === 'library.sync' && j.status === 'queued')).toBe(true);

    // Uploading the same file again is a duplicate (acceptance 7).
    const again = await tusUpload(ctx, rig.trusted, file, { filename: 'again.mp3' });
    const dup = await waitFor(() => {
      const r = app.hearer.database.db
        .select()
        .from(uploads)
        .where(eq(uploads.id, again.uploadId ?? ''))
        .get();
      return r && ['DUPLICATE', 'FAILED', 'IMPORTED', 'NEEDS_REVIEW'].includes(r.status) ? r : null;
    }, 60_000);
    expect(dup.status).toBe('DUPLICATE');
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
  }, 120_000);

  it('a hostile tag never escapes MUSIC_DIR on the same path (acceptance 7)', async () => {
    rig = await startImportRig({ startJobs: true });
    const id = await seedApproved(rig, {
      tags: { title: '../../../../etc/passwd', album: '../..', albumArtist: '..', artist: '..' },
    });
    rig.h.app.hearer.jobs.enqueue('upload.import', { uploadId: id }, { uniqueKey: `import:${id}` });
    const row = await waitFor(() => {
      const r = rig.h.app.hearer.database.db.select().from(uploads).where(eq(uploads.id, id)).get();
      return r && ['IMPORTED', 'FAILED'].includes(r.status) ? r : null;
    });
    expect(row.status).toBe('IMPORTED');
    const files = listFiles(rig.musicDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.split('/')).not.toContain('..');
    expect(listFiles(dirname(rig.musicDir)).filter((f) => f.startsWith('etc'))).toEqual([]);
  }, 30_000);
});

describe('provisional library rows', () => {
  const adapterOf = (items: LibraryItem[]) =>
    ({
      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator over a fixed list
      async *iterateLibrary() {
        for (const item of items) yield item;
      },
    }) as unknown as MediaServerAdapter;

  const track = (id: string, patch: Partial<LibraryItem>): LibraryItem => ({
    serverItemId: id,
    kind: 'track',
    name: 'Paranoid Android',
    artistName: 'Radiohead',
    albumName: 'OK Computer',
    durationMs: 384_000,
    mbRecordingId: null,
    mbReleaseGroupId: null,
    mbArtistId: null,
    mbAlbumId: null,
    path: null,
    dateCreated: null,
    ...patch,
  });

  async function setup(items: LibraryItem[]) {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    await rig.h.app.hearer.imports.run(id, { attempt: 1, maxAttempts: 3 });
    const db = rig.h.app.hearer.database.db;
    const library = new LibraryService({
      db,
      settings: { get: () => settingsDefault('mediaServer') },
      mediaServer: { isConfigured: () => true, get: () => adapterOf(items) },
    });
    const provisional = () =>
      db
        .select()
        .from(libraryItems)
        .where(like(libraryItems.serverItemId, `${PROVISIONAL_ID_PREFIX}%`))
        .all();
    return { id, library, provisional };
  }

  it('stays through a sync that has not seen the file yet (full or incremental)', async () => {
    const { library, provisional } = await setup([
      track('jf-other', { mbRecordingId: FIXTURE_TRACKS[0] ?? null }),
    ]);
    await library.sync('full');
    expect(provisional()).toHaveLength(1);
    await library.sync('incremental');
    expect(provisional()).toHaveLength(1);
  });

  it('is replaced once a real item has the same path', async () => {
    const { library, provisional } = await setup([
      track('jf-real', { path: `${SERVER_MUSIC}/${EXPECTED}` }),
    ]);
    await library.sync('incremental');
    expect(provisional()).toHaveLength(0);
    expect(
      rig.h.app.hearer.database.db
        .select()
        .from(libraryItems)
        .all()
        .map((r) => r.serverItemId),
    ).toEqual(['jf-real']);
  });

  it('is replaced once a real item has the same recording id', async () => {
    const { library, provisional } = await setup([
      track('jf-real', { mbRecordingId: IDS.recording }),
    ]);
    await library.sync('full');
    expect(provisional()).toHaveLength(0);
  });

  it('expires after a week when the file never gets indexed', async () => {
    const { id, library, provisional } = await setup([track('jf-other', {})]);
    rig.h.app.hearer.database.db
      .update(libraryItems)
      .set({ syncedAt: new Date(Date.now() - PROVISIONAL_MAX_AGE_MS - 1000) })
      .where(eq(libraryItems.serverItemId, `${PROVISIONAL_ID_PREFIX}${id}`))
      .run();
    await library.sync('incremental');
    expect(provisional()).toHaveLength(0);
  });

  it('counts for request availability until then (album completeness)', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    await rig.h.app.hearer.imports.run(id, { attempt: 1, maxAttempts: 3 });
    seedOtherTracks(rig, IDS.recording);
    const result = await rig.h.app.hearer.availability.evaluateRequest({
      type: 'album',
      mbid: IDS.releaseGroup,
      title: 'OK Computer',
      artistName: 'Radiohead',
    });
    expect(result.status).toBe('AVAILABLE');
  });
});
