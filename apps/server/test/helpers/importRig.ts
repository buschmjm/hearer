import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TagSet } from '@hearer/shared';
import { libraryItems } from '../../src/db/schema.ts';
import type { ImportPoint } from '../../src/services/import.ts';
import { makeAudio, seedUpload, startRig, type Rig } from './analyze.ts';
import { IDS } from './mbServer.ts';
import { MOCK_API_KEY, startJellyfinMock, type JellyfinMock } from './jellyfin-mock.ts';

export const FIXTURE_TRACKS =
  (
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', 'fixtures', 'musicbrainz', 'release.json'),
        'utf8',
      ),
    ) as { media: { tracks: { recording: { id: string } }[] }[] }
  ).media[0]?.tracks.map((t) => t.recording.id) ?? [];

/** Where Jellyfin sees the library (mapped to the temp MUSIC_DIR in the rig). */
export const SERVER_MUSIC = '/data/music';

export const TAGS: TagSet = {
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
  mbRecordingId: IDS.recording,
  mbTrackId: null,
  mbReleaseId: IDS.release,
  mbReleaseGroupId: IDS.releaseGroup,
  mbArtistId: IDS.artist,
  mbAlbumArtistId: IDS.artist,
  acoustId: null,
  isrc: null,
  compilation: null,
  coverSource: { type: 'caa', releaseMbid: IDS.release },
};

export interface CoverServer {
  url: string;
  requests: string[];
  /** Answer 404 (no art). */
  missing: boolean;
  /** JPEG served for every release. */
  image: Buffer;
  close: () => Promise<void>;
}

/** A stand-in for coverartarchive.org. */
export async function startCoverServer(image: Buffer): Promise<CoverServer> {
  const state = { requests: [] as string[], missing: false, image };
  const server: Server = createServer((req, res) => {
    state.requests.push(req.url ?? '');
    if (state.missing) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': state.image.length });
    res.end(state.image);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  });
}

export function makeJpeg(dir: string, name: string, size: string): Buffer {
  const out = join(dir, name);
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${size}`, '-frames:v', '1', out],
    { stdio: 'pipe' },
  );
  return readFileSync(out);
}

export interface ImportRig extends Rig {
  jellyfin: JellyfinMock;
  caa: CoverServer;
  /** Set to throw (simulated crash) at a named step. */
  hook: { current: ((point: ImportPoint) => void | Promise<void>) | undefined };
  /** Replacement for fs.rename inside the import (simulate EXDEV). */
  renameImpl: { current: typeof fsRename };
  musicDir: string;
  stagingDir: string;
  closeAll: () => Promise<void>;
}

export async function startImportRig(
  options: { startJobs?: boolean; umask?: number } = {},
): Promise<ImportRig> {
  const hook: ImportRig['hook'] = { current: undefined };
  const renameImpl: ImportRig['renameImpl'] = { current: fsRename };
  const rig = await startRig({
    startJobs: options.startJobs ?? false,
    realImport: true,
    deps: {
      deps: {
        uploadImport: {
          hook: (point) => hook.current?.(point),
          rename: ((from: string, to: string) => renameImpl.current(from, to)) as typeof fsRename,
          ...(options.umask === undefined ? {} : { umask: options.umask }),
        },
      },
    },
  });
  const jellyfin = await startJellyfinMock();
  const caa = await startCoverServer(makeJpeg(rig.audioDir, 'cover.jpg', '600x600'));
  const { settings } = rig.h.app.hearer;
  settings.set('metadata', { ...settings.get('metadata'), coverArtBaseUrl: caa.url });
  settings.set('mediaServer', {
    ...settings.get('mediaServer'),
    url: jellyfin.url,
    apiKey: MOCK_API_KEY,
    pathMappings: [{ serverPath: SERVER_MUSIC, localPath: rig.h.musicDir }],
  });
  const importRig: ImportRig = {
    ...rig,
    jellyfin,
    caa,
    hook,
    renameImpl,
    musicDir: rig.h.musicDir,
    stagingDir: rig.h.stagingDir,
    closeAll: async () => {
      await rig.close();
      await jellyfin.close();
      await caa.close();
    },
  };
  return importRig;
}

/** An APPROVED upload with a staged MP3 and these tags. Returns the upload id. */
export async function seedApproved(
  rig: ImportRig,
  options: {
    tags?: Partial<TagSet>;
    name?: string;
    targetRequestId?: string | null;
    seconds?: number;
    frequency?: number;
    uploaderId?: string;
    durationMs?: number;
  } = {},
): Promise<string> {
  const name = options.name ?? 'track.mp3';
  const file = makeAudio(rig.audioDir, `src-${Math.random().toString(36).slice(2)}-${name}`, {
    seconds: options.seconds ?? 2,
    ...(options.frequency === undefined ? {} : { frequency: options.frequency }),
  });
  return seedUpload(rig, {
    uploaderId: options.uploaderId ?? rig.aliceId,
    file,
    originalName: name,
    durationMs: options.durationMs ?? 2000,
    status: 'APPROVED',
    chosenJson: { ...TAGS, ...options.tags },
    targetRequestId: options.targetRequestId ?? null,
    noEnqueue: true,
  });
}

/** Every regular file below `dir`, relative, sorted. */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix))) {
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Seed the other tracks of the OK Computer fixture release as already in the library. */
export function seedOtherTracks(rig: ImportRig, except: string): void {
  const db = rig.h.app.hearer.database.db;
  FIXTURE_TRACKS.filter((id) => id !== except).forEach((id, i) => {
    db.insert(libraryItems)
      .values({
        serverItemId: `jf-${id}`,
        kind: 'track',
        name: `Track ${String(i + 1)}`,
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        durationMs: 200_000,
        mbRecordingId: id,
        mbReleaseGroupId: IDS.releaseGroup,
        mbArtistId: IDS.artist,
        normKey: `radiohead|track ${String(i + 1)}`,
      })
      .run();
  });
}
