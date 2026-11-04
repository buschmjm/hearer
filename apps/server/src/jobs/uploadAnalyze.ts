import { stat } from 'node:fs/promises';
import type { MatchResult, TagSet } from '@hearer/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  AcoustIdError,
  type AcoustIdClient,
  type AcoustIdRecording,
} from '../adapters/metadata/acoustid.ts';
import { MetadataError } from '../adapters/metadata/types.ts';
import type { Db } from '../db/client.ts';
import { uploads } from '../db/schema.ts';
import { emptyTags, readExistingTags } from '../lib/audioTags.ts';
import { FpcalcError, FpcalcUnavailableError, fpcalc, type Fingerprint } from '../lib/fpcalc.ts';
import { assertInside } from '../lib/paths.ts';
import type { DuplicateChecker, FileFacts, MatchingService } from '../services/matching.ts';
import type { UploadRow, UploadsService } from '../services/uploads.ts';
import type { UploadReviewService } from '../services/uploadReview.ts';
import { defineJob } from './registry.ts';
import { UPLOAD_ANALYZE_JOB } from './uploadProbe.ts';

export { UPLOAD_ANALYZE_JOB };
export const ANALYZE_MAX_ATTEMPTS = 3;

export interface UploadAnalyzeDeps {
  db: Db;
  uploads: UploadsService;
  review: UploadReviewService;
  matching: MatchingService;
  duplicates: DuplicateChecker;
  acoustId: AcoustIdClient;
  fpcalcBinary?: string;
  fpcalcTimeoutMs?: number;
}

const IN_FLIGHT = ['RECEIVING', 'RECEIVED', 'ANALYZING'] as const;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Failures worth another attempt: the outside world was unavailable. */
function isTransient(err: unknown): boolean {
  if (err instanceof MetadataError) return err.kind !== 'not_found';
  if (err instanceof AcoustIdError) return err.kind === 'unavailable';
  return false;
}

/**
 * `upload.analyze` (PLAN upload pipeline steps 2 to 4). RECEIVED to ANALYZING, then:
 * duplicate check by sha256, tags, fingerprint, AcoustID, MusicBrainz candidates and scoring,
 * duplicate check by recording / fuzzy key, and finally NEEDS_REVIEW (or DUPLICATE). The last
 * file of a batch also groups the album and settles auto-approval for the whole batch.
 *
 * MusicBrainz and AcoustID outages throw so the runner retries with backoff; on the last
 * attempt AcoustID trouble is tolerated (tag matching still works) but a MusicBrainz outage
 * marks the upload FAILED. A reviewer can re-run it from FAILED with `POST /uploads/:id/reanalyze`.
 */
export function uploadAnalyzeJob(deps: UploadAnalyzeDeps) {
  const { db, uploads: service, review, matching, duplicates, acoustId } = deps;

  const fail = (row: UploadRow, message: string) => {
    db.update(uploads)
      .set({ status: 'FAILED', error: message })
      .where(and(eq(uploads.id, row.id), eq(uploads.status, 'ANALYZING')))
      .run();
  };

  /** The fingerprint, or the reason there is none (a missing fpcalc is not fatal). */
  async function fingerprint(path: string): Promise<Fingerprint | Error> {
    try {
      return await fpcalc(path, {
        ...(deps.fpcalcBinary ? { binary: deps.fpcalcBinary } : {}),
        ...(deps.fpcalcTimeoutMs ? { timeoutMs: deps.fpcalcTimeoutMs } : {}),
      });
    } catch (err) {
      if (err instanceof FpcalcUnavailableError || err instanceof FpcalcError) {
        return err;
      }
      throw err;
    }
  }

  async function lookupAcoustId(
    print: Fingerprint,
    attempt: number,
    signal: AbortSignal,
  ): Promise<{ recordings: AcoustIdRecording[]; status: MatchResult['acoustId'] }> {
    try {
      const result = await acoustId.lookup(print.fingerprint, print.duration, { signal });
      if (result.status === 'disabled') {
        return {
          recordings: [],
          status: { status: 'disabled', message: 'No AcoustID API key is configured' },
        };
      }
      return {
        recordings: result.recordings,
        status:
          result.recordings.length > 0
            ? { status: 'matched', message: null }
            : { status: 'no_match', message: 'AcoustID does not know this recording' },
      };
    } catch (err) {
      if (!(err instanceof AcoustIdError)) throw err;
      // Transient trouble is retried; on the last attempt (or for a bad key) carry on without it.
      if (err.kind === 'unavailable' && attempt < ANALYZE_MAX_ATTEMPTS) throw err;
      return { recordings: [], status: { status: 'error', message: err.message } };
    }
  }

  /** Write the outcome of an analysis. Returns false when the upload left ANALYZING meanwhile. */
  function persist(
    row: UploadRow,
    values: Partial<typeof uploads.$inferInsert>,
  ): UploadRow | undefined {
    return db
      .update(uploads)
      .set(values)
      .where(and(eq(uploads.id, row.id), eq(uploads.status, 'ANALYZING')))
      .returning()
      .get();
  }

  async function analyze(row: UploadRow, attempt: number, signal: AbortSignal): Promise<void> {
    if (row.stagingPath === null) throw new Error('The staged file is missing');
    const path = assertInside(service.stagingDir, row.stagingPath);
    if (
      !(await stat(path).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new Error('The staged file is missing');
    }
    const previous = review.parseMatch(row);
    const kept = previous?.kept ?? null;
    const base = (partial: Partial<MatchResult>): MatchResult => ({
      version: 1,
      analyzedAt: new Date().toISOString(),
      durationMs: row.durationMs,
      existingTags: previous?.existingTags ?? emptyTags(),
      acoustId: { status: 'no_fingerprint', message: null },
      candidates: [],
      group: null,
      duplicate: null,
      kept,
      chosenCandidateId: null,
      autoApproved: false,
      reviewed: false,
      notified: false,
      ...partial,
    });

    // (a) The very same bytes, before any network work.
    if (kept === null) {
      const same = duplicates.bySha256({
        uploadId: row.id,
        sha256: row.sha256,
        createdAt: row.createdAt,
      });
      if (same) {
        const tags = await readExistingTags(path);
        const result = persist(row, {
          status: 'DUPLICATE',
          error: same.message,
          matchJson: base({ existingTags: tags, duplicate: same }),
        });
        if (result) review.emit('upload.duplicate', result, { reason: same.kind });
        return;
      }
    }

    const tags = await readExistingTags(path);
    const facts: FileFacts = { durationMs: row.durationMs, tags };

    let acoust: { recordings: AcoustIdRecording[]; status: MatchResult['acoustId'] } = {
      recordings: [],
      status: { status: 'no_fingerprint', message: null },
    };
    let stored: string | null = row.fingerprint;
    const print = await fingerprint(path);
    if (print instanceof Error) {
      acoust.status = { status: 'no_fingerprint', message: print.message };
    } else {
      stored = print.fingerprint;
      acoust = await lookupAcoustId(print, attempt, signal);
    }

    const candidates = await matching.match(facts, acoust.recordings, { signal });
    const top = candidates[0];

    // (b) and (c) against the library index, using the best identification we have.
    let duplicate = null;
    if (kept === null) {
      duplicate = duplicates.byLibrary({
        recordingMbid: top?.recordingMbid ?? tags.mbRecordingId,
        artists: [top?.artist, top?.tags.albumArtist, tags.artist, tags.albumArtist].filter(
          (v): v is string => typeof v === 'string' && v !== '',
        ),
        title: top?.title ?? tags.title,
        durationMs: row.durationMs,
      });
    }
    const match = base({
      existingTags: tags,
      acoustId: acoust.status,
      candidates,
      duplicate,
      chosenCandidateId: top?.id ?? null,
    });
    const chosen: TagSet | null = top?.tags ?? null;
    if (duplicate) {
      const result = persist(row, {
        status: 'DUPLICATE',
        error: duplicate.message,
        fingerprint: stored,
        matchJson: match,
        chosenJson: chosen,
      });
      if (result) review.emit('upload.duplicate', result, { reason: duplicate.kind });
      return;
    }
    const saved = persist(row, {
      status: 'NEEDS_REVIEW',
      error: null,
      fingerprint: stored,
      matchJson: match,
      chosenJson: chosen,
    });
    if (!saved) return; // cancelled meanwhile
    await settle(saved, signal);
  }

  /**
   * A file finished analysis. Files outside a batch are finalized at once; in a batch the last
   * file to finish groups the album first, so auto-approval sees the settled release.
   */
  async function settle(row: UploadRow, signal: AbortSignal): Promise<void> {
    if (row.batchId === null) {
      review.finalize(row.id);
      return;
    }
    const members = db.select().from(uploads).where(eq(uploads.batchId, row.batchId)).all();
    if (members.some((m) => (IN_FLIGHT as readonly string[]).includes(m.status))) return;
    const candidates = members.flatMap((m) => {
      if (m.status !== 'NEEDS_REVIEW') return [];
      const match = review.parseMatch(m);
      if (!match || match.reviewed || match.candidates.length === 0) return [];
      return [{ row: m, match }];
    });
    if (candidates.length >= 2) {
      const outcome = await matching.group(
        candidates.map(({ row: m, match }) => ({
          uploadId: m.id,
          facts: { durationMs: m.durationMs, tags: match.existingTags },
          candidates: match.candidates,
        })),
        { signal },
      );
      for (const { row: m } of candidates) {
        const updated = outcome.updated.get(m.id);
        if (!updated) continue;
        applyGroup(m.id, updated, outcome.group);
      }
    }
    for (const m of members) review.finalize(m.id);
  }

  /** Store re-ranked candidates for one batch member (skipped if it was reviewed or moved on). */
  function applyGroup(
    id: string,
    candidates: MatchResult['candidates'],
    group: MatchResult['group'],
  ): void {
    const row = service.get(id);
    if (row?.status !== 'NEEDS_REVIEW') return;
    const match = review.parseMatch(row);
    const top = candidates[0];
    if (!match || match.reviewed || !top) return;
    db.update(uploads)
      .set({
        matchJson: { ...match, candidates, group, chosenCandidateId: top.id },
        chosenJson: top.tags,
      })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'NEEDS_REVIEW')))
      .run();
  }

  return defineJob({
    type: UPLOAD_ANALYZE_JOB,
    payload: z.object({ uploadId: z.uuid() }),
    concurrency: 2,
    maxAttempts: ANALYZE_MAX_ATTEMPTS,
    timeoutMs: 15 * 60_000,
    async handler({ uploadId }, ctx) {
      const current = service.get(uploadId);
      if (!current || (current.status !== 'RECEIVED' && current.status !== 'ANALYZING')) {
        ctx.log.info({ uploadId, status: current?.status }, 'upload.analyze: nothing to do');
        return;
      }
      const row = db
        .update(uploads)
        .set({ status: 'ANALYZING', error: null })
        .where(and(eq(uploads.id, uploadId), inArray(uploads.status, ['RECEIVED', 'ANALYZING'])))
        .returning()
        .get() as UploadRow | undefined;
      if (!row) return;
      try {
        await analyze(row, ctx.attempt, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) throw err; // shutdown or timeout: the runner decides
        if (isTransient(err) && ctx.attempt < ANALYZE_MAX_ATTEMPTS) throw err;
        ctx.log.error({ err, uploadId }, 'upload.analyze failed');
        fail(row, `Analysis failed: ${errorMessage(err)}`);
      }
    },
  });
}
