import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TagSet } from '@hearer/shared';
import { parseFile } from 'music-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitCover, imageSize, writeTags, type CoverImage } from '../src/lib/tagger.ts';

const MB = {
  recording: '11111111-1111-4111-8111-111111111111',
  track: '22222222-2222-4222-8222-222222222222',
  release: '33333333-3333-4333-8333-333333333333',
  group: '44444444-4444-4444-8444-444444444444',
  artist: '55555555-5555-4555-8555-555555555555',
  albumArtist: '66666666-6666-4666-8666-666666666666',
};

const TAGS: TagSet = {
  title: 'Paranoid Android',
  artist: 'Radiohead',
  albumArtist: 'Radiohead',
  album: 'OK Computer',
  trackNumber: 2,
  trackTotal: 12,
  discNumber: 1,
  discTotal: 2,
  date: '1997-05-21',
  genre: 'Art Rock',
  mbRecordingId: MB.recording,
  mbTrackId: MB.track,
  mbReleaseId: MB.release,
  mbReleaseGroupId: MB.group,
  mbArtistId: MB.artist,
  mbAlbumArtistId: MB.albumArtist,
  acoustId: '9f6a1d3e-0b0a-4f6e-9c53-0d4a1c6a2b11',
  isrc: 'GBAYE9700123',
  compilation: false,
};

const ENCODERS: Record<string, string[]> = {
  flac: ['-c:a', 'flac'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '64k'],
  m4a: ['-c:a', 'aac', '-b:a', '64k'],
  ogg: ['-c:a', 'libvorbis'],
  opus: ['-c:a', 'libopus'],
  wav: ['-c:a', 'pcm_s16le'],
  aiff: ['-c:a', 'pcm_s16be'],
};

let dir: string;
let cover: CoverImage;
let bigCover: CoverImage;

const ffmpeg = (...args: string[]) => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hearer-tagger-'));
  for (const [ext, codec] of Object.entries(ENCODERS)) {
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...codec, join(dir, `src.${ext}`));
  }
  ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=600x600', '-frames:v', '1', join(dir, 'cover.jpg'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=3000x2000', '-frames:v', '1', join(dir, 'big.png'));
  cover = { data: readFileSync(join(dir, 'cover.jpg')), mimeType: 'image/jpeg' };
  bigCover = { data: readFileSync(join(dir, 'big.png')), mimeType: 'image/png' };
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stage = (ext: string, name = `work.${ext}`): string => {
  const path = join(dir, name);
  copyFileSync(join(dir, `src.${ext}`), path);
  return path;
};

describe('writeTags: every accepted format via taglib', () => {
  for (const ext of Object.keys(ENCODERS)) {
    it(`${ext}: tags, MusicBrainz ids and the cover survive a re-read`, async () => {
      const path = stage(ext);
      const result = await writeTags(path, ext, TAGS, { cover });
      expect(result.method).toBe('taglib');
      expect(result.coverEmbedded).toBe(true);

      const { common } = await parseFile(path);
      expect(common).toMatchObject({
        title: 'Paranoid Android',
        artist: 'Radiohead',
        albumartist: 'Radiohead',
        album: 'OK Computer',
        track: { no: 2, of: 12 },
        disk: { no: 1, of: 2 },
        genre: ['Art Rock'],
        musicbrainz_recordingid: MB.recording,
      });
      expect(common.date ?? String(common.year)).toMatch(/^1997/u);
      // Fields every container can carry.
      expect(common.musicbrainz_albumid).toBe(MB.release);
      expect(common.musicbrainz_releasegroupid).toBe(MB.group);
      expect(common.musicbrainz_artistid).toEqual([MB.artist]);
      expect(common.musicbrainz_albumartistid).toEqual([MB.albumArtist]);
      expect(common.musicbrainz_trackid).toBe(MB.track);
      expect(common.acoustid_id).toBe(TAGS.acoustId);
      expect(common.isrc).toEqual([TAGS.isrc]);
      expect(common.picture?.[0]?.format).toBe('image/jpeg');
      expect(common.picture?.[0]?.data.length).toBe(cover.data.length);
    });
  }
});

describe('writeTags: details', () => {
  it('replaces stale values instead of duplicating frames', async () => {
    const path = stage('mp3');
    await writeTags(path, 'mp3', TAGS, { cover });
    await writeTags(path, 'mp3', { ...TAGS, title: 'Second', mbReleaseId: MB.group }, { cover });
    const { common, native } = await parseFile(path);
    expect(common.title).toBe('Second');
    expect(common.musicbrainz_albumid).toBe(MB.group);
    const albumIds = (native['ID3v2.4'] ?? []).filter((t) => t.id === 'TXXX:MusicBrainz Album Id');
    expect(albumIds).toHaveLength(1);
    expect(common.picture).toHaveLength(1);
  });

  it('keeps an embedded picture when no cover is given', async () => {
    const path = stage('flac');
    await writeTags(path, 'flac', TAGS, { cover });
    await writeTags(path, 'flac', { ...TAGS, title: 'Again' });
    const { common } = await parseFile(path);
    expect(common.title).toBe('Again');
    expect(common.picture).toHaveLength(1);
  });

  it('writes the compilation flag and omits empty optional fields', async () => {
    const path = stage('flac');
    await writeTags(path, 'flac', {
      ...TAGS,
      compilation: true,
      genre: null,
      isrc: null,
      acoustId: null,
      mbTrackId: null,
      date: null,
    });
    const { common } = await parseFile(path);
    expect(common.compilation).toBe(true);
    expect(common.genre).toBeUndefined();
    expect(common.isrc).toBeUndefined();
    expect(common.acoustid_id).toBeUndefined();
  });

  it('writes unicode and awkward characters verbatim', async () => {
    const path = stage('m4a');
    const title = 'Sigur Rós – “Hoppípolla” / 日本語 ♥ \\ ?*';
    await writeTags(path, 'm4a', { ...TAGS, title });
    expect((await parseFile(path)).common.title).toBe(title);
  });
});

describe('writeTags: ffmpeg remux fallback', () => {
  for (const ext of ['flac', 'mp3', 'm4a', 'ogg', 'opus']) {
    it(`${ext}: essential tags, recording id and cover (where supported)`, async () => {
      const path = stage(ext, `fallback.${ext}`);
      const result = await writeTags(path, ext, TAGS, { cover, force: 'ffmpeg' });
      expect(result.method).toBe('ffmpeg');
      const { common } = await parseFile(path);
      expect(common).toMatchObject({
        title: 'Paranoid Android',
        artist: 'Radiohead',
        album: 'OK Computer',
      });
      // Only Vorbis comments get every MusicBrainz id through ffmpeg (see the tagger header).
      if (['flac', 'ogg', 'opus'].includes(ext)) {
        expect(common.musicbrainz_recordingid).toBe(MB.recording);
        expect(common.musicbrainz_albumid).toBe(MB.release);
      }
      if (ext === 'mp3') expect(common.musicbrainz_albumid).toBe(MB.release);
      if (['flac', 'mp3', 'm4a'].includes(ext)) {
        expect(result.coverEmbedded).toBe(true);
        expect(common.picture).toHaveLength(1);
      } else {
        expect(result.coverEmbedded).toBe(false);
      }
    });
  }

  it('falls back automatically when taglib cannot read the file', async () => {
    // A bogus ".flac" taglib rejects; ffmpeg cannot remux it either, so the error is surfaced.
    const path = join(dir, 'junk.flac');
    writeFileSync(path, Buffer.from('not audio at all'));
    await expect(writeTags(path, 'flac', TAGS)).rejects.toThrow(/ffmpeg failed/u);
  });

  it('rejects a format with no writer and no usable fallback', async () => {
    const path = join(dir, 'x.xyz');
    writeFileSync(path, 'x');
    await expect(writeTags(path, 'xyz', TAGS)).rejects.toThrow();
  });
});

describe('cover scaling', () => {
  it('reads sizes from PNG and JPEG headers', () => {
    expect(imageSize(bigCover.data)).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(cover.data)).toEqual({ width: 600, height: 600 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });

  it('passes a small cover through untouched', async () => {
    expect(await fitCover(cover, 1200, dir)).toBe(cover);
  });

  it('scales a large cover down to 1200 px on the long edge, as JPEG', async () => {
    const out = await fitCover(bigCover, 1200, dir);
    expect(out.mimeType).toBe('image/jpeg');
    expect(imageSize(out.data)).toEqual({ width: 1200, height: 800 });
  });

  it('scales a portrait cover by its height', async () => {
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=1000x2000',
      '-frames:v',
      '1',
      join(dir, 'tall.jpg'),
    );
    const tall: CoverImage = { data: readFileSync(join(dir, 'tall.jpg')), mimeType: 'image/jpeg' };
    const out = await fitCover(tall, 1200, dir);
    expect(imageSize(out.data)).toEqual({ width: 600, height: 1200 });
  });
});
