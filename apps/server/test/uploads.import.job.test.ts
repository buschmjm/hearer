import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { parseFile } from 'music-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryItems, requestEvents, requests, uploads } from '../src/db/schema.ts';
import type { UploadEventPayload } from '../src/lib/events.ts';
import { sha256File } from '../src/lib/atomicMove.ts';
import {
  ImportPermanentError,
  provisionalItemId,
  type ImportPoint,
} from '../src/services/import.ts';
import { rowOf } from './helpers/analyze.ts';
import {
  FIXTURE_TRACKS,
  SERVER_MUSIC,
  listFiles,
  makeJpeg,
  seedApproved,
  seedOtherTracks,
  startImportRig,
  type ImportRig,
} from './helpers/importRig.ts';
import { IDS } from './helpers/mbServer.ts';
import { authHeaders } from './helpers/uploads.ts';

let rig: ImportRig;
afterEach(async () => {
  await rig.closeAll();
});

const CTX = { attempt: 1, maxAttempts: 4 } as const;
const EXPECTED = 'Radiohead/OK Computer (1997)/02 - Paranoid Android.mp3';

const run = (id: string, ctx: { attempt: number; maxAttempts: number } = CTX) =>
  rig.h.app.hearer.imports.run(id, ctx);

const crashOnce = (point: ImportPoint) => {
  let fired = false;
  rig.hook.current = (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Error(`simulated crash at ${p}`);
    }
  };
};

const exdev = () => {
  rig.renameImpl.current = (from, to) => {
    if (String(to).startsWith(rig.musicDir)) {
      return Promise.reject(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    }
    return import('node:fs/promises').then((fs) => fs.rename(from, to));
  };
};

const mediaUpdates = () =>
  rig.jellyfin.requests.filter((r) => r.method === 'POST' && r.path === '/Library/Media/Updated');

const stagingOf = (id: string) => join(rig.stagingDir, id);

function insertRequest(patch: Partial<typeof requests.$inferInsert>): string {
  const id = randomUUID();
  rig.h.app.hearer.database.db
    .insert(requests)
    .values({
      id,
      type: 'track',
      mbid: IDS.recording,
      title: 'Paranoid Android',
      artistName: 'Radiohead',
      status: 'AWAITING_UPLOAD',
      requestedBy: rig.aliceId,
      ...patch,
    })
    .run();
  return id;
}

const requestOf = (id: string) =>
  rig.h.app.hearer.database.db.select().from(requests).where(eq(requests.id, id)).get();

describe('upload.import: the happy path', () => {
  it('tags, embeds the cover, files by template and announces', async () => {
    rig = await startImportRig();
    const imported: UploadEventPayload[] = [];
    rig.h.app.hearer.events.on('upload.imported', (p) => {
      imported.push(p);
    });
    const requestId = insertRequest({});
    const id = await seedApproved(rig, { targetRequestId: requestId });
    await run(id);

    const row = rowOf(rig, id);
    expect(row?.status).toBe('IMPORTED');
    const dest = join(realpathSync(rig.musicDir), EXPECTED);
    expect(row?.libraryPath).toBe(dest);
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);

    const { common } = await parseFile(dest);
    expect(common).toMatchObject({
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      track: { no: 2, of: 12 },
      musicbrainz_recordingid: IDS.recording,
      musicbrainz_albumid: IDS.release,
      musicbrainz_releasegroupid: IDS.releaseGroup,
    });
    expect(common.picture).toHaveLength(1);
    expect(rig.caa.requests).toEqual([`/release/${IDS.release}/front-1200`]);

    // Staging is gone; the library holds exactly one file.
    expect(existsSync(stagingOf(id))).toBe(false);
    expect(row?.stagingPath).toBeNull();

    // Jellyfin was told, with the path as it sees it.
    expect(mediaUpdates()).toHaveLength(1);
    expect(mediaUpdates()[0]?.body).toEqual({
      Updates: [{ Path: `${SERVER_MUSIC}/${EXPECTED}`, UpdateType: 'Created' }],
    });

    // Provisional index row, request link, follow-up jobs and event.
    const item = rig.h.app.hearer.database.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.serverItemId, provisionalItemId(id)))
      .get();
    expect(item).toMatchObject({
      kind: 'track',
      mbRecordingId: IDS.recording,
      mbReleaseGroupId: IDS.releaseGroup,
      path: `${SERVER_MUSIC}/${EXPECTED}`,
    });
    expect(requestOf(requestId)).toMatchObject({ status: 'AVAILABLE', fulfilledByUploadId: id });
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ uploadId: id, libraryPath: dest });
    expect(row?.matchJson).toMatchObject({ import: { libraryPath: dest } });
  });

  it('keeps going when the media server rescan fails', async () => {
    rig = await startImportRig();
    rig.jellyfin.behavior.forceStatus = 500;
    const id = await seedApproved(rig);
    await run(id);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
  });

  it('imports without a cover when the archive has none, and when the tags say embedded', async () => {
    rig = await startImportRig();
    rig.caa.missing = true;
    const a = await seedApproved(rig);
    await run(a);
    const first = await parseFile(join(rig.musicDir, EXPECTED));
    expect(first.common.picture).toBeUndefined();
    expect(rowOf(rig, a)?.status).toBe('IMPORTED');

    rig.caa.missing = false;
    rig.caa.requests.length = 0;
    const b = await seedApproved(rig, {
      tags: { title: 'Airbag', trackNumber: 1, coverSource: { type: 'embedded' } },
    });
    await run(b);
    expect(rig.caa.requests).toEqual([]);
    expect(rowOf(rig, b)?.status).toBe('IMPORTED');
  });

  it('scales a large cover down to 1200 px', async () => {
    rig = await startImportRig();
    rig.caa.image = makeJpeg(rig.audioDir, 'huge.jpg', '2400x1800');
    const id = await seedApproved(rig);
    await run(id);
    const { common } = await parseFile(join(rig.musicDir, EXPECTED));
    const picture = common.picture?.[0];
    expect(picture).toBeDefined();
    const { imageSize } = await import('../src/lib/tagger.ts');
    expect(imageSize(Buffer.from(picture?.data ?? []))).toEqual({ width: 1200, height: 900 });
  });

  it('uses the singles template for a Single release group', async () => {
    rig = await startImportRig();
    rig.mb.override = (req) => {
      if (req.path === `release-group/${IDS.releaseGroup}`) {
        const base = JSON.parse(
          readFileSync(
            join(import.meta.dirname, 'fixtures/musicbrainz/release-group.json'),
            'utf8',
          ),
        ) as Record<string, unknown>;
        return { body: JSON.stringify({ ...base, 'primary-type': 'Single' }) };
      }
      return undefined;
    };
    const id = await seedApproved(rig);
    await run(id);
    expect(listFiles(rig.musicDir)).toEqual(['Radiohead/Singles/Paranoid Android.mp3']);
  });

  it('applies the umask to new files and directories', async () => {
    rig = await startImportRig({ umask: 0o027 });
    const id = await seedApproved(rig);
    await run(id);
    const file = join(rig.musicDir, EXPECTED);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o750);
    expect(statSync(join(rig.musicDir, 'Radiohead')).mode & 0o777).toBe(0o750);
  });
});

describe('upload.import: album requests', () => {
  it('marks an album request PARTIALLY_AVAILABLE, then AVAILABLE once every track is there', async () => {
    rig = await startImportRig();
    const albumRequest = insertRequest({
      type: 'album',
      mbid: IDS.releaseGroup,
      title: 'OK Computer',
    });
    const first = await seedApproved(rig, { targetRequestId: albumRequest });
    await run(first);
    expect(requestOf(albumRequest)?.status).toBe('PARTIALLY_AVAILABLE');

    // The other eleven tracks arrive (as a library sync would index them).
    seedOtherTracks(rig, IDS.recording);
    const second = await seedApproved(rig, {
      targetRequestId: albumRequest,
      tags: { title: 'Airbag', trackNumber: 1, mbRecordingId: FIXTURE_TRACKS[0] ?? '' },
    });
    await run(second);
    expect(requestOf(albumRequest)).toMatchObject({
      status: 'AVAILABLE',
      fulfilledByUploadId: second,
    });
    const timeline = rig.h.app.hearer.database.db
      .select()
      .from(requestEvents)
      .where(eq(requestEvents.requestId, albumRequest))
      .all();
    expect(timeline.map((e) => e.toStatus).filter(Boolean)).toEqual([
      'PARTIALLY_AVAILABLE',
      'AVAILABLE',
    ]);
  });

  it('leaves a request that can no longer be fulfilled alone', async () => {
    rig = await startImportRig();
    const requestId = insertRequest({ status: 'CANCELLED' });
    const id = await seedApproved(rig, { targetRequestId: requestId });
    await run(id);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
    expect(requestOf(requestId)?.status).toBe('CANCELLED');
  });
});

describe('upload.import: names and collisions', () => {
  it('never overwrites a different file: the next free name is used', async () => {
    rig = await startImportRig();
    const dir = join(rig.musicDir, dirname(EXPECTED));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(rig.musicDir, EXPECTED), 'somebody else');
    const id = await seedApproved(rig);
    await run(id);
    expect(readFileSync(join(rig.musicDir, EXPECTED), 'utf8')).toBe('somebody else');
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED.replace('.mp3', ' (2).mp3'), EXPECTED]);
    expect(rowOf(rig, id)?.libraryPath?.endsWith('(2).mp3')).toBe(true);
  });

  it('picks another name when a different file appears just before the move', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    rig.hook.current = (point) => {
      if (point === 'state-saved') {
        mkdirSync(join(rig.musicDir, dirname(EXPECTED)), { recursive: true });
        writeFileSync(join(rig.musicDir, EXPECTED), 'late arrival');
      }
    };
    await run(id);
    expect(readFileSync(join(rig.musicDir, EXPECTED), 'utf8')).toBe('late arrival');
    expect(listFiles(rig.musicDir)).toHaveLength(2);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
    expect(rowOf(rig, id)?.libraryPath?.endsWith('(2).mp3')).toBe(true);
  });

  it('treats identical content at the destination as already imported', async () => {
    rig = await startImportRig();
    const first = await seedApproved(rig, { frequency: 440 });
    await run(first);
    const before = await sha256File(join(rig.musicDir, EXPECTED));
    // Re-import the very same staged bytes as a second upload (same tags, same cover).
    const original = rowOf(rig, first);
    expect(original?.status).toBe('IMPORTED');
    const second = await seedApproved(rig, { frequency: 440 });
    await run(second);
    // The tagged result is byte-identical, so nothing new is filed.
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
    expect(await sha256File(join(rig.musicDir, EXPECTED))).toBe(before);
    expect(rowOf(rig, second)?.libraryPath).toBe(rowOf(rig, first)?.libraryPath);
    expect(rowOf(rig, second)?.status).toBe('IMPORTED');
  });
});

describe('upload.import: hostile tags (acceptance 7)', () => {
  const evil = [
    { title: '../../../../etc/passwd' },
    { title: '..\\..\\boot.ini', album: '../../..', artist: '../..', albumArtist: '../..' },
    { title: 'CON', album: 'NUL', albumArtist: 'AUX', artist: 'AUX' },
    { title: '/absolute/path', album: '/etc', albumArtist: '/root' },
    { title: '．．／．．／etc／passwd', album: '．．' },
  ];
  evil.forEach((patch, i) => {
    it(`case ${String(i + 1)} never escapes MUSIC_DIR`, async () => {
      rig = await startImportRig();
      const id = await seedApproved(rig, { tags: patch });
      await run(id);
      const row = rowOf(rig, id);
      expect(row?.status).toBe('IMPORTED');
      const root = realpathSync(rig.musicDir);
      const landed = realpathSync(row?.libraryPath ?? '/nonexistent');
      expect(relative(root, landed).startsWith('..')).toBe(false);
      expect(landed.startsWith(`${root}/`)).toBe(true);
      // Nothing was written anywhere else under the test root.
      const outside = [...listFiles(dirname(root)).filter((f) => !f.startsWith('music/'))].filter(
        (f) => !f.startsWith('staging/') && !f.startsWith('data/'),
      );
      expect(outside).toEqual([]);
      expect(listFiles(rig.musicDir)).toHaveLength(1);
    });
  });
});

describe('upload.import: failures', () => {
  it('fails permanently on unusable tags and keeps the staged file', async () => {
    rig = await startImportRig();
    const failures: UploadEventPayload[] = [];
    rig.h.app.hearer.events.on('upload.failed', (p) => {
      failures.push(p);
    });
    const id = await seedApproved(rig);
    rig.h.app.hearer.database.db
      .update(uploads)
      .set({ chosenJson: { title: 'only a title' } })
      .where(eq(uploads.id, id))
      .run();
    await expect(run(id)).rejects.toBeInstanceOf(ImportPermanentError);
    const row = rowOf(rig, id);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toMatch(/valid tags/u);
    expect(existsSync(row?.stagingPath ?? '')).toBe(true);
    expect(listFiles(rig.musicDir)).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('fails permanently when the staged file is gone', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    const row = rowOf(rig, id);
    writeFileSync(row?.stagingPath ?? '', '');
    await import('node:fs/promises').then((fs) => fs.rm(row?.stagingPath ?? '', { force: true }));
    await expect(run(id)).rejects.toBeInstanceOf(ImportPermanentError);
    expect(rowOf(rig, id)?.status).toBe('FAILED');
    expect(rowOf(rig, id)?.error).toMatch(/staged file is gone/u);
  });

  it('fails permanently when the file cannot take tags', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    const path = rowOf(rig, id)?.stagingPath ?? '';
    writeFileSync(path, Buffer.from('this is not an mp3 at all'));
    await expect(run(id)).rejects.toBeInstanceOf(ImportPermanentError);
    expect(rowOf(rig, id)?.status).toBe('FAILED');
    expect(existsSync(path)).toBe(true);
  });

  it('retries transient errors and fails on the last attempt', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    rig.hook.current = (point) => {
      if (point === 'tags-written') throw new Error('disk hiccup');
    };
    await expect(run(id, { attempt: 1, maxAttempts: 2 })).rejects.toThrow('disk hiccup');
    expect(rowOf(rig, id)?.status).toBe('IMPORTING');
    await expect(run(id, { attempt: 2, maxAttempts: 2 })).rejects.toThrow('disk hiccup');
    expect(rowOf(rig, id)).toMatchObject({ status: 'FAILED', error: 'disk hiccup' });
    expect(existsSync(stagingOf(id))).toBe(true);
  });

  it('does nothing for uploads that are not approved, and for unknown ids', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    rig.h.app.hearer.database.db
      .update(uploads)
      .set({ status: 'REJECTED' })
      .where(eq(uploads.id, id))
      .run();
    await run(id);
    await run(randomUUID());
    expect(rowOf(rig, id)?.status).toBe('REJECTED');
    expect(listFiles(rig.musicDir)).toEqual([]);
  });

  it('retry-import: managers only, FAILED only, then the import completes', async () => {
    rig = await startImportRig({ startJobs: true });
    const id = await seedApproved(rig);
    const db = rig.h.app.hearer.database.db;
    db.update(uploads).set({ status: 'FAILED', error: 'it broke' }).where(eq(uploads.id, id)).run();
    const post = (creds: typeof rig.alice, uploadId: string) =>
      rig.h.app.inject({
        method: 'POST',
        url: `/api/v1/uploads/${uploadId}/retry-import`,
        headers: authHeaders(creds),
      });
    expect((await post(rig.alice, id)).statusCode).toBe(403);
    expect((await post(rig.manager, randomUUID())).statusCode).toBe(404);
    const res = await post(rig.manager, id);
    expect(res.statusCode).toBe(200);
    // The job runner picks the import up and finishes it.
    await waitFor(() => rowOf(rig, id)?.status === 'IMPORTED');
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
    // Not failed any more: a second retry is refused.
    expect((await post(rig.manager, id)).statusCode).toBe(409);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- crash recovery (acceptance 8) -----------------------------------------------------------

const COMMON_POINTS: ImportPoint[] = [
  'started',
  'work-copied',
  'tags-written',
  'state-saved',
  'move:dirs-created',
  'move:renamed',
  'moved',
  'verified',
  'announce:library-item',
  'announce:rescan',
  'announce:sync-scheduled',
  'announce:request',
  'announce:availability',
  'imported',
  'cleaned',
];
const EXDEV_POINTS: ImportPoint[] = [
  'move:dirs-created',
  'move:tmp-written',
  'move:tmp-verified',
  'move:renamed',
  'moved',
  'verified',
];

async function crashAndRecover(point: ImportPoint, viaCopy: boolean): Promise<void> {
  rig = await startImportRig();
  if (viaCopy) exdev();
  const imported: UploadEventPayload[] = [];
  rig.h.app.hearer.events.on('upload.imported', (p) => {
    imported.push(p);
  });
  const requestId = insertRequest({});
  const id = await seedApproved(rig, { targetRequestId: requestId });
  const original = rowOf(rig, id)?.stagingPath ?? '';
  const originalSha = await sha256File(original);

  crashOnce(point);
  await expect(run(id)).rejects.toThrow(`simulated crash at ${point}`);

  // The crash never lost the staged original before the destination was verified.
  const after = rowOf(rig, id);
  if (point !== 'cleaned') {
    expect(existsSync(original)).toBe(true);
    expect(await sha256File(original)).toBe(originalSha);
  }
  expect(after?.status).toBe(
    point === 'imported' || point === 'cleaned' ? 'IMPORTED' : 'IMPORTING',
  );
  // No half-written final file: whatever sits at a final name is complete and tagged.
  for (const file of listFiles(rig.musicDir)) {
    if (file.split('/').at(-1)?.startsWith('.hearer-tmp-')) continue;
    expect((await parseFile(join(rig.musicDir, file))).common.title).toBe('Paranoid Android');
  }

  // Run again (no more crashes): it completes without duplicates.
  rig.hook.current = undefined;
  await run(id);
  const row = rowOf(rig, id);
  expect(row?.status).toBe('IMPORTED');
  const files = listFiles(rig.musicDir).filter((f) => !f.includes('.hearer-tmp-'));
  expect(files).toEqual([EXPECTED]);
  expect(existsSync(stagingOf(id))).toBe(false);
  const { common } = await parseFile(join(rig.musicDir, EXPECTED));
  expect(common.musicbrainz_recordingid).toBe(IDS.recording);
  expect(common.picture).toHaveLength(1);
  expect(imported).toHaveLength(1);
  expect(requestOf(requestId)).toMatchObject({ status: 'AVAILABLE', fulfilledByUploadId: id });
  const toAvailable = rig.h.app.hearer.database.db
    .select()
    .from(requestEvents)
    .where(eq(requestEvents.requestId, requestId))
    .all()
    .filter((e) => e.toStatus === 'AVAILABLE');
  expect(toAvailable).toHaveLength(1);
  expect(
    rig.h.app.hearer.database.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.serverItemId, provisionalItemId(id)))
      .all(),
  ).toHaveLength(1);
  // The server was told at least once, never about another path.
  for (const update of mediaUpdates()) {
    expect(update.body).toEqual({
      Updates: [{ Path: `${SERVER_MUSIC}/${EXPECTED}`, UpdateType: 'Created' }],
    });
  }
}

describe('upload.import: crash at any step, then run again (rename)', () => {
  for (const point of COMMON_POINTS) {
    it(`recovers from a crash at ${point}`, async () => {
      await crashAndRecover(point, false);
    }, 30_000);
  }
});

describe('upload.import: crash at any step, then run again (cross-filesystem copy)', () => {
  for (const point of EXDEV_POINTS) {
    it(`recovers from a crash at ${point}`, async () => {
      await crashAndRecover(point, true);
    }, 30_000);
  }

  it('copies across filesystems when rename says EXDEV and leaves no temp file behind', async () => {
    rig = await startImportRig();
    exdev();
    const id = await seedApproved(rig);
    await run(id);
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
  });
});

describe('upload.import: crashes with a changed world', () => {
  it('rebuilds the work file when it was damaged by the crash', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    crashOnce('state-saved');
    await expect(run(id)).rejects.toThrow();
    const work = join(stagingOf(id), '.work-track.mp3');
    expect(existsSync(work)).toBe(true);
    writeFileSync(work, 'truncated garbage');
    rig.hook.current = undefined;
    await run(id);
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
    expect((await parseFile(join(rig.musicDir, EXPECTED))).common.title).toBe('Paranoid Android');
  });

  it('finishes a half-done import whose staged original is gone but whose library file verified', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    crashOnce('moved');
    await expect(run(id)).rejects.toThrow();
    const row = rowOf(rig, id);
    await import('node:fs/promises').then((fs) => fs.rm(row?.stagingPath ?? '', { force: true }));
    rig.hook.current = undefined;
    await run(id);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
    expect(listFiles(rig.musicDir)).toEqual([EXPECTED]);
  });

  it('keeps the staging folder when the library copy no longer verifies', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    rig.hook.current = (point) => {
      if (point === 'imported') {
        writeFileSync(join(rig.musicDir, EXPECTED), 'corrupted by something else');
      }
    };
    await expect(run(id)).rejects.toThrow(/vanished|does not match|verif/iu);
    expect(existsSync(stagingOf(id))).toBe(true);
  });

  it('an IMPORTED upload only needs its cleanup finished', async () => {
    rig = await startImportRig();
    const id = await seedApproved(rig);
    crashOnce('cleaned');
    await expect(run(id)).rejects.toThrow();
    rig.hook.current = undefined;
    await run(id);
    await run(id);
    expect(rowOf(rig, id)?.status).toBe('IMPORTED');
    expect(mediaUpdates()).toHaveLength(1);
  });
});
