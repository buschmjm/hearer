import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FpcalcError,
  FpcalcUnavailableError,
  fpcalc,
  parseFpcalcOutput,
} from '../src/lib/fpcalc.ts';
import { readExistingTags, toTagDate } from '../src/lib/audioTags.ts';
import {
  combineScore,
  durationScore,
  levenshtein,
  rankReleases,
  scoreCandidate,
  similarity,
  sortCandidates,
  trackScore,
  UNFINGERPRINTED_FACTOR,
} from '../src/services/matching.ts';
import { emptyTags } from '../src/lib/audioTags.ts';

let dir: string;
let sine: string;
let tagged: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hearer-analyze-'));
  sine = join(dir, 'sine.flac');
  tagged = join(dir, 'tagged.mp3');
  const gen = (out: string, extra: string[]) => {
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', ...extra, out],
      { stdio: 'pipe' },
    );
  };
  gen(sine, ['-c:a', 'flac']);
  gen(tagged, [
    '-c:a',
    'libmp3lame',
    '-metadata',
    'title=Paranoid Android',
    '-metadata',
    'artist=Radiohead',
    '-metadata',
    'album=OK Computer',
    '-metadata',
    'track=2/12',
    '-metadata',
    'date=1997-05-21',
    '-metadata',
    'genre=Rock',
  ]);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fpcalc', () => {
  it('fingerprints generated audio', async () => {
    const result = await fpcalc(sine);
    expect(result.fingerprint.length).toBeGreaterThan(8);
    expect(result.duration).toBeCloseTo(4, 0);
  });

  it('reports a missing binary as unavailable, not as a bad file', async () => {
    await expect(fpcalc(sine, { binary: join(dir, 'no-such-fpcalc') })).rejects.toBeInstanceOf(
      FpcalcUnavailableError,
    );
  });

  it('reports an undecodable file as an FpcalcError', async () => {
    const junk = join(dir, 'junk.flac');
    writeFileSync(junk, 'this is not audio at all');
    await expect(fpcalc(junk)).rejects.toBeInstanceOf(FpcalcError);
  });

  it('kills a hung binary at the timeout', async () => {
    const slow = join(dir, 'slow-fpcalc');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    await expect(fpcalc(sine, { binary: slow, timeoutMs: 100 })).rejects.toThrow(/timed out/u);
  });

  it('refuses a relative path (it could be read as an option)', async () => {
    await expect(fpcalc('-version')).rejects.toBeInstanceOf(TypeError);
  });

  it('parses and validates fpcalc output', () => {
    expect(parseFpcalcOutput('{"duration": 12.5, "fingerprint": "AQAA"}')).toEqual({
      duration: 12.5,
      fingerprint: 'AQAA',
    });
    expect(parseFpcalcOutput('{"duration": "7", "fingerprint": "AQAA"}').duration).toBe(7);
    expect(() => parseFpcalcOutput('nope')).toThrow(FpcalcError);
    expect(() => parseFpcalcOutput('{"duration": 1}')).toThrow(FpcalcError);
    expect(() => parseFpcalcOutput('{"fingerprint": "x"}')).toThrow(FpcalcError);
  });
});

describe('existing tags', () => {
  it('reads common tags from a tagged file', async () => {
    const tags = await readExistingTags(tagged);
    expect(tags).toMatchObject({
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      trackNumber: 2,
      trackTotal: 12,
      date: '1997-05-21',
      genre: 'Rock',
      hasPicture: false,
    });
  });

  it('gives empty tags for an untagged file and for junk', async () => {
    expect((await readExistingTags(sine)).title).toBeNull();
    const junk = join(dir, 'junk.mp3');
    writeFileSync(junk, 'not audio');
    expect(await readExistingTags(junk)).toEqual(emptyTags());
  });

  it('keeps only well-formed dates', () => {
    expect(toTagDate('1997')).toBe('1997');
    expect(toTagDate('1997-05')).toBe('1997-05');
    expect(toTagDate('1997-05-21T00:00:00Z')).toBe('1997-05-21');
    expect(toTagDate('May 1997')).toBeNull();
    expect(toTagDate(null)).toBeNull();
    expect(toTagDate(1997)).toBe('1997');
  });
});

describe('duration curve', () => {
  it('gives full credit up to 2 s, zero from 15 s, linear in between', () => {
    expect(durationScore(100_000, 100_000)).toBe(1);
    expect(durationScore(100_000, 102_000)).toBe(1);
    expect(durationScore(102_000, 100_000)).toBe(1);
    expect(durationScore(100_000, 108_500)).toBeCloseTo(0.5, 5);
    expect(durationScore(100_000, 115_000)).toBe(0);
    expect(durationScore(100_000, 200_000)).toBe(0);
    expect(durationScore(100_000, 102_001)).toBeLessThan(1);
  });

  it('has no opinion when a length is unknown', () => {
    expect(durationScore(null, 1000)).toBeNull();
    expect(durationScore(1000, null)).toBeNull();
  });
});

describe('similarity', () => {
  it('is 1 for names that normalise the same', () => {
    expect(similarity('Beyoncé', 'beyonce', 'artist')).toBe(1);
    expect(similarity('Paranoid Android (Remastered 2011)', 'Paranoid Android')).toBe(1);
    expect(similarity('The Beatles', 'Beatles', 'artist')).toBe(1);
  });

  it('forgives word order and small typos, punishes different names', () => {
    expect(similarity('Yorke Thom', 'Thom Yorke', 'artist')).toBe(1);
    expect(similarity('Paranoid Androd', 'Paranoid Android')).toBeGreaterThan(0.9);
    expect(similarity('Karma Police', 'Paranoid Android')).toBeLessThan(0.4);
    expect(similarity('', 'x')).toBe(0);
  });

  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
});

describe('scoring', () => {
  const tags = {
    ...emptyTags(),
    title: 'Paranoid Android',
    artist: 'Radiohead',
    album: 'OK Computer',
    trackNumber: 2,
  };
  const perfect = {
    tags,
    fileDurationMs: 383_000,
    title: 'Paranoid Android',
    artists: ['Radiohead'],
    album: 'OK Computer',
    lengthMs: 383_493,
    trackNumber: 2,
    discNumber: 1,
    acoustScore: 0.99,
  };

  it('scores a fingerprint plus matching tags near 1', () => {
    expect(scoreCandidate(perfect).score).toBeGreaterThan(0.99);
  });

  it('caps a tags-only match at the unfingerprinted factor', () => {
    const { score, breakdown } = scoreCandidate({ ...perfect, acoustScore: null });
    expect(breakdown.acoustId).toBeNull();
    expect(score).toBeCloseTo(UNFINGERPRINTED_FACTOR, 4);
  });

  it('leaves out evidence that does not exist instead of punishing it', () => {
    const untagged = scoreCandidate({ ...perfect, tags: emptyTags() });
    expect(untagged.breakdown).toMatchObject({
      title: null,
      artist: null,
      album: null,
      track: null,
    });
    expect(untagged.score).toBeGreaterThan(0.95);
  });

  it('lets wrong tags and a wrong length pull a fingerprint match down', () => {
    const wrong = scoreCandidate({
      ...perfect,
      title: 'Karma Police',
      lengthMs: 261_000,
      trackNumber: 6,
    });
    expect(wrong.score).toBeLessThan(0.7);
    expect(wrong.breakdown.track).toBe(0);
  });

  it('weighs the duration curve into the score', () => {
    const near = scoreCandidate({ ...perfect, lengthMs: 384_000 }).score;
    const far = scoreCandidate({ ...perfect, lengthMs: 400_000 }).score;
    expect(far).toBeLessThan(near);
  });

  it('is clamped to 0..1', () => {
    expect(
      combineScore({ acoustId: 1, title: 1, artist: 1, album: 1, duration: 1, track: 1 }),
    ).toBe(1);
    expect(
      combineScore({
        acoustId: null,
        title: null,
        artist: null,
        album: null,
        duration: null,
        track: null,
      }),
    ).toBe(0);
  });

  it('scores track numbers, with a half credit for the wrong disc', () => {
    expect(trackScore({ trackNumber: 2, discNumber: null }, 2, 1)).toBe(1);
    expect(trackScore({ trackNumber: 2, discNumber: 1 }, 2, 2)).toBe(0.5);
    expect(trackScore({ trackNumber: 2, discNumber: null }, 3, 1)).toBe(0);
    expect(trackScore({ trackNumber: null, discNumber: null }, 3, 1)).toBeNull();
  });
});

describe('release choice', () => {
  const release = (mbid: string, extra: Record<string, unknown> = {}) => ({
    mbid,
    title: 'OK Computer',
    date: '1997-05-21',
    country: null,
    status: 'Official',
    format: 'CD',
    trackCount: 12,
    ...extra,
  });
  const group = {
    releases: [
      release('c', { date: '2017-07-07', title: 'OK Computer OKNOTOK', trackCount: 23 }),
      release('b', { date: '1997-06-16' }),
      release('a', { date: '1997-05-21', status: 'Bootleg' }),
    ],
    representativeRelease: release('b'),
  };

  it('prefers a tagged release id over everything else', () => {
    const ranked = rankReleases(group, { releaseMbids: ['c'], album: null, trackTotal: null });
    expect(ranked[0]?.mbid).toBe('c');
  });

  it('prefers the release the batch settled on', () => {
    const ranked = rankReleases(group, {
      releaseMbids: ['c'],
      album: null,
      trackTotal: null,
      preferReleaseMbid: 'a',
    });
    expect(ranked[0]?.mbid).toBe('a');
  });

  it('uses album title and track count, then official and representative', () => {
    const byTitle = rankReleases(group, { releaseMbids: [], album: 'ok computer', trackTotal: 12 });
    expect(byTitle.map((r) => r.mbid)).toEqual(['b', 'a', 'c']);
    const byCount = rankReleases(group, { releaseMbids: [], album: null, trackTotal: 23 });
    expect(byCount[0]?.mbid).toBe('c');
  });
});

describe('candidate ordering', () => {
  const stub = (recording: string, release: string, score: number, sources: string[] = []) =>
    ({
      id: `${recording}@${release}`,
      recordingMbid: recording,
      releaseMbid: release,
      score,
      sources,
    }) as unknown as Parameters<typeof sortCandidates>[0][number];

  it('keeps one candidate per recording and release, the best scoring one', () => {
    const out = sortCandidates([
      stub('r1', 'a', 0.6, ['tags']),
      stub('r1', 'a', 0.9, ['acoustid']),
      stub('r1', 'a', 0.9, ['acoustid']),
      stub('r1', 'b', 0.7),
      stub('r2', 'a', 0.95),
    ]);
    expect(out.map((c) => [c.id, c.score])).toEqual([
      ['r2@a', 0.95],
      ['r1@a', 0.9],
      ['r1@b', 0.7],
    ]);
  });
});
