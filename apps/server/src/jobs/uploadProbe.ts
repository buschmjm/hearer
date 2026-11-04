import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { uploads, type UploadProbe } from '../db/schema.ts';
import {
  FfprobeUnavailableError,
  InvalidMediaError,
  ffprobe,
  type ProbeResult,
  type ProbeStream,
} from '../lib/ffprobe.ts';
import { assertInside } from '../lib/paths.ts';
import { STALE_RECEIVING_MS, extensionOf, type UploadsService } from '../services/uploads.ts';
import { defineJob } from './registry.ts';

export const UPLOAD_PROBE_JOB = 'upload.probe';
export const UPLOAD_EXPIRE_JOB = 'upload.expire';
/** Registered by H-14; the probe job only enqueues it when it exists. */
export const UPLOAD_ANALYZE_JOB = 'upload.analyze';
export const UPLOAD_EXPIRE_INTERVAL_MS = 3_600_000;
export const PROBE_MAX_ATTEMPTS = 3;

/** What each accepted extension must look like to ffprobe. `formats` are demuxer aliases. */
interface FormatRule {
  canonical: string;
  formats: readonly string[];
  codec: (name: string) => boolean;
}
const pcm = (name: string): boolean => name.startsWith('pcm_');
const FORMAT_RULES: Readonly<Record<string, FormatRule>> = {
  flac: { canonical: 'flac', formats: ['flac'], codec: (c) => c === 'flac' },
  mp3: { canonical: 'mp3', formats: ['mp3'], codec: (c) => c === 'mp3' },
  m4a: {
    canonical: 'm4a',
    formats: ['mov', 'mp4', 'm4a'],
    codec: (c) => c === 'aac' || c === 'alac',
  },
  ogg: { canonical: 'ogg', formats: ['ogg'], codec: (c) => ['vorbis', 'opus', 'flac'].includes(c) },
  opus: { canonical: 'opus', formats: ['ogg'], codec: (c) => c === 'opus' },
  wav: { canonical: 'wav', formats: ['wav'], codec: pcm },
  aiff: { canonical: 'aiff', formats: ['aiff'], codec: pcm },
  aif: { canonical: 'aiff', formats: ['aiff'], codec: pcm },
};

export interface ValidatedAudio {
  format: string;
  codec: string;
  durationMs: number;
  bitrate: number | null;
  sampleRate: number | null;
  probe: UploadProbe;
}

/**
 * Decide whether ffprobe's view of a file is acceptable for its extension: at least one audio
 * stream, a positive duration, a codec from the allowlist, and a container that agrees with the
 * extension (a renamed text file never gets this far; a FLAC renamed `.mp3` stops here).
 * Throws `InvalidMediaError` with a message that is safe to show the uploader.
 */
export function validateProbe(result: ProbeResult, extension: string): ValidatedAudio {
  const rule = FORMAT_RULES[extension];
  if (!rule) throw new InvalidMediaError(`.${extension} is not a supported audio type`);
  const audio: ProbeStream | undefined = result.streams.find((s) => s.codecType === 'audio');
  if (!audio) throw new InvalidMediaError('The file contains no audio stream');
  const seconds = result.durationSeconds ?? audio.durationSeconds;
  if (seconds === null || !(seconds > 0)) {
    throw new InvalidMediaError('The audio has no measurable duration');
  }
  const containers = result.formatName.split(',').map((f) => f.trim());
  if (!containers.some((c) => rule.formats.includes(c))) {
    throw new InvalidMediaError(
      `The content is ${result.formatName || 'unknown'}, which does not match .${extension}`,
    );
  }
  if (!rule.codec(audio.codecName)) {
    throw new InvalidMediaError(`Audio codec ${audio.codecName} is not accepted for .${extension}`);
  }
  const bitrate = result.bitRate ?? audio.bitRate;
  return {
    format: rule.canonical,
    codec: audio.codecName,
    durationMs: Math.round(seconds * 1000),
    bitrate: bitrate === null ? null : Math.round(bitrate),
    sampleRate: audio.sampleRate === null ? null : Math.round(audio.sampleRate),
    probe: {
      container: result.formatName,
      codec: audio.codecName,
      channels: audio.channels,
      bitsPerSample: audio.bitsPerSample,
    },
  };
}

/** sha256 of a file, streamed (a 2 GB upload never sits in memory). */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, signal ? { signal } : {});
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Rename, falling back to copy + unlink across filesystems. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

export interface UploadProbeDeps {
  uploads: UploadsService;
  db: Db;
  /** True when a job type is registered (H-14's `upload.analyze` may not be). */
  hasJob: (type: string) => boolean;
  ffprobeBinary?: string;
  ffprobeTimeoutMs?: number;
}

/**
 * `upload.probe`: validate that a fully received tus file is real audio, hash it, move it from
 * the tus temp dir into `<staging>/<uploadId>/<sanitized name>` and record what was learned.
 * Safe to re-run: if a crash happened after the move, the staged file is probed in place.
 */
export function uploadProbeJob(deps: UploadProbeDeps) {
  return defineJob({
    type: UPLOAD_PROBE_JOB,
    payload: z.object({ uploadId: z.uuid() }),
    concurrency: 2,
    maxAttempts: PROBE_MAX_ATTEMPTS,
    timeoutMs: 30 * 60_000,
    async handler({ uploadId }, ctx) {
      const { uploads: service } = deps;
      const row = service.get(uploadId);
      if (row?.status !== 'RECEIVED') {
        ctx.log.info({ uploadId, status: row?.status }, 'upload.probe: nothing to do');
        return;
      }
      const dest = service.stagingPathFor(row.id, row.originalName);
      const source = row.tusId ? assertInside(service.tmpDir, row.tusId) : dest;
      const current = (await exists(source)) ? source : (await exists(dest)) ? dest : null;

      const refuse = async (message: string) => {
        service.reject(row.id, message, ['RECEIVED']);
        await service.removeFiles(row);
        ctx.log.info({ uploadId, reason: message }, 'upload rejected');
      };
      if (current === null) {
        await refuse('The uploaded file is missing');
        return;
      }

      let validated: ValidatedAudio;
      let sha256: string;
      try {
        const info = await stat(current);
        if (info.size !== row.size) {
          throw new InvalidMediaError('The file size does not match what was announced');
        }
        const probed = await ffprobe(current, {
          ...(deps.ffprobeBinary ? { binary: deps.ffprobeBinary } : {}),
          ...(deps.ffprobeTimeoutMs ? { timeoutMs: deps.ffprobeTimeoutMs } : {}),
        });
        validated = validateProbe(probed, extensionOf(dest));
        sha256 = await sha256File(current, ctx.signal);
      } catch (err) {
        if (err instanceof InvalidMediaError) {
          await refuse(err.message);
          return;
        }
        if (err instanceof FfprobeUnavailableError && ctx.attempt >= PROBE_MAX_ATTEMPTS) {
          deps.db
            .update(uploads)
            .set({ status: 'FAILED', error: `Validation could not run: ${err.message}` })
            .where(and(eq(uploads.id, row.id), eq(uploads.status, 'RECEIVED')))
            .run();
          await service.removeFiles(row);
          return;
        }
        throw err; // retried with backoff
      }

      await mkdir(dirname(dest), { recursive: true });
      if (current !== dest) await moveFile(current, dest);
      if (row.tusId) await rm(`${assertInside(service.tmpDir, row.tusId)}.json`, { force: true });

      const updated = deps.db
        .update(uploads)
        .set({
          stagingPath: dest,
          sha256,
          format: validated.format,
          durationMs: validated.durationMs,
          bitrate: validated.bitrate,
          sampleRate: validated.sampleRate,
          probeJson: validated.probe,
          error: null,
        })
        .where(and(eq(uploads.id, row.id), eq(uploads.status, 'RECEIVED')))
        .returning({ id: uploads.id })
        .all();
      if (updated.length === 0) {
        // Cancelled while we were working: do not leave the file behind.
        await service.removeFiles(row);
        return;
      }
      if (deps.hasJob(UPLOAD_ANALYZE_JOB)) {
        ctx.enqueue(UPLOAD_ANALYZE_JOB, { uploadId: row.id }, { uniqueKey: `analyze:${row.id}` });
      }
    },
  });
}

export interface UploadExpireDeps {
  uploads: UploadsService;
  db: Db;
  log: Logger;
  now?: () => number;
}

/**
 * `upload.expire` (hourly): a RECEIVING upload whose tus files are older than 24 h was cleaned
 * up by maintenance (or abandoned). Mark it REJECTED so it stops counting as in flight.
 */
export function uploadExpireJob(deps: UploadExpireDeps) {
  return defineJob({
    type: UPLOAD_EXPIRE_JOB,
    payload: z.object({}).prefault({}),
    concurrency: 1,
    async handler() {
      const now = (deps.now ?? Date.now)();
      const cutoff = now - STALE_RECEIVING_MS;
      const candidates = deps.db
        .select()
        .from(uploads)
        .where(and(eq(uploads.status, 'RECEIVING'), lt(uploads.createdAt, new Date(cutoff))))
        .all();
      let expired = 0;
      for (const row of candidates) {
        const file = row.tusId ? assertInside(deps.uploads.tmpDir, row.tusId) : null;
        const info = file ? await stat(file).catch(() => null) : null;
        if (info && info.mtimeMs >= cutoff) continue; // still receiving bytes
        if (deps.uploads.reject(row.id, 'expired', ['RECEIVING'])) {
          await deps.uploads.removeFiles(row);
          expired += 1;
        }
      }
      if (expired > 0) deps.log.info({ expired }, 'expired stale uploads');
    },
  });
}
