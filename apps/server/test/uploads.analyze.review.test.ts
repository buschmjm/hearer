import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  Permission,
  type MatchCandidate,
  type MatchResult,
  type TagSet,
  type UploadDetail,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requests, uploads } from '../src/db/schema.ts';
import { call, addUser, login, type Credentials } from './helpers/auth.ts';
import { makeAudio, rowOf, seedUpload, settled, startRig, type Rig } from './helpers/analyze.ts';
import { IDS } from './helpers/mbServer.ts';
import { waitFor } from './helpers/uploads.ts';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const TAGS: TagSet = {
  title: 'Paranoid Android',
  artist: 'Radiohead',
  albumArtist: 'Radiohead',
  album: 'OK Computer',
  trackNumber: 2,
  trackTotal: 12,
  discNumber: 1,
  discTotal: 1,
  date: '1997-05-21',
  mbRecordingId: IDS.recording,
  mbReleaseId: IDS.release,
  mbReleaseGroupId: IDS.releaseGroup,
  mbArtistId: IDS.artist,
  mbAlbumArtistId: IDS.artist,
  coverSource: { type: 'caa', releaseMbid: IDS.release },
};

const CANDIDATE: MatchCandidate = {
  id: `${IDS.recording}@${IDS.release}`,
  recordingMbid: IDS.recording,
  releaseMbid: IDS.release,
  releaseGroupMbid: IDS.releaseGroup,
  releaseGroupMbids: [IDS.releaseGroup],
  title: 'Paranoid Android',
  artist: 'Radiohead',
  album: 'OK Computer',
  date: '1997-05-21',
  trackNumber: 2,
  trackTotal: 12,
  discNumber: 1,
  discTotal: 1,
  lengthMs: 383_493,
  coverUrl: null,
  score: 0.8,
  breakdown: { acoustId: 0.8, title: null, artist: null, album: null, duration: 1, track: null },
  sources: ['acoustid'],
  tags: TAGS,
};

const MATCH: MatchResult = {
  version: 1,
  analyzedAt: new Date().toISOString(),
  durationMs: 383_000,
  existingTags: {
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    trackNumber: null,
    trackTotal: null,
    discNumber: null,
    discTotal: null,
    date: null,
    genre: null,
    isrc: null,
    mbRecordingId: null,
    mbReleaseId: null,
    hasPicture: false,
  },
  acoustId: { status: 'matched', message: null },
  candidates: [CANDIDATE],
  group: null,
  duplicate: null,
  kept: null,
  chosenCandidateId: CANDIDATE.id,
  autoApproved: false,
  reviewed: false,
  notified: true,
};

/** A NEEDS_REVIEW (or other) upload with a stored analysis. */
async function seedReviewable(
  uploaderId: string,
  extra: Partial<Parameters<typeof seedUpload>[1]> = {},
): Promise<string> {
  const file = makeAudio(rig.audioDir, `${randomUUID()}.wav`, { seconds: 2 });
  return seedUpload(rig, {
    uploaderId,
    file,
    durationMs: 2000,
    status: 'NEEDS_REVIEW',
    matchJson: MATCH,
    chosenJson: TAGS,
    ...extra,
  });
}

const api = (creds: Credentials, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  call(rig.h.app, creds, method, `/api/v1${url}`, payload);

function seedRequest(
  type: 'track' | 'album' | 'artist',
  mbid: string,
  status: (typeof requests.$inferInsert)['status'] = 'AWAITING_UPLOAD',
): string {
  const id = randomUUID();
  rig.h.app.hearer.database.db
    .insert(requests)
    .values({ id, type, mbid, title: 'x', status, requestedBy: rig.bobId })
    .run();
  return id;
}

describe('GET /uploads/:id', () => {
  it('returns candidates, the chosen tags, group info and canKeep', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const res = await api(rig.alice, 'GET', `/uploads/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<UploadDetail>();
    expect(body.status).toBe('NEEDS_REVIEW');
    expect(body.match?.candidates).toHaveLength(1);
    expect(body.match?.candidates[0]?.tags.mbRecordingId).toBe(IDS.recording);
    expect(body.match).toHaveProperty('group', null);
    expect(body.chosen).toMatchObject({ title: 'Paranoid Android' });
    expect(body.canKeep).toBe(false);
  });

  it('answers 404 to another uploader, 200 to a manager', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.bob, 'GET', `/uploads/${id}`)).statusCode).toBe(404);
    expect((await api(rig.manager, 'GET', `/uploads/${id}`)).statusCode).toBe(200);
  });

  it('shows null match and chosen before analysis', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'raw.wav', { seconds: 2 });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 2000,
      status: 'RECEIVING',
    });
    const body = (await api(rig.alice, 'GET', `/uploads/${id}`)).json<UploadDetail>();
    expect(body.match).toBeNull();
    expect(body.chosen).toBeNull();
  });
});

describe('PUT /uploads/:id/review', () => {
  it('stores edited tags, the candidate and the target request', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const requestId = seedRequest('track', IDS.recording);
    const edited = { ...TAGS, title: 'Paranoid Android (Edited)', genre: 'Rock' };
    const res = await api(rig.alice, 'PUT', `/uploads/${id}/review`, {
      tags: edited,
      candidateId: CANDIDATE.id,
      targetRequestId: requestId,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<UploadDetail>();
    expect(body.chosen).toMatchObject({ title: 'Paranoid Android (Edited)', genre: 'Rock' });
    expect(body.targetRequestId).toBe(requestId);
    expect(body.match).toMatchObject({ reviewed: true, chosenCandidateId: CANDIDATE.id });
    expect(rowOf(rig, id)?.chosenJson).toMatchObject({ genre: 'Rock' });
  });

  it('lets a manager review someone else’s upload and a user with only MANAGE_UPLOADS too', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const onlyManage = await addUser(rig.h.app, 'onlymanage', Permission.MANAGE_UPLOADS);
    expect(onlyManage).toBeTruthy();
    const creds = await login(rig.h.app, 'onlymanage');
    expect((await api(creds, 'PUT', `/uploads/${id}/review`, { tags: TAGS })).statusCode).toBe(200);
  });

  it('is invisible to other users (IDOR)', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const res = await api(rig.bob, 'PUT', `/uploads/${id}/review`, { tags: TAGS });
    expect(res.statusCode).toBe(404);
    expect(rowOf(rig, id)?.chosenJson).toEqual(TAGS);
  });

  it('validates the tags', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const bad: Record<string, unknown>[] = [
      { ...TAGS, title: '' },
      { ...TAGS, mbRecordingId: 'nope' },
      { ...TAGS, date: '97' },
      { ...TAGS, trackNumber: 0 },
      { ...TAGS, coverSource: { type: 'url', url: 'http://x' } },
      Object.fromEntries(Object.entries(TAGS).filter(([k]) => k !== 'mbReleaseId')),
    ];
    for (const tags of bad) {
      const res = await api(rig.alice, 'PUT', `/uploads/${id}/review`, { tags });
      expect(res.statusCode, JSON.stringify(tags)).toBe(400);
    }
  });

  it('lower-cases MusicBrainz ids', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const res = await api(rig.alice, 'PUT', `/uploads/${id}/review`, {
      tags: { ...TAGS, mbRecordingId: IDS.recording.toUpperCase() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UploadDetail>().chosen?.mbRecordingId).toBe(IDS.recording);
  });

  it('rejects an unknown candidate id', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const res = await api(rig.alice, 'PUT', `/uploads/${id}/review`, {
      tags: TAGS,
      candidateId: 'nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unknown_candidate');
  });

  it('only edits uploads waiting for review', async () => {
    rig = await startRig();
    for (const status of ['DUPLICATE', 'APPROVED', 'IMPORTED', 'REJECTED', 'RECEIVED'] as const) {
      const id = await seedReviewable(rig.aliceId, { status });
      const res = await api(rig.alice, 'PUT', `/uploads/${id}/review`, { tags: TAGS });
      expect(res.statusCode, status).toBe(409);
    }
  });

  describe('targetRequestId', () => {
    const put = async (targetRequestId: string | null, tags: TagSet = TAGS) => {
      const id = await seedReviewable(rig.aliceId);
      return api(rig.alice, 'PUT', `/uploads/${id}/review`, { tags, targetRequestId });
    };

    it('accepts a track request for this recording and an album request for this release group', async () => {
      rig = await startRig();
      expect((await put(seedRequest('track', IDS.recording))).statusCode).toBe(200);
      expect((await put(seedRequest('album', IDS.releaseGroup, 'PROCESSING'))).statusCode).toBe(
        200,
      );
      expect((await put(seedRequest('album', IDS.releaseGroup, 'APPROVED'))).statusCode).toBe(200);
    });

    it('rejects a request for a different recording or album', async () => {
      rig = await startRig();
      const track = await put(seedRequest('track', randomUUID()));
      expect(track.statusCode).toBe(400);
      expect(track.json<{ error: { code: string } }>().error.code).toBe('invalid_target_request');
      expect((await put(seedRequest('album', randomUUID()))).statusCode).toBe(400);
    });

    it('rejects requests that are not open, are artist requests, or do not exist', async () => {
      rig = await startRig();
      for (const status of ['PENDING', 'AVAILABLE', 'DECLINED', 'CANCELLED', 'FAILED'] as const) {
        expect((await put(seedRequest('track', IDS.recording, status))).statusCode, status).toBe(
          400,
        );
      }
      expect((await put(seedRequest('artist', IDS.artist))).statusCode).toBe(400);
      expect((await put(randomUUID())).statusCode).toBe(400);
      expect(
        (
          await api(rig.alice, 'PUT', `/uploads/${await seedReviewable(rig.aliceId)}/review`, {
            tags: TAGS,
            targetRequestId: 'not-a-uuid',
          })
        ).statusCode,
      ).toBe(400);
    });

    it('does not store anything when the target is refused', async () => {
      rig = await startRig();
      const id = await seedReviewable(rig.aliceId);
      await api(rig.alice, 'PUT', `/uploads/${id}/review`, {
        tags: { ...TAGS, title: 'Changed' },
        targetRequestId: seedRequest('track', randomUUID()),
      });
      expect(rowOf(rig, id)?.chosenJson).toMatchObject({ title: 'Paranoid Android' });
      expect(rowOf(rig, id)?.targetRequestId).toBeNull();
    });

    it('checks an existing target against edited tags, and null clears it', async () => {
      rig = await startRig();
      const requestId = seedRequest('track', IDS.recording);
      const id = await seedReviewable(rig.aliceId, { targetRequestId: requestId });
      const other = { ...TAGS, mbRecordingId: randomUUID() };
      expect(
        (await api(rig.alice, 'PUT', `/uploads/${id}/review`, { tags: other })).statusCode,
      ).toBe(400);
      const cleared = await api(rig.alice, 'PUT', `/uploads/${id}/review`, {
        tags: other,
        targetRequestId: null,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json<UploadDetail>().targetRequestId).toBeNull();
    });
  });
});

describe('POST /uploads/:id/approve', () => {
  it('lets the owner approve only with AUTO_APPROVE_UPLOAD', async () => {
    rig = await startRig({ withImportJob: true });
    const mine = await seedReviewable(rig.aliceId);
    expect((await api(rig.alice, 'POST', `/uploads/${mine}/approve`)).statusCode).toBe(403);
    expect(rowOf(rig, mine)?.status).toBe('NEEDS_REVIEW');

    const trusted = await seedReviewable(rig.trustedId);
    const res = await api(rig.trusted, 'POST', `/uploads/${trusted}/approve`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<UploadDetail>().status).toBe('APPROVED');
    await waitFor(() => rig.imports.includes(trusted));
  });

  it('lets a manager approve anyone’s upload', async () => {
    rig = await startRig({ withImportJob: true });
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.manager, 'POST', `/uploads/${id}/approve`)).statusCode).toBe(200);
    await waitFor(() => rig.imports.includes(id));
  });

  it('works without an import job registered (waits in APPROVED)', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.manager, 'POST', `/uploads/${id}/approve`)).statusCode).toBe(200);
    expect(rowOf(rig, id)?.status).toBe('APPROVED');
    expect(rig.imports).toEqual([]);
  });

  it('is 404 for other users, 409 without tags or in the wrong state', async () => {
    rig = await startRig({ withImportJob: true });
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.bob, 'POST', `/uploads/${id}/approve`)).statusCode).toBe(404);

    const untagged = await seedReviewable(rig.aliceId, { chosenJson: null });
    const res = await api(rig.manager, 'POST', `/uploads/${untagged}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('no_tags');

    const dup = await seedReviewable(rig.aliceId, { status: 'DUPLICATE' });
    expect((await api(rig.manager, 'POST', `/uploads/${dup}/approve`)).statusCode).toBe(409);

    await api(rig.manager, 'POST', `/uploads/${id}/approve`);
    expect((await api(rig.manager, 'POST', `/uploads/${id}/approve`)).statusCode).toBe(409);
    await waitFor(() => rig.imports.includes(id));
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.imports.filter((i) => i === id)).toHaveLength(1);
  });
});

describe('POST /uploads/:id/reject', () => {
  it('rejects, records the reason and deletes the staged file', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const staged = rowOf(rig, id)?.stagingPath ?? '';
    expect(existsSync(staged)).toBe(true);
    const res = await api(rig.alice, 'POST', `/uploads/${id}/reject`, { reason: 'wrong album' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<UploadDetail>()).toMatchObject({ status: 'REJECTED', error: 'wrong album' });
    expect(existsSync(staged)).toBe(false);
  });

  it('works for a manager, needs a reason, and keeps strangers out', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.alice, 'POST', `/uploads/${id}/reject`, {})).statusCode).toBe(400);
    expect(
      (await api(rig.alice, 'POST', `/uploads/${id}/reject`, { reason: '  ' })).statusCode,
    ).toBe(400);
    expect((await api(rig.bob, 'POST', `/uploads/${id}/reject`, { reason: 'x' })).statusCode).toBe(
      404,
    );
    expect(rowOf(rig, id)?.status).toBe('NEEDS_REVIEW');
    expect(
      (await api(rig.manager, 'POST', `/uploads/${id}/reject`, { reason: 'x' })).statusCode,
    ).toBe(200);
  });

  it('cannot reject what is imported or already rejected', async () => {
    rig = await startRig();
    const imported = await seedReviewable(rig.aliceId, { status: 'IMPORTED' });
    expect(
      (await api(rig.alice, 'POST', `/uploads/${imported}/reject`, { reason: 'x' })).statusCode,
    ).toBe(409);
    const id = await seedReviewable(rig.aliceId);
    await api(rig.alice, 'POST', `/uploads/${id}/reject`, { reason: 'x' });
    expect(
      (await api(rig.alice, 'POST', `/uploads/${id}/reject`, { reason: 'x' })).statusCode,
    ).toBe(409);
  });
});

describe('POST /uploads/:id/keep', () => {
  const duplicate = (uploaderId: string) =>
    seedReviewable(uploaderId, {
      status: 'DUPLICATE',
      matchJson: {
        ...MATCH,
        notified: true,
        duplicate: { kind: 'recording', message: 'This recording is already in the library' },
      },
    });

  it('lets a manager keep a duplicate as an alternate version', async () => {
    rig = await startRig({ withImportJob: true });
    const id = await duplicate(rig.trustedId);
    const res = await api(rig.manager, 'POST', `/uploads/${id}/keep`, { reason: 'live take' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<UploadDetail>();
    expect(body.status).toBe('NEEDS_REVIEW');
    expect(body.match?.kept).toMatchObject({ by: rig.managerId, reason: 'live take' });
    // A kept duplicate is not auto-approved, even for a trusted uploader.
    expect(rig.imports).toEqual([]);
  });

  it('works without a body', async () => {
    rig = await startRig();
    const id = await duplicate(rig.aliceId);
    const res = await api(rig.manager, 'POST', `/uploads/${id}/keep`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses the owner unless uploads.allowDuplicateOverride is on', async () => {
    rig = await startRig();
    const id = await duplicate(rig.aliceId);
    const before = (await api(rig.alice, 'GET', `/uploads/${id}`)).json<UploadDetail>();
    expect(before.canKeep).toBe(false);
    expect((await api(rig.alice, 'POST', `/uploads/${id}/keep`)).statusCode).toBe(403);
    expect(rowOf(rig, id)?.status).toBe('DUPLICATE');

    rig.h.app.hearer.settings.set('uploads', { allowDuplicateOverride: true });
    const after = (await api(rig.alice, 'GET', `/uploads/${id}`)).json<UploadDetail>();
    expect(after.canKeep).toBe(true);
    expect((await api(rig.alice, 'POST', `/uploads/${id}/keep`)).statusCode).toBe(200);
  });

  it('never lets someone else’s duplicate be overridden by a plain user, even with the setting', async () => {
    rig = await startRig();
    rig.h.app.hearer.settings.set('uploads', { allowDuplicateOverride: true });
    const id = await duplicate(rig.aliceId);
    expect((await api(rig.bob, 'POST', `/uploads/${id}/keep`)).statusCode).toBe(404);
  });

  it('only applies to duplicates', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    const res = await api(rig.manager, 'POST', `/uploads/${id}/keep`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_duplicate');
  });
});

describe('POST /uploads/:id/reanalyze', () => {
  it('re-runs the analysis, e.g. after an AcoustID key was added', async () => {
    rig = await startRig();
    const settings = rig.h.app.hearer.settings;
    settings.set('metadata', { ...settings.get('metadata'), acoustIdApiKey: '' });
    const file = makeAudio(rig.audioDir, 'again.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    const first = await settled(rig, id);
    expect(first.status).toBe('NEEDS_REVIEW');
    expect(first.chosenJson).toBeNull();

    settings.set('metadata', { ...settings.get('metadata'), acoustIdApiKey: 'new-key' });
    const res = await api(rig.alice, 'POST', `/uploads/${id}/reanalyze`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<UploadDetail>().status).toBe('RECEIVED');
    await waitFor(() => {
      const row = rowOf(rig, id);
      return row?.status === 'NEEDS_REVIEW' && row.chosenJson !== null;
    });
    expect(rowOf(rig, id)?.chosenJson).toMatchObject({ mbRecordingId: IDS.recording });
  });

  it('recovers a FAILED upload', async () => {
    rig = await startRig();
    const file = makeAudio(rig.audioDir, 'failed.wav', { seconds: 5 });
    const id = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file,
      durationMs: 5000,
      status: 'FAILED',
    });
    expect((await api(rig.alice, 'POST', `/uploads/${id}/reanalyze`)).statusCode).toBe(200);
    expect(['NEEDS_REVIEW']).toContain((await settled(rig, id)).status);
  });

  it('is limited to the owner or a manager and to re-runnable states', async () => {
    rig = await startRig();
    const id = await seedReviewable(rig.aliceId);
    expect((await api(rig.bob, 'POST', `/uploads/${id}/reanalyze`)).statusCode).toBe(404);
    const approved = await seedReviewable(rig.aliceId, { status: 'APPROVED' });
    expect((await api(rig.alice, 'POST', `/uploads/${approved}/reanalyze`)).statusCode).toBe(409);
    rig.h.app.hearer.database.db
      .update(uploads)
      .set({ stagingPath: null })
      .where(eq(uploads.id, id))
      .run();
    expect((await api(rig.alice, 'POST', `/uploads/${id}/reanalyze`)).statusCode).toBe(409);
  });
});

describe('POST /uploads/batch/:batchId/approve', () => {
  it('approves every reviewable file of the album and reports the rest', async () => {
    rig = await startRig({ withImportJob: true });
    const batchId = randomUUID();
    const a = await seedReviewable(rig.trustedId, { batchId });
    const b = await seedReviewable(rig.trustedId, { batchId });
    const untagged = await seedReviewable(rig.trustedId, { batchId, chosenJson: null });
    const dup = await seedReviewable(rig.trustedId, { batchId, status: 'DUPLICATE' });
    const res = await api(rig.trusted, 'POST', `/uploads/batch/${batchId}/approve`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ approved: string[]; skipped: { id: string; reason: string }[] }>();
    expect(body.approved.sort()).toEqual([a, b].sort());
    expect(body.skipped.map((s) => s.id).sort()).toEqual([untagged, dup].sort());
    await waitFor(() => rig.imports.length === 2);
    expect(rowOf(rig, a)?.status).toBe('APPROVED');
    expect(rowOf(rig, untagged)?.status).toBe('NEEDS_REVIEW');
  });

  it('needs AUTO_APPROVE_UPLOAD or MANAGE_UPLOADS, and hides other people’s batches', async () => {
    rig = await startRig({ withImportJob: true });
    const batchId = randomUUID();
    await seedReviewable(rig.aliceId, { batchId });
    expect((await api(rig.alice, 'POST', `/uploads/batch/${batchId}/approve`)).statusCode).toBe(
      403,
    );
    expect((await api(rig.bob, 'POST', `/uploads/batch/${batchId}/approve`)).statusCode).toBe(404);
    expect((await api(rig.trusted, 'POST', `/uploads/batch/${batchId}/approve`)).statusCode).toBe(
      404,
    );
    expect((await api(rig.manager, 'POST', `/uploads/batch/${batchId}/approve`)).statusCode).toBe(
      200,
    );
    expect(
      (await api(rig.manager, 'POST', `/uploads/batch/${randomUUID()}/approve`)).statusCode,
    ).toBe(404);
  });
});

describe('events', () => {
  it('emits upload.needs_review and upload.duplicate when an event bus exists', async () => {
    rig = await startRig();
    const events: [string, Record<string, unknown>][] = [];
    for (const name of ['upload.needs_review', 'upload.duplicate'] as const) {
      rig.h.app.hearer.events.on(name, (payload) => {
        events.push([name, payload]);
      });
    }
    const file = makeAudio(rig.audioDir, 'ev.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    await settled(rig, id);
    expect(events.map((e) => e[0])).toEqual(['upload.needs_review']);
    expect(events[0]?.[1]).toMatchObject({
      uploadId: id,
      uploaderId: rig.aliceId,
      title: 'Paranoid Android',
    });

    const dupFile = makeAudio(rig.audioDir, 'ev2.wav', { seconds: 384, frequency: 500 });
    rig.h.app.hearer.database.db
      .update(uploads)
      .set({ status: 'IMPORTED' })
      .where(eq(uploads.id, id))
      .run();
    const same = await seedUpload(rig, {
      uploaderId: rig.aliceId,
      file: dupFile,
      durationMs: 384_000,
      sha256: rowOf(rig, id)?.sha256 ?? '',
    });
    await settled(rig, same);
    expect(events.map((e) => e[0])).toEqual(['upload.needs_review', 'upload.duplicate']);
  });

  it('survives a broken subscriber', async () => {
    rig = await startRig();
    (rig.h.app.hearer as unknown as { events: unknown }).events = {
      emit: () => {
        throw new Error('subscriber crashed');
      },
    };
    const file = makeAudio(rig.audioDir, 'ev3.wav', { seconds: 384 });
    const id = await seedUpload(rig, { uploaderId: rig.aliceId, file, durationMs: 384_000 });
    expect((await settled(rig, id)).status).toBe('NEEDS_REVIEW');
  });
});
