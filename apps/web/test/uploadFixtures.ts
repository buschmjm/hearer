import type { MatchCandidate, TagSet, UploadDetail, UploadDto } from '@hearer/shared';

export const MBID = {
  rec1: '9f9cf187-d6f9-437f-9d98-d59cdbd52757',
  rec2: '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7',
  rel: '1834eae1-741b-3c03-9ca5-0df3decb43ea',
  rg: 'b1392450-e666-3926-a536-22c65f834433',
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
};

export const UP_ID = '11111111-1111-4111-8111-111111111111';
export const UP_ID_2 = '22222222-2222-4222-8222-222222222222';
export const BATCH_ID = '33333333-3333-4333-8333-333333333333';
export const REQ_ID = '44444444-4444-4444-8444-444444444444';

export function tags(overrides: Partial<TagSet> = {}): TagSet {
  return {
    title: 'Paranoid Android',
    artist: 'Radiohead',
    albumArtist: 'Radiohead',
    album: 'OK Computer',
    trackNumber: 2,
    trackTotal: 12,
    discNumber: 1,
    discTotal: 1,
    date: '1997-05-21',
    genre: null,
    mbRecordingId: MBID.rec1,
    mbTrackId: null,
    mbReleaseId: MBID.rel,
    mbReleaseGroupId: MBID.rg,
    mbArtistId: MBID.artist,
    mbAlbumArtistId: MBID.artist,
    acoustId: null,
    isrc: null,
    compilation: false,
    coverSource: { type: 'caa', releaseMbid: MBID.rel },
    ...overrides,
  };
}

export function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  const t = overrides.tags ?? tags();
  return {
    id: `${t.mbRecordingId}@${t.mbReleaseId}`,
    recordingMbid: t.mbRecordingId,
    releaseMbid: t.mbReleaseId,
    releaseGroupMbid: t.mbReleaseGroupId,
    releaseGroupMbids: [t.mbReleaseGroupId],
    title: t.title,
    artist: t.artist,
    album: t.album,
    date: t.date ?? null,
    trackNumber: t.trackNumber,
    trackTotal: t.trackTotal,
    discNumber: t.discNumber,
    discTotal: t.discTotal,
    lengthMs: 387_000,
    coverUrl: null,
    score: 0.93,
    breakdown: { acoustId: 1, title: 1, artist: 1, album: 1, duration: 1, track: 1 },
    sources: ['acoustid', 'tags'],
    tags: t,
    ...overrides,
  };
}

export const CAND_A = candidate();
export const CAND_B = candidate({
  tags: tags({
    title: 'Airbag',
    trackNumber: 1,
    mbRecordingId: MBID.rec2,
    album: 'OK Computer OKNOTOK',
  }),
  score: 0.61,
  sources: ['tags'],
  lengthMs: 284_000,
});

export function upload(overrides: Partial<UploadDto> = {}): UploadDto {
  return {
    id: UP_ID,
    batchId: null,
    tusId: null,
    uploaderId: 'u1',
    uploaderName: 'Alice',
    originalName: 'paranoid.flac',
    size: 12_345_678,
    status: 'NEEDS_REVIEW',
    sha256: null,
    format: 'flac',
    codec: 'flac',
    durationMs: 386_000,
    bitrate: 900_000,
    sampleRate: 44_100,
    channels: 2,
    targetRequestId: null,
    libraryPath: null,
    error: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

export function detail(overrides: Partial<UploadDetail> = {}): UploadDetail {
  return {
    ...upload(),
    canKeep: false,
    chosen: null,
    match: {
      version: 1,
      analyzedAt: '2026-03-01T10:01:00.000Z',
      durationMs: 386_000,
      existingTags: {
        title: 'paranoid android',
        artist: 'radiohead',
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
      candidates: [CAND_A, CAND_B],
      group: null,
      duplicate: null,
      kept: null,
      chosenCandidateId: CAND_A.id,
      autoApproved: false,
      reviewed: false,
      notified: true,
    },
    ...overrides,
  };
}
