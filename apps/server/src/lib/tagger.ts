/**
 * Tag writing for imported files (PLAN upload pipeline step 5).
 *
 * Primary path: `node-taglib-sharp`, in place, with format-correct frames:
 *
 *   family   formats           frames / fields
 *   id3v2    mp3, wav, aiff    TIT2 TPE1 TPE2 TALB TRCK TPOS TDRC TCON TSRC TCMP, UFID
 *                              `http://musicbrainz.org` (recording id), TXXX "MusicBrainz Release
 *                              Track Id" / "MusicBrainz Album Id" / "MusicBrainz Release Group Id"
 *                              / "MusicBrainz Artist Id" / "MusicBrainz Album Artist Id" /
 *                              "Acoustid Id", APIC (front cover)
 *   xiph     flac, ogg, opus   TITLE ARTIST ALBUMARTIST ALBUM TRACKNUMBER TRACKTOTAL DISCNUMBER
 *                              DISCTOTAL DATE GENRE ISRC COMPILATION, MUSICBRAINZ_TRACKID (the
 *                              RECORDING id, Picard's convention), MUSICBRAINZ_RELEASETRACKID,
 *                              MUSICBRAINZ_ALBUMID, MUSICBRAINZ_RELEASEGROUPID,
 *                              MUSICBRAINZ_ARTISTID, MUSICBRAINZ_ALBUMARTISTID, ACOUSTID_ID,
 *                              cover as FLAC PICTURE block / METADATA_BLOCK_PICTURE
 *   mp4      m4a               (c)nam (c)ART aART (c)alb trkn disk (c)day (c)gen cpil,
 *                              freeform `----:com.apple.iTunes:` MusicBrainz Track Id (recording),
 *                              MusicBrainz Release Track Id, MusicBrainz Album Id, MusicBrainz
 *                              Release Group Id, MusicBrainz Artist Id, MusicBrainz Album Artist
 *                              Id, Acoustid Id, ISRC; covr (cover)
 *
 * WAV and AIFF have no standard tag container; taglib writes an ID3v2 chunk, which Jellyfin and
 * music-metadata read. Players that only know RIFF INFO see nothing.
 *
 * Fallback: after the taglib write the file is re-read with `music-metadata`. When the essential
 * fields (title, artist, recording id) did not survive, or taglib refuses the file, the file is
 * remuxed with `ffmpeg -map 0 -c copy -metadata ...` into a temp file that replaces it (an
 * argument array, never a shell). ffmpeg writes the keys its muxer supports; covers are carried
 * for mp3, flac and m4a only.
 */
import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TagSet } from '@hearer/shared';
import { parseFile } from 'music-metadata';
import {
  ByteVector,
  File as TagFile,
  Id3v2FrameIdentifiers,
  type Id3v2FrameIdentifier,
  type Id3v2Tag,
  type Mpeg4AppleTag,
  type XiphComment,
  Id3v2UniqueFileIdentifierFrame,
  Id3v2UserTextInformationFrame,
  Picture,
  PictureType,
  StringType,
  TagTypes,
  type IPicture,
} from 'node-taglib-sharp';

export type TagWriteMethod = 'taglib' | 'ffmpeg';

export interface CoverImage {
  data: Buffer;
  /** `image/jpeg` or `image/png`. */
  mimeType: string;
}

export interface WriteTagsResult {
  method: TagWriteMethod;
  /** Whether a new front cover was written. */
  coverEmbedded: boolean;
  /** Why the ffmpeg fallback ran, if it did. */
  fallbackReason?: string;
}

export interface WriteTagsOptions {
  /** Front cover to embed. Null/absent keeps whatever picture the file has. */
  cover?: CoverImage | null;
  /** `ffmpeg` executable. Default `ffmpeg` from PATH. */
  ffmpegBinary?: string;
  timeoutMs?: number;
  /** Test hook: skip taglib and use the ffmpeg path. */
  force?: TagWriteMethod;
}

export const FFMPEG_TIMEOUT_MS = 120_000;

type Family = 'id3v2' | 'xiph' | 'mp4';

const FAMILY_BY_EXT: Record<string, Family> = {
  mp3: 'id3v2',
  wav: 'id3v2',
  aiff: 'id3v2',
  aif: 'id3v2',
  flac: 'xiph',
  ogg: 'xiph',
  opus: 'xiph',
  m4a: 'mp4',
  mp4: 'mp4',
};

export class TagWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TagWriteError';
  }
}

/** Latin-1 bytes: UFID identifiers and MP4 box types are single-byte. */
/** An ID3v2 frame identifier by name (the library types its table as a loose record). */
function frameId(name: string): Id3v2FrameIdentifier {
  const id = Id3v2FrameIdentifiers[name];
  if (!id) throw new TagWriteError(`Unknown ID3v2 frame ${name}`);
  return id;
}

const bv = (text: string): ByteVector => ByteVector.fromString(text, StringType.Latin1);
const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== '';

/** Picard's names for the fields every family stores as user-defined text. */
const CUSTOM_NAMES = {
  'MusicBrainz Release Track Id': 'MUSICBRAINZ_RELEASETRACKID',
  'MusicBrainz Album Id': 'MUSICBRAINZ_ALBUMID',
  'MusicBrainz Release Group Id': 'MUSICBRAINZ_RELEASEGROUPID',
  'MusicBrainz Artist Id': 'MUSICBRAINZ_ARTISTID',
  'MusicBrainz Album Artist Id': 'MUSICBRAINZ_ALBUMARTISTID',
  'Acoustid Id': 'ACOUSTID_ID',
} as const;

/** The (Picard name, value) pairs that have a value. The recording id is handled per family. */
function customFields(tags: TagSet): [name: keyof typeof CUSTOM_NAMES, value: string][] {
  const out: [keyof typeof CUSTOM_NAMES, string | null | undefined][] = [
    ['MusicBrainz Release Track Id', tags.mbTrackId],
    ['MusicBrainz Album Id', tags.mbReleaseId],
    ['MusicBrainz Release Group Id', tags.mbReleaseGroupId],
    ['MusicBrainz Artist Id', tags.mbArtistId],
    ['MusicBrainz Album Artist Id', tags.mbAlbumArtistId],
    ['Acoustid Id', tags.acoustId],
  ];
  return out.filter((entry): entry is [keyof typeof CUSTOM_NAMES, string] => nonEmpty(entry[1]));
}

const pair = (no: number, total: number): string => `${String(no)}/${String(total)}`;

function makePicture(cover: CoverImage): IPicture {
  const picture = Picture.fromData(ByteVector.fromByteArray(cover.data));
  picture.type = PictureType.FrontCover;
  picture.mimeType = cover.mimeType;
  picture.description = 'Front cover';
  return picture;
}

function writeId3v2(tag: Id3v2Tag, tags: TagSet): void {
  // WAV/AIFF chunks start out as ID3v2.2, which has no UFID; always write 2.4.
  tag.version = 4;
  tag.title = tags.title;
  tag.performers = [tags.artist];
  tag.albumArtists = [tags.albumArtist];
  tag.album = tags.album;
  tag.setTextFrame(frameId('TRCK'), pair(tags.trackNumber, tags.trackTotal));
  tag.setTextFrame(frameId('TPOS'), pair(tags.discNumber, tags.discTotal));
  if (nonEmpty(tags.date)) tag.setTextFrame(frameId('TDRC'), tags.date);
  if (nonEmpty(tags.genre)) tag.genres = [tags.genre];
  if (nonEmpty(tags.isrc)) tag.setTextFrame(frameId('TSRC'), tags.isrc);
  if (tags.compilation === true) tag.setTextFrame(frameId('TCMP'), '1');
  // Picard stores the RECORDING id in a UFID frame owned by musicbrainz.org.
  tag.removeFrames(frameId('UFID'));
  tag.addFrame(
    Id3v2UniqueFileIdentifierFrame.fromData('http://musicbrainz.org', bv(tags.mbRecordingId)),
  );
  for (const [name, value] of customFields(tags)) {
    const stale = tag
      .getFramesByClassType<Id3v2UserTextInformationFrame>(
        // FrameClassType.UserTextInformationFrame
        Id3v2UserTextInformationFrame.fromDescription(name).frameClassType,
      )
      .filter((frame) => frame.description.toLowerCase() === name.toLowerCase());
    for (const frame of stale) tag.removeFrame(frame);
    const frame = Id3v2UserTextInformationFrame.fromDescription(name);
    frame.text = [value];
    tag.addFrame(frame);
  }
}

function writeXiph(tag: XiphComment, tags: TagSet): void {
  tag.title = tags.title;
  tag.performers = [tags.artist];
  tag.albumArtists = [tags.albumArtist];
  tag.album = tags.album;
  tag.setFieldAsStrings('TRACKNUMBER', String(tags.trackNumber));
  tag.setFieldAsStrings('TRACKTOTAL', String(tags.trackTotal));
  tag.removeField('TOTALTRACKS');
  tag.setFieldAsStrings('DISCNUMBER', String(tags.discNumber));
  tag.setFieldAsStrings('DISCTOTAL', String(tags.discTotal));
  tag.removeField('TOTALDISCS');
  if (nonEmpty(tags.date)) tag.setFieldAsStrings('DATE', tags.date);
  if (nonEmpty(tags.genre)) tag.genres = [tags.genre];
  if (nonEmpty(tags.isrc)) tag.setFieldAsStrings('ISRC', tags.isrc);
  if (tags.compilation === true) tag.setFieldAsStrings('COMPILATION', '1');
  tag.setFieldAsStrings('MUSICBRAINZ_TRACKID', tags.mbRecordingId);
  for (const [name, value] of customFields(tags)) {
    tag.setFieldAsStrings(CUSTOM_NAMES[name], value);
  }
}

const FREEFORM_MEAN = 'com.apple.iTunes';

function writeMp4(tag: Mpeg4AppleTag, tags: TagSet): void {
  tag.title = tags.title;
  tag.performers = [tags.artist];
  tag.albumArtists = [tags.albumArtist];
  tag.album = tags.album;
  tag.track = tags.trackNumber;
  tag.trackCount = tags.trackTotal;
  tag.disc = tags.discNumber;
  tag.discCount = tags.discTotal;
  if (nonEmpty(tags.date)) tag.setQuickTimeString(bv('©day'), tags.date);
  if (nonEmpty(tags.genre)) tag.genres = [tags.genre];
  if (tags.compilation === true) tag.isCompilation = true;
  if (nonEmpty(tags.isrc)) tag.setItunesStrings(FREEFORM_MEAN, 'ISRC', tags.isrc);
  tag.setItunesStrings(FREEFORM_MEAN, 'MusicBrainz Track Id', tags.mbRecordingId);
  for (const [name, value] of customFields(tags)) {
    tag.setItunesStrings(FREEFORM_MEAN, name, value);
  }
}

/** Write the tags (and cover) into `path` with taglib. Throws if taglib cannot handle the file. */
function writeWithTaglib(path: string, ext: string, tags: TagSet, cover: CoverImage | null): void {
  const family = FAMILY_BY_EXT[ext];
  if (!family) throw new TagWriteError(`No tag writer for .${ext}`);
  const file = TagFile.createFromPath(path);
  try {
    if (family === 'id3v2') {
      writeId3v2(file.getTag(TagTypes.Id3v2, true) as Id3v2Tag, tags);
    } else if (family === 'xiph') {
      writeXiph(file.getTag(TagTypes.Xiph, true) as XiphComment, tags);
    } else {
      writeMp4(file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag, tags);
    }
    if (cover) file.tag.pictures = [makePicture(cover)];
    file.save();
  } finally {
    file.dispose();
  }
}

// --- verification ------------------------------------------------------------------------------

/** Whether the essentials survived: title, artist, recording id. Returns the first problem. */
export async function verifyEssentials(
  path: string,
  tags: TagSet,
  checkRecordingId = true,
): Promise<string | null> {
  try {
    const { common } = await parseFile(path, { duration: false, skipPostHeaders: true });
    if (common.title !== tags.title) return 'title was not written';
    if (common.artist !== tags.artist) return 'artist was not written';
    if (checkRecordingId && common.musicbrainz_recordingid?.toLowerCase() !== tags.mbRecordingId) {
      return 'MusicBrainz recording id was not written';
    }
    return null;
  } catch (err) {
    return `the written file cannot be read back: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- ffmpeg ------------------------------------------------------------------------------------

function runFfmpeg(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new TagWriteError(`ffmpeg failed: ${(stderr || err.message).trim().slice(-400)}`, {
              cause: err,
            }),
          );
        } else resolve();
      },
    );
  });
}

/** ffmpeg metadata keys. Vorbis containers take the Vorbis names, the others Picard's. */
function ffmpegMetadata(tags: TagSet, family: Family): [string, string][] {
  const out: [string, string][] = [
    ['title', tags.title],
    ['artist', tags.artist],
    ['album_artist', tags.albumArtist],
    ['album', tags.album],
    ['track', pair(tags.trackNumber, tags.trackTotal)],
    ['disc', pair(tags.discNumber, tags.discTotal)],
  ];
  if (nonEmpty(tags.date)) out.push(['date', tags.date]);
  if (nonEmpty(tags.genre)) out.push(['genre', tags.genre]);
  if (nonEmpty(tags.isrc)) out.push(['isrc', tags.isrc]);
  if (tags.compilation === true) out.push(['compilation', '1']);
  if (family === 'xiph') {
    out.push(['MUSICBRAINZ_TRACKID', tags.mbRecordingId]);
    for (const [name, value] of customFields(tags)) out.push([CUSTOM_NAMES[name], value]);
  } else {
    out.push(['MusicBrainz Track Id', tags.mbRecordingId]);
    out.push(...customFields(tags));
  }
  return out;
}

const COVER_CONTAINERS = new Set(['mp3', 'flac', 'm4a', 'mp4']);

async function writeWithFfmpeg(
  path: string,
  ext: string,
  tags: TagSet,
  cover: CoverImage | null,
  options: WriteTagsOptions,
): Promise<boolean> {
  const family = FAMILY_BY_EXT[ext] ?? 'id3v2';
  const stamp = `${String(process.pid)}-${String(Date.now())}`;
  const out = join(dirname(path), `.hearer-remux-${stamp}.${ext}`);
  const coverPath = join(
    dirname(path),
    `.hearer-cover-${stamp}.${cover?.mimeType === 'image/png' ? 'png' : 'jpg'}`,
  );
  const withCover = cover !== null && COVER_CONTAINERS.has(ext);
  try {
    const args = ['-v', 'error', '-y', '-i', path];
    if (withCover) {
      await writeFile(coverPath, cover.data);
      args.push('-i', coverPath, '-map', '0:a', '-map', '1:v');
      args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    } else {
      args.push('-map', '0');
    }
    args.push('-map_metadata', '-1', '-c:a', 'copy');
    if (!withCover) args.push('-c:v', 'copy');
    if (ext === 'mp3') args.push('-id3v2_version', '3');
    // The MP4 muxer keeps title/artist/album/track/disc/date/genre and the covr atom, but drops
    // keys it has no atom for (the MusicBrainz ids): m4a depends on the taglib path for those.
    for (const [key, value] of ffmpegMetadata(tags, family)) {
      args.push('-metadata', `${key}=${value}`);
    }
    args.push(out);
    await runFfmpeg(options.ffmpegBinary ?? 'ffmpeg', args, options.timeoutMs ?? FFMPEG_TIMEOUT_MS);
    await rename(out, path);
    return withCover;
  } finally {
    await rm(out, { force: true });
    await rm(coverPath, { force: true });
  }
}

/**
 * Write `tags` (and optionally a front cover) into the audio file at `path`, in place. Tries
 * taglib first and checks the result; falls back to an ffmpeg remux (see the header comment).
 */
export async function writeTags(
  path: string,
  ext: string,
  tags: TagSet,
  options: WriteTagsOptions = {},
): Promise<WriteTagsResult> {
  const cover = options.cover ?? null;
  const normalizedExt = ext.toLowerCase().replace(/^\./u, '');
  let reason = 'forced';
  if (options.force !== 'ffmpeg') {
    try {
      writeWithTaglib(path, normalizedExt, tags, cover);
      const problem = await verifyEssentials(path, tags);
      if (problem === null) return { method: 'taglib', coverEmbedded: cover !== null };
      reason = problem;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  const coverEmbedded = await writeWithFfmpeg(path, normalizedExt, tags, cover, options);
  // ffmpeg cannot write a UFID frame (ID3) or iTunes freeform atoms (MP4), so only Vorbis comments get the recording id check.
  const problem = await verifyEssentials(path, tags, FAMILY_BY_EXT[normalizedExt] === 'xiph');
  if (problem !== null)
    throw new TagWriteError(`Tag write failed: ${problem} (first attempt: ${reason})`);
  return { method: 'ffmpeg', coverEmbedded, fallbackReason: reason };
}

// --- cover scaling -----------------------------------------------------------------------------

/** Width and height from a JPEG or PNG header, or null when unreadable. */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return null;
}

/**
 * Make sure the cover's long edge is at most `maxPx`. Larger images are scaled down with ffmpeg
 * and re-encoded as JPEG; smaller ones (and anything whose size cannot be read) pass through.
 * `workDir` must be a directory the process owns (the upload's staging directory).
 */
export async function fitCover(
  cover: CoverImage,
  maxPx: number,
  workDir: string,
  options: Pick<WriteTagsOptions, 'ffmpegBinary' | 'timeoutMs'> = {},
): Promise<CoverImage> {
  const size = imageSize(cover.data);
  if (!size || Math.max(size.width, size.height) <= maxPx) return cover;
  const stamp = `${String(process.pid)}-${String(Date.now())}`;
  const input = join(workDir, `.cover-in-${stamp}`);
  const output = join(workDir, `.cover-out-${stamp}.jpg`);
  const max = String(maxPx);
  const scale = `scale='if(gt(iw,ih),min(${max},iw),-2)':'if(gt(iw,ih),-2,min(${max},ih))'`;
  try {
    await writeFile(input, cover.data);
    await runFfmpeg(
      options.ffmpegBinary ?? 'ffmpeg',
      ['-v', 'error', '-y', '-i', input, '-vf', scale, '-frames:v', '1', '-q:v', '3', output],
      options.timeoutMs ?? FFMPEG_TIMEOUT_MS,
    );
    return { data: await readFile(output), mimeType: 'image/jpeg' };
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}
