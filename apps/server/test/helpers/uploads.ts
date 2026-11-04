import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Upload, type UploadOptions } from 'tus-js-client';
import type { AppDeps } from '../../src/app.ts';
import {
  addUser,
  completeSetup,
  createHarness,
  login,
  ROLES,
  type Credentials,
  type Harness,
} from './auth.ts';

/** Audio is generated at test time with ffmpeg (nothing licensed is committed). */
export interface AudioFixtures {
  dir: string;
  /** name -> absolute path. */
  files: Record<'flac' | 'mp3' | 'ogg' | 'opus' | 'wav' | 'aiff' | 'm4a' | 'bigWav', string>;
  cleanup: () => void;
}

const ENCODERS: Record<string, string[]> = {
  flac: ['-c:a', 'flac'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'],
  ogg: ['-c:a', 'libvorbis'],
  opus: ['-c:a', 'libopus'],
  wav: ['-c:a', 'pcm_s16le'],
  aiff: ['-c:a', 'pcm_s16be'],
  m4a: ['-c:a', 'aac', '-b:a', '96k'],
};

export function makeAudioFixtures(): AudioFixtures {
  const dir = mkdtempSync(join(tmpdir(), 'hearer-audio-'));
  const files = {} as AudioFixtures['files'];
  const run = (out: string, seconds: number, extra: string[]) => {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${String(seconds)}`,
        ...extra,
        out,
      ],
      { stdio: 'pipe' },
    );
  };
  for (const [ext, args] of Object.entries(ENCODERS)) {
    const out = join(dir, `sine.${ext}`);
    run(out, 3, args);
    files[ext as 'flac'] = out;
  }
  // ~5 MB of PCM, large enough to interrupt mid-transfer.
  const big = join(dir, 'big.wav');
  run(big, 30, ['-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le']);
  files.bigWav = big;
  return {
    dir,
    files,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface UploadHarness {
  h: Harness;
  base: string;
  tusUrl: string;
  admin: Credentials;
  alice: Credentials;
  bob: Credentials;
  aliceId: string;
  bobId: string;
  close: () => Promise<void>;
}

/** A real listening server (port 0) with the job runner on, an admin, and two uploaders. */
export async function startUploadHarness(
  deps: Omit<AppDeps, 'auth' | 'startJobs'> = {},
  env: Record<string, string> = {},
): Promise<UploadHarness> {
  const h = await createHarness({
    env,
    deps: { startJobs: true, jobs: { pollIntervalMs: 20 }, ...deps },
  });
  const admin = await completeSetup(h);
  const aliceId = await addUser(h.app, 'alice', ROLES.user);
  const bobId = await addUser(h.app, 'bob', ROLES.user);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = h.app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  return {
    h,
    base,
    tusUrl: `${base}/api/v1/uploads/tus`,
    admin,
    alice: await login(h.app, 'alice'),
    bob: await login(h.app, 'bob'),
    aliceId,
    bobId,
    close: () => h.cleanup(),
  };
}

export const authHeaders = (creds: Credentials, method = 'POST'): Record<string, string> => ({
  cookie: creds.cookie,
  ...(method === 'GET' || method === 'HEAD' ? {} : { 'x-csrf-token': creds.csrf }),
});

/** Poll until `check` returns a truthy value (job runner and filesystem work are asynchronous). */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  timeoutMs = 15_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
export const tusMetadata = (meta: Record<string, string>): string =>
  Object.entries(meta)
    .map(([k, v]) => `${k} ${b64(v)}`)
    .join(',');

/** Create a tus upload with a raw POST; returns the response and the new upload's URL path. */
export async function tusCreate(
  ctx: UploadHarness,
  creds: Credentials,
  length: number | string,
  meta: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; location: string | null }> {
  const res = await fetch(ctx.tusUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(creds),
      'tus-resumable': '1.0.0',
      'upload-length': String(length),
      ...(Object.keys(meta).length > 0 ? { 'upload-metadata': tusMetadata(meta) } : {}),
      ...extraHeaders,
    },
  });
  const loc = res.headers.get('location');
  return { res, location: loc === null ? null : new URL(loc, ctx.base).toString() };
}

/** Run a complete tus-js-client upload of `path` and resolve with the finished upload URL. */
export function tusUpload(
  ctx: UploadHarness,
  creds: Credentials,
  path: string,
  options: {
    filename: string;
    chunkSize?: number;
    metadata?: Record<string, string>;
    uploadUrl?: string;
  } & Partial<UploadOptions>,
): Promise<{ url: string; uploadId: string | null }> {
  const { filename, chunkSize, metadata, uploadUrl, ...rest } = options;
  const body = readFileSync(path);
  return new Promise((resolve, reject) => {
    const upload = new Upload(body, {
      endpoint: ctx.tusUrl,
      ...(uploadUrl ? { uploadUrl } : {}),
      chunkSize: chunkSize ?? 1024 * 1024,
      retryDelays: null,
      headers: authHeaders(creds),
      metadata: { filename, ...metadata },
      removeFingerprintOnSuccess: true,
      onError: reject,
      onSuccess: (payload) => {
        resolve({
          url: upload.url ?? '',
          uploadId: payload.lastResponse.getHeader('x-hearer-upload-id') ?? null,
        });
      },
      ...rest,
    });
    upload.start();
  });
}

export function writeJunk(dir: string, name: string, bytes: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 'This is not audio. '));
  return path;
}
