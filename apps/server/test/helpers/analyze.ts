import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permission, type MatchResult, type TagSet } from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { RateLimiter } from '../../src/lib/ratelimit.ts';
import { uploads } from '../../src/db/schema.ts';
import { sha256File } from '../../src/jobs/uploadProbe.ts';
import {
  addUser,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './auth.ts';
import { AcoustIdMock, acoustIdOk } from './acoustIdServer.ts';
import { FixtureServer, IDS, fixture } from './mbServer.ts';
import { waitFor } from './uploads.ts';

export const SUBTERRANEAN = 'bd82738d-163c-4b1a-bfaf-7acffe30e68a';

export interface AudioOptions {
  seconds: number;
  tags?: Record<string, string>;
  /** Sine frequency; different values give different fingerprints. */
  frequency?: number;
}

/** A small mono WAV or MP3 with optional tags (generated, nothing is committed). */
export function makeAudio(dir: string, name: string, options: AudioOptions): string {
  const out = join(dir, name);
  const metadata = Object.entries(options.tags ?? {}).flatMap(([k, v]) => [
    '-metadata',
    `${k}=${v}`,
  ]);
  const codec = name.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '32k'] : ['-c:a', 'pcm_u8'];
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${String(options.frequency ?? 440)}:duration=${String(options.seconds)}:sample_rate=8000`,
      '-ac',
      '1',
      ...codec,
      ...metadata,
      out,
    ],
    { stdio: 'pipe' },
  );
  return out;
}

export interface MbScenario {
  /** Recording ids the tag search returns. */
  search?: string[];
  /** Per recording id: how `recording/<id>` looks. Unlisted ids get the fixture as it is. */
  recordings?: Record<string, { title: string; length: number }>;
}

/** Make the MusicBrainz fixture server answer for specific recordings. */
export function installMb(server: FixtureServer, scenario: MbScenario): void {
  server.override = (req) => {
    const [entity, id] = req.path.split('/');
    if (entity === 'recording' && !id && scenario.search) {
      const base = JSON.parse(fixture('search-recording')) as {
        recordings: Record<string, unknown>[];
      };
      const template = base.recordings[0] ?? {};
      return {
        body: JSON.stringify({
          count: scenario.search.length,
          recordings: scenario.search.map((rid) => ({
            ...template,
            id: rid,
            title: scenario.recordings?.[rid]?.title ?? 'Paranoid Android',
            length: scenario.recordings?.[rid]?.length ?? 384_000,
          })),
        }),
      };
    }
    if (entity === 'recording' && id && scenario.recordings?.[id]) {
      const base = JSON.parse(fixture('recording')) as Record<string, unknown>;
      const spec = scenario.recordings[id];
      return { body: JSON.stringify({ ...base, id, title: spec.title, length: spec.length }) };
    }
    return undefined;
  };
}

export interface Rig {
  h: Harness;
  mb: FixtureServer;
  acoust: AcoustIdMock;
  admin: Credentials;
  /** UPLOAD only. */
  alice: Credentials;
  aliceId: string;
  /** UPLOAD + AUTO_APPROVE_UPLOAD. */
  trusted: Credentials;
  trustedId: string;
  /** UPLOAD + MANAGE_UPLOADS. */
  manager: Credentials;
  managerId: string;
  bob: Credentials;
  bobId: string;
  audioDir: string;
  /** Upload ids the stub `upload.import` job received. */
  imports: string[];
  close: () => Promise<void>;
}

export async function startRig(
  options: {
    startJobs?: boolean;
    withImportJob?: boolean;
    /** Keep the real `upload.import` job (H-15 tests) instead of the recording stub. */
    realImport?: boolean;
    deps?: Parameters<typeof createHarness>[0];
  } = {},
): Promise<Rig> {
  const mb = await FixtureServer.start();
  const acoust = await AcoustIdMock.start();
  const h = await createHarness({
    ...options.deps,
    deps: {
      startJobs: options.startJobs ?? true,
      jobs: { pollIntervalMs: 20 },
      metadataOptions: { limiter: new RateLimiter({ intervalMs: 0 }), backoffMs: 1, maxRetries: 0 },
      uploadAnalyze: { acoustIdLimiter: new RateLimiter({ intervalMs: 0 }) },
      ...options.deps?.deps,
    },
  });
  h.app.hearer.settings.set('metadata', {
    musicBrainzBaseUrl: mb.baseUrl,
    acoustIdBaseUrl: acoust.baseUrl,
    acoustIdApiKey: 'test-key',
  });
  acoust.respond = () => ({
    body: acoustIdOk([{ id: IDS.recording, rg: IDS.releaseGroup }]),
  });
  const admin = await completeSetup(h);
  const base = Permission.REQUEST | Permission.UPLOAD;
  const aliceId = await addUser(h.app, 'alice', base);
  const trustedId = await addUser(h.app, 'trusted', base | Permission.AUTO_APPROVE_UPLOAD);
  const managerId = await addUser(h.app, 'manager', base | Permission.MANAGE_UPLOADS);
  const bobId = await addUser(h.app, 'bob', base);
  const imports: string[] = [];
  // H-15 registers the real `upload.import`; the analyze tests only need to see that it was queued.
  const importJob = h.app.hearer.jobs.registry.get('upload.import');
  if (importJob && !options.realImport) {
    importJob.handler = (payload) => {
      if (options.withImportJob) imports.push((payload as { uploadId: string }).uploadId);
    };
  }
  const audioDir = mkdtempSync(join(tmpdir(), 'hearer-rig-'));
  return {
    h,
    mb,
    acoust,
    admin,
    alice: await login(h.app, 'alice'),
    aliceId,
    trusted: await login(h.app, 'trusted'),
    trustedId,
    manager: await login(h.app, 'manager'),
    managerId,
    bob: await login(h.app, 'bob'),
    bobId,
    audioDir,
    imports,
    close: async () => {
      await h.cleanup();
      await mb.stop();
      await acoust.stop();
      rmSync(audioDir, { recursive: true, force: true });
    },
  };
}

export interface SeedOptions {
  uploaderId: string;
  file: string;
  durationMs: number;
  originalName?: string;
  batchId?: string | null;
  status?: (typeof uploads.$inferInsert)['status'];
  sha256?: string;
  createdAt?: Date;
  targetRequestId?: string | null;
  /** Skip enqueueing the analyze job. */
  noEnqueue?: boolean;
  matchJson?: MatchResult | null;
  chosenJson?: TagSet | null;
}

/** Stage a file as the probe job would have (staging/<id>/<name>, sha256 set) and queue analysis. */
export async function seedUpload(rig: Rig, options: SeedOptions): Promise<string> {
  const id = randomUUID();
  const name = options.originalName ?? 'track.wav';
  const { service } = { service: rig.h.app.hearer.uploads };
  const dest = service.stagingPathFor(id, name);
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(options.file, dest);
  const status = options.status ?? 'RECEIVED';
  rig.h.app.hearer.database.db
    .insert(uploads)
    .values({
      id,
      uploaderId: options.uploaderId,
      originalName: name,
      stagingPath: dest,
      size: statSync(dest).size,
      sha256: options.sha256 ?? (await sha256File(dest)),
      format: 'wav',
      durationMs: options.durationMs,
      status,
      batchId: options.batchId ?? null,
      targetRequestId: options.targetRequestId ?? null,
      matchJson: options.matchJson ?? null,
      chosenJson: options.chosenJson ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .run();
  if (status === 'RECEIVED' && !options.noEnqueue) {
    rig.h.app.hearer.jobs.enqueue(
      'upload.analyze',
      { uploadId: id },
      { uniqueKey: `analyze:${id}` },
    );
  }
  return id;
}

export const rowOf = (rig: Rig, id: string) =>
  rig.h.app.hearer.database.db.select().from(uploads).where(eq(uploads.id, id)).get();

const SETTLED = ['NEEDS_REVIEW', 'APPROVED', 'DUPLICATE', 'FAILED', 'REJECTED', 'IMPORTED'];

/** Wait until analysis has finished with the upload (any resting state). */
export async function settled(rig: Rig, id: string) {
  return waitFor(() => {
    const row = rowOf(rig, id);
    return row && SETTLED.includes(row.status) ? row : null;
  });
}
