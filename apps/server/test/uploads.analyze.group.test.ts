import type { MatchCandidate } from '@hearer/shared';
import { describe, expect, it } from 'vitest';
import type {
  MetadataProvider,
  ReleaseDetailBase,
  ReleaseGroupDetailBase,
  ReleaseSummary,
  TrackBase,
} from '../src/adapters/metadata/types.ts';
import { MetadataError } from '../src/adapters/metadata/types.ts';
import { emptyTags } from '../src/lib/audioTags.ts';
import {
  MatchingService,
  assembleCandidate,
  findTrack,
  type GroupMember,
} from '../src/services/matching.ts';

const mb = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ARTIST = mb(1);
const credit = [{ mbid: ARTIST, name: 'The Band', joinPhrase: '' }];
const REC = { a: mb(10), b: mb(11), c: mb(12), x: mb(13) };

const track = (rec: string, title: string, position: number, disc = 1): TrackBase => ({
  mbid: rec,
  title,
  discNumber: disc,
  position,
  number: null,
  lengthMs: 200_000,
  artistCredit: credit,
  artistName: 'The Band',
  isrcs: [],
});

const release = (id: string, title: string, trackCount: number): ReleaseSummary => ({
  mbid: id,
  title,
  date: '2001-01-01',
  country: null,
  status: 'Official',
  format: 'CD',
  trackCount,
});

const R1 = release(mb(101), 'The Album', 3);
const R2 = release(mb(102), 'Greatest Hits', 2);
const TRACKS: Record<string, TrackBase[]> = {
  [R1.mbid]: [track(REC.a, 'Alpha', 1), track(REC.b, 'Beta', 2), track(REC.c, 'Gamma', 3)],
  [R2.mbid]: [track(REC.x, 'Other', 1), track(REC.a, 'Alpha', 2)],
};
const groupOf = (
  id: string,
  title: string,
  r: ReleaseSummary,
  type: string[],
): ReleaseGroupDetailBase => ({
  mbid: id,
  title,
  disambiguation: '',
  primaryType: 'Album',
  secondaryTypes: type,
  firstReleaseDate: '2001-01-01',
  artistCredit: credit,
  artistName: 'The Band',
  coverUrl: '',
  score: null,
  releases: [r],
  representativeRelease: r,
  tracks: TRACKS[r.mbid] ?? [],
});
const RG1 = groupOf(mb(201), 'The Album', R1, []);
const RG2 = groupOf(mb(202), 'Greatest Hits', R2, ['Compilation']);

const provider: Pick<MetadataProvider, 'getReleaseGroup' | 'getRelease'> = {
  getReleaseGroup: (id) => {
    const found = [RG1, RG2].find((g) => g.mbid === id);
    return found ? Promise.resolve(found) : Promise.reject(new MetadataError('not_found', 'no'));
  },
  getRelease: (id) => {
    const rel = [R1, R2].find((r) => r.mbid === id);
    if (!rel) return Promise.reject(new MetadataError('not_found', 'no'));
    const detail: ReleaseDetailBase = {
      ...rel,
      releaseGroupMbid: rel === R1 ? RG1.mbid : RG2.mbid,
      tracks: TRACKS[id] ?? [],
    };
    return Promise.resolve(detail);
  },
};
const service = new MatchingService({
  metadata: provider as MetadataProvider,
  coverBaseUrl: () => 'https://caa.test',
});

function candidate(
  rg: ReleaseGroupDetailBase,
  r: ReleaseSummary,
  t: TrackBase,
  score: number,
  alsoOn: string[] = [],
): MatchCandidate {
  const built = assembleCandidate({
    facts: { durationMs: 200_000, tags: emptyTags() },
    resolved: { group: rg, release: r, tracks: TRACKS[r.mbid] ?? [], track: t },
    track: t,
    recordingIsrcs: [],
    sources: ['acoustid'],
    acoustScore: score,
    acoustId: null,
    releaseGroupMbids: alsoOn,
    coverBaseUrl: 'https://caa.test',
  });
  if (!built) throw new Error('candidate not built');
  return built;
}

const member = (uploadId: string, candidates: MatchCandidate[]): GroupMember => ({
  uploadId,
  facts: { durationMs: 200_000, tags: emptyTags() },
  candidates,
});

describe('album grouping', () => {
  const alphaOnCompilation = () => candidate(RG2, R2, track(REC.a, 'Alpha', 2), 0.97, [RG1.mbid]);
  const betaOnAlbum = () => candidate(RG1, R1, track(REC.b, 'Beta', 2), 0.95);

  it('moves files onto the release they share, with consistent numbering', async () => {
    const outcome = await service.group([
      member('f1', [alphaOnCompilation()]),
      member('f2', [betaOnAlbum()]),
    ]);
    expect(outcome.group).toMatchObject({
      releaseMbid: R1.mbid,
      releaseGroupMbid: RG1.mbid,
      title: 'The Album',
      trackTotal: 3,
      unmatchedUploadIds: [],
    });
    expect(outcome.group?.tracks).toEqual([
      { uploadId: 'f1', recordingMbid: REC.a, discNumber: 1, trackNumber: 1 },
      { uploadId: 'f2', recordingMbid: REC.b, discNumber: 1, trackNumber: 2 },
    ]);
    const first = outcome.updated.get('f1')?.[0];
    expect(first).toMatchObject({
      releaseMbid: R1.mbid,
      album: 'The Album',
      trackNumber: 1,
      trackTotal: 3,
    });
    expect(first?.tags).toMatchObject({
      mbReleaseId: R1.mbid,
      mbReleaseGroupId: RG1.mbid,
      album: 'The Album',
      compilation: null,
    });
    expect(outcome.updated.get('f2')?.[0]?.releaseMbid).toBe(R1.mbid);
  });

  it('keeps the other candidates and re-sorts', async () => {
    const outcome = await service.group([
      member('f1', [alphaOnCompilation()]),
      member('f2', [betaOnAlbum(), candidate(RG2, R2, track(REC.x, 'Other', 1), 0.2)]),
    ]);
    const second = outcome.updated.get('f2');
    expect(second?.map((c) => c.recordingMbid)).toEqual([REC.b, REC.x]);
  });

  it('does nothing when no release group is shared', async () => {
    const outcome = await service.group([
      member('f1', [candidate(RG2, R2, track(REC.x, 'Other', 1), 0.9)]),
      member('f2', [betaOnAlbum()]),
    ]);
    expect(outcome.group).toBeNull();
    expect(outcome.updated.size).toBe(0);
  });

  it('does nothing for a single file or weak candidates', async () => {
    expect((await service.group([member('f1', [betaOnAlbum()])])).group).toBeNull();
    const weak = { ...betaOnAlbum(), score: 0.1 };
    const outcome = await service.group([
      member('f1', [{ ...alphaOnCompilation(), score: 0.1 }]),
      member('f2', [weak]),
    ]);
    expect(outcome.group).toBeNull();
  });

  it('reports a member that is not on the chosen release', async () => {
    const outcome = await service.group([
      member('f1', [alphaOnCompilation()]),
      member('f2', [betaOnAlbum()]),
      member('f3', [candidate(RG2, R2, track(REC.x, 'Other', 1), 0.9)]),
    ]);
    expect(outcome.group?.unmatchedUploadIds).toEqual(['f3']);
    expect(outcome.updated.has('f3')).toBe(false);
  });

  it('prefers the group that most files share, then the higher total score', async () => {
    const outcome = await service.group([
      member('f1', [alphaOnCompilation()]),
      member('f2', [betaOnAlbum()]),
      member('f3', [candidate(RG2, R2, track(REC.x, 'Other', 1), 0.99)]),
    ]);
    // RG1: f1+f2 (2 files). RG2: f1+f3 (2 files) but lower total score than RG1? f1 .97 + f3 .99
    // beats .97 + .95, so the compilation wins the tie-break on score.
    expect(outcome.group?.releaseGroupMbid).toBe(RG2.mbid);
    expect(outcome.group?.tracks.map((t) => t.trackNumber).sort()).toEqual([1, 2]);
  });
});

describe('findTrack', () => {
  const tracks = TRACKS[R1.mbid] ?? [];
  it('matches by recording id, then by a unique normalised title', () => {
    expect(findTrack(tracks, REC.b, 'whatever')?.position).toBe(2);
    expect(findTrack(tracks, 'unknown', 'GAMMA (Remastered)')?.position).toBe(3);
    expect(findTrack(tracks, 'unknown', 'Delta')).toBeNull();
    expect(findTrack(tracks, '', '')).toBeNull();
  });
  it('refuses an ambiguous title', () => {
    const dup = [track(REC.a, 'Same', 1), track(REC.b, 'Same', 2)];
    expect(findTrack(dup, 'unknown', 'Same')).toBeNull();
  });
});
