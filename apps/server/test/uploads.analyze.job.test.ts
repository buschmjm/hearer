import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { matchResultSchema, tagSetSchema, type MatchResult } from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryItems, uploads } from '../src/db/schema.ts';
import { normKey } from '../src/lib/normalize.ts';
import { acoustIdOk } from './helpers/acoustIdServer.ts';
import {
  SUBTERRANEAN,
  installMb,
  makeAudio,
  rowOf,
  seedUpload,
  settled,
  startRig,
  type Rig,
} from './helpers/analyze.ts';
import { IDS } from './helpers/mbServer.ts';
import { waitFor } from './helpers/uploads.ts';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const matchOf = (id: string): MatchResult => {
  const row = rowOf(rig, id);
  return matchResultSchema.parse(row?.matchJson);
};

const noAcoustIdKey = (r: Rig) => {
  const { settings } = r.h.app.hearer;
  settings.set('metadata', { ...settings.get('metadata'), acoustIdApiKey: '' });
};

const TAGS = {
  title: 'Paranoid Android',
  artist: 'Radiohead',
  album: 'OK Computer',
  track: '2/12',
};

describe('upload.analyze: identification', () => {
  it('identifies an untagged file through AcoustID and proposes the OK Computer release', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'untagged.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    const row = await settled(rig, id);

    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.fingerprint).toBeTruthy();
    const match = matchOf(id);
    expect(match.acoustId.status).toBe('matched');
    const top = match.candidates[0];
    expect(top).toMatchObject({
      recordingMbid: IDS.recording,
      releaseGroupMbid: IDS.releaseGroup,
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      trackNumber: 2,
      discNumber: 1,
      sources: expect.arrayContaining(['acoustid']) as string[],
    });
    expect(top?.score).toBeGreaterThan(0.9);
    expect(top?.breakdown.acoustId).toBe(0.98);
    // The proposed tags are a complete, valid TagSet.
    const chosen = tagSetSchema.parse(row.chosenJson);
    expect(chosen).toMatchObject({
      mbRecordingId: IDS.recording,
      mbReleaseGroupId: IDS.releaseGroup,
      mbArtistId: IDS.artist,
      acoustId: 'acoustid-track-1',
      trackNumber: 2,
      trackTotal: 12,
      date: '1997-05-21',
      coverSource: { type: 'caa', releaseMbid: top?.releaseMbid },
    });
    expect(match.chosenCandidateId).toBe(top?.id);
    // Not auto-approved: alice has no AUTO_APPROVE_UPLOAD.
    expect(match.autoApproved).toBe(false);
    // The AcoustID request carried the fingerprint we stored.
    expect(rig.acoust.requests[0]?.params.get('fingerprint')).toBe(row.fingerprint);
  });

  it('finds a tagged file by tag search when no AcoustID key is set', async () => {
    rig = await startRig();
    noAcoustIdKey(rig);
    installMb(rig.mb, { search: [IDS.recording] });
    const file = makeAudio(rig.audioDir, 'tagged.mp3', { seconds: 30, tags: TAGS });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 'tagged.mp3',
    });
    const row = await settled(rig, id);

    expect(row.status).toBe('NEEDS_REVIEW');
    expect(rig.acoust.requests).toHaveLength(0);
    const match = matchOf(id);
    expect(match.acoustId.status).toBe('disabled');
    expect(match.existingTags).toMatchObject({ title: 'Paranoid Android', trackNumber: 2 });
    const top = match.candidates[0];
    expect(top?.recordingMbid).toBe(IDS.recording);
    expect(top?.sources).toEqual(['tags']);
    expect(top?.breakdown.acoustId).toBeNull();
    // Tags-only evidence tops out below the fingerprint ceiling.
    expect(top?.score).toBeLessThanOrEqual(0.95);
    expect(top?.score).toBeGreaterThan(0.9);
    expect(row.chosenJson).toMatchObject({ title: 'Paranoid Android', genre: null });
  });

  it('keeps the genre and picture state of the file in the proposed tags', async () => {
    rig = await startRig();
    noAcoustIdKey(rig);
    installMb(rig.mb, { search: [IDS.recording] });
    const file = makeAudio(rig.audioDir, 'g.mp3', {
      seconds: 10,
      tags: { ...TAGS, genre: 'Art Rock', date: '1997' },
    });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 'g.mp3',
    });
    const row = await settled(rig, id);
    expect(row.chosenJson).toMatchObject({ genre: 'Art Rock' });
  });

  it('continues without a fingerprint when fpcalc is missing', async () => {
    rig = await startRig({
      deps: { deps: { uploadAnalyze: { fpcalcBinary: '/nonexistent/fpcalc' } } },
    });
    installMb(rig.mb, { search: [IDS.recording] });
    const file = makeAudio(rig.audioDir, 't.mp3', { seconds: 10, tags: TAGS });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 't.mp3',
    });
    const row = await settled(rig, id);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.fingerprint).toBeNull();
    expect(matchOf(id).acoustId.status).toBe('no_fingerprint');
    expect(matchOf(id).candidates[0]?.recordingMbid).toBe(IDS.recording);
    expect(rig.acoust.requests).toHaveLength(0);
  });

  it('proposes nothing when neither AcoustID nor tags identify the file', async () => {
    rig = await startRig();
    rig.acoust.respond = () => ({ body: { status: 'ok', results: [] } });
    const file = makeAudio(rig.audioDir, 'mystery.wav', { seconds: 5 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 5000 });
    const row = await settled(rig, id);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.chosenJson).toBeNull();
    expect(matchOf(id)).toMatchObject({
      candidates: [],
      acoustId: { status: 'no_match' },
    });
  });

  it('carries on when AcoustID rejects the key', async () => {
    rig = await startRig();
    installMb(rig.mb, { search: [IDS.recording] });
    rig.acoust.respond = () => ({
      status: 400,
      body: { status: 'error', error: { code: 4, message: 'invalid API key' } },
    });
    const file = makeAudio(rig.audioDir, 'k.mp3', { seconds: 10, tags: TAGS });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 'k.mp3',
    });
    const row = await settled(rig, id);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(matchOf(id).acoustId).toMatchObject({ status: 'error' });
    expect(matchOf(id).acoustId.message).toContain('invalid API key');
    expect(matchOf(id).candidates[0]?.recordingMbid).toBe(IDS.recording);
  });
});

describe('upload.analyze: auto-approve', () => {
  it('approves and queues the import when the uploader may and the score is high enough', async () => {
    rig = await startRig({ withImportJob: true });
    const file = makeAudio(rig.audioDir, 'auto.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.trustedId, file, durationMs: 384_000 });
    await waitFor(() => rowOf(rig, id)?.status === 'APPROVED' && rig.imports.includes(id));
    expect(matchOf(id).autoApproved).toBe(true);
    expect(matchOf(id).candidates[0]?.score).toBeGreaterThanOrEqual(0.9);
  });

  it('approves without an import job registered (H-15 not merged): it waits in APPROVED', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'auto2.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.trustedId, file, durationMs: 384_000 });
    await waitFor(() => rowOf(rig, id)?.status === 'APPROVED');
    expect(rig.imports).toEqual([]);
  });

  it('keeps the upload for review when the score is below the threshold', async () => {
    rig = await startRig({ withImportJob: true });
    rig.h.app.hearer.settings.set('uploads', { autoApproveThreshold: 0.999 });
    const file = makeAudio(rig.audioDir, 'low.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.trustedId, file, durationMs: 384_000 });
    const row = await settled(rig, id);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(rig.imports).toEqual([]);
  });

  it('does not auto-approve a user without AUTO_APPROVE_UPLOAD even at a perfect score', async () => {
    rig = await startRig({ withImportJob: true });
    const file = makeAudio(rig.audioDir, 'noauto.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    expect((await settled(rig, id)).status).toBe('NEEDS_REVIEW');
  });

  it('never auto-approves a file with no proposal', async () => {
    rig = await startRig({ withImportJob: true });
    rig.acoust.respond = () => ({ body: { status: 'ok', results: [] } });
    const file = makeAudio(rig.audioDir, 'none.wav', { seconds: 5 });
    const id = await seedUpload(rig, { uploaderId: rig.trustedId, file, durationMs: 5000 });
    expect((await settled(rig, id)).status).toBe('NEEDS_REVIEW');
  });
});

describe('upload.analyze: duplicates', () => {
  it('(a) flags the same sha256 as an imported upload', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'dup.wav', { seconds: 20 });
    const first = await seedUpload(rig, {
      uploaderId: rig.bobId,
      file,
      durationMs: 20_000,
      status: 'IMPORTED',
    });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 20_000 });
    const row = await settled(rig, id);
    expect(row.status).toBe('DUPLICATE');
    expect(row.error).toContain('already been imported');
    expect(matchOf(id).duplicate).toMatchObject({ kind: 'sha256', uploadId: first });
    // Nothing was fingerprinted or looked up.
    expect(rig.acoust.requests).toHaveLength(0);
    expect(rig.mb.requests).toHaveLength(0);
  });

  it('(a) flags a file already in flight as another upload, but not the earlier one itself', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'twin.wav', { seconds: 20 });
    const earlier = new Date(Date.now() - 60_000);
    const first = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 20_000,
      createdAt: earlier,
    });
    const second = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 20_000 });
    expect((await settled(rig, second)).status).toBe('DUPLICATE');
    expect((await settled(rig, first)).status).toBe('NEEDS_REVIEW');
  });

  it('(a) ignores rejected and failed uploads with the same bytes', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'old.wav', { seconds: 20 });
    await seedUpload(rig, {
      uploaderId: rig.bobId,
      file,
      durationMs: 20_000,
      status: 'REJECTED',
    });
    await seedUpload(rig, { uploaderId: rig.bobId, file, durationMs: 20_000, status: 'FAILED' });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 20_000 });
    expect((await settled(rig, id)).status).toBe('NEEDS_REVIEW');
  });

  it('(b) flags a recording that is already in the library', async () => {
    rig = await startRig();
    rig.h.app.hearer.database.db
      .insert(libraryItems)
      .values({
        serverItemId: 'jf-1',
        kind: 'track',
        name: 'Paranoid Android',
        mbRecordingId: IDS.recording,
      })
      .run();
    const file = makeAudio(rig.audioDir, 'lib.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    const row = await settled(rig, id);
    expect(row.status).toBe('DUPLICATE');
    expect(matchOf(id).duplicate).toMatchObject({ kind: 'recording', libraryItemId: 'jf-1' });
    // The proposal is kept so a reviewer who overrides has something to start from.
    expect(matchOf(id).candidates[0]?.recordingMbid).toBe(IDS.recording);
  });

  const addFuzzy = (durationMs: number | null) =>
    rig.h.app.hearer.database.db
      .insert(libraryItems)
      .values({
        serverItemId: 'jf-2',
        kind: 'track',
        name: 'Paranoid Android (Remastered)',
        artistName: 'Radiohead',
        durationMs,
        normKey: normKey('Radiohead', 'Paranoid Android'),
      })
      .run();

  it('(c) flags a fuzzy artist|title match within 3 seconds', async () => {
    rig = await startRig();
    addFuzzy(385_500);
    const file = makeAudio(rig.audioDir, 'fz.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    const row = await settled(rig, id);
    expect(row.status).toBe('DUPLICATE');
    expect(matchOf(id).duplicate?.kind).toBe('fuzzy');
  });

  it('(c) lets a same-named track of a clearly different length through', async () => {
    rig = await startRig();
    addFuzzy(420_000);
    const file = makeAudio(rig.audioDir, 'fz2.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    expect((await settled(rig, id)).status).toBe('NEEDS_REVIEW');
  });

  it('does not auto-approve a duplicate, even for a trusted uploader', async () => {
    rig = await startRig({ withImportJob: true });
    rig.h.app.hearer.database.db
      .insert(libraryItems)
      .values({ serverItemId: 'jf-1', kind: 'track', name: 'x', mbRecordingId: IDS.recording })
      .run();
    const file = makeAudio(rig.audioDir, 'dup-auto.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.trustedId, file, durationMs: 384_000 });
    expect((await settled(rig, id)).status).toBe('DUPLICATE');
    expect(rig.imports).toEqual([]);
  });

  it('keeps a "kept" verdict when the upload is analysed again', async () => {
    rig = await startRig();
    rig.h.app.hearer.database.db
      .insert(libraryItems)
      .values({ serverItemId: 'jf-1', kind: 'track', name: 'x', mbRecordingId: IDS.recording })
      .run();
    const file = makeAudio(rig.audioDir, 'again.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    await settled(rig, id);
    const res = await rig.h.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${id}/keep`,
      headers: { cookie: rig.manager.cookie, 'x-csrf-token': rig.manager.csrf },
      payload: { reason: 'live version' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(rowOf(rig, id)?.status).toBe('NEEDS_REVIEW');
    rig.h.app.hearer.database.db
      .update(uploads)
      .set({ status: 'RECEIVED' })
      .where(eq(uploads.id, id))
      .run();
    rig.h.app.hearer.jobs.enqueue('upload.analyze', { uploadId: id }, { uniqueKey: `a:${id}` });
    await waitFor(() => rowOf(rig, id)?.status === 'NEEDS_REVIEW' && matchOf(id).kept !== null);
    expect(matchOf(id).kept).toMatchObject({ by: rig.managerId, reason: 'live version' });
  });
});

describe('upload.analyze: failure handling', () => {
  const ctx = (attempt: number, rigRef: Rig) => ({
    jobId: 1,
    attempt,
    signal: new AbortController().signal,
    log: rigRef.h.app.log,
    db: rigRef.h.app.hearer.database.db,
    enqueue: () => 1,
  });

  it('retries when MusicBrainz is unavailable, and fails on the last attempt', async () => {
    rig = await startRig({ startJobs: false });
    installMb(rig.mb, { search: [IDS.recording] });
    const prev = rig.mb.override;
    rig.mb.override = (req) =>
      req.path.startsWith('recording') ? { status: 503, body: '{}' } : prev?.(req);
    const file = makeAudio(rig.audioDir, 'f.mp3', { seconds: 10, tags: TAGS });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 'f.mp3',
      noEnqueue: true,
    });
    const def = rig.h.app.hearer.jobs.registry.get('upload.analyze');
    if (!def) throw new Error('job not registered');

    await expect(def.handler({ uploadId: id }, ctx(1, rig))).rejects.toThrow();
    expect(rowOf(rig, id)?.status).toBe('ANALYZING');
    await def.handler({ uploadId: id }, ctx(3, rig));
    const row = rowOf(rig, id);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toMatch(/Analysis failed/u);
  });

  it('degrades to tag matching when AcoustID is down on the final attempt', async () => {
    rig = await startRig({ startJobs: false });
    installMb(rig.mb, { search: [IDS.recording] });
    rig.acoust.respond = () => ({ status: 503, body: 'down' });
    const file = makeAudio(rig.audioDir, 'd.mp3', { seconds: 10, tags: TAGS });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 384_000,
      originalName: 'd.mp3',
      noEnqueue: true,
    });
    const def = rig.h.app.hearer.jobs.registry.get('upload.analyze');
    if (!def) throw new Error('job not registered');
    await expect(def.handler({ uploadId: id }, ctx(1, rig))).rejects.toThrow(/AcoustID/u);
    await def.handler({ uploadId: id }, ctx(3, rig));
    expect(rowOf(rig, id)?.status).toBe('NEEDS_REVIEW');
    expect(matchOf(id).acoustId.status).toBe('error');
  });

  it('fails an upload whose staged file vanished', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'gone.wav', { seconds: 5 });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 5000,
      noEnqueue: true,
    });
    const staged = rowOf(rig, id)?.stagingPath ?? '';
    expect(existsSync(staged)).toBe(true);
    await rig.h.app.hearer.uploads.removeFiles({ id, tusId: null });
    rig.h.app.hearer.jobs.enqueue('upload.analyze', { uploadId: id });
    const row = await settled(rig, id);
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('staged file is missing');
  });

  it('ignores an upload that is not waiting for analysis', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'ign.wav', { seconds: 5 });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 5000,
      status: 'NEEDS_REVIEW',
    });
    rig.h.app.hearer.jobs.enqueue('upload.analyze', { uploadId: id });
    rig.h.app.hearer.jobs.enqueue('upload.analyze', { uploadId: randomUUID() });
    await rig.h.app.hearer.jobs.drain();
    expect(rowOf(rig, id)?.status).toBe('NEEDS_REVIEW');
    expect(rig.acoust.requests).toHaveLength(0);
  });
});

describe('upload.analyze: batches', () => {
  it('waits for the whole batch, groups the album and then settles auto-approval', async () => {
    rig = await startRig({ withImportJob: true });
    installMb(rig.mb, {
      recordings: { [SUBTERRANEAN]: { title: 'Subterranean Homesick Alien', length: 267_706 } },
    });
    // The fingerprint lookup answers by the file's duration.
    rig.acoust.respond = (req) => {
      const duration = Number(req.params.get('duration'));
      return duration > 300
        ? { body: acoustIdOk([{ id: IDS.recording, rg: IDS.releaseGroup }]) }
        : {
            body: acoustIdOk([
              {
                id: SUBTERRANEAN,
                title: 'Subterranean Homesick Alien',
                duration: 268,
                rg: IDS.releaseGroup,
              },
            ]),
          };
    };
    const batchId = randomUUID();
    const a = makeAudio(rig.audioDir, 'a.wav', { seconds: 384, frequency: 440 });
    const b = makeAudio(rig.audioDir, 'b.wav', { seconds: 268, frequency: 660 });
    const idA = await seedUpload(rig, {
      uploaderId: rig.trustedId,
      file: a,
      durationMs: 384_000,
      batchId,
      originalName: 'a.wav',
    });
    const idB = await seedUpload(rig, {
      uploaderId: rig.trustedId,
      file: b,
      durationMs: 267_700,
      batchId,
      originalName: 'b.wav',
    });
    await waitFor(
      () =>
        rowOf(rig, idA)?.status === 'APPROVED' &&
        rowOf(rig, idB)?.status === 'APPROVED' &&
        rig.imports.length === 2,
    );
    const ma = matchOf(idA);
    const mb = matchOf(idB);
    expect(ma.group).not.toBeNull();
    expect(mb.group).toEqual(ma.group);
    expect(ma.group).toMatchObject({ releaseGroupMbid: IDS.releaseGroup, trackTotal: 12 });
    expect(ma.group?.tracks.map((t) => [t.recordingMbid, t.trackNumber]).sort()).toEqual(
      [
        [IDS.recording, 2],
        [SUBTERRANEAN, 3],
      ].sort(),
    );
    expect(ma.candidates[0]?.releaseMbid).toBe(mb.candidates[0]?.releaseMbid);
    expect(ma.candidates[0]?.trackNumber).toBe(2);
    expect(mb.candidates[0]?.trackNumber).toBe(3);
  });

  it('holds a batch member for review until its siblings have been analysed', async () => {
    rig = await startRig({ withImportJob: true });
    const batchId = randomUUID();
    const a = makeAudio(rig.audioDir, 'a2.wav', { seconds: 384 });
    // The sibling is still being received.
    await seedUpload(rig, {
      uploaderId: rig.trustedId,
      file: a,
      durationMs: 384_000,
      batchId,
      status: 'RECEIVING',
      sha256: 'x'.repeat(64),
    });
    const id = await seedUpload(rig, {
      uploaderId: rig.trustedId,
      file: a,
      durationMs: 384_000,
      batchId,
      originalName: 'a2.wav',
    });
    const row = await settled(rig, id);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(matchOf(id).notified).toBe(false);
    expect(rig.imports).toEqual([]);
  });

  it('leaves a single-file batch alone (no group) and still auto-approves it', async () => {
    rig = await startRig({ withImportJob: true });
    const batchId = randomUUID();
    const a = makeAudio(rig.audioDir, 'solo.wav', { seconds: 384 });
    const id = await seedUpload(rig, {
      uploaderId: rig.trustedId,
      file: a,
      durationMs: 384_000,
      batchId,
    });
    await waitFor(() => rowOf(rig, id)?.status === 'APPROVED');
    expect(matchOf(id).group).toBeNull();
  });
});
