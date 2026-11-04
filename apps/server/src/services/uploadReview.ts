import {
  Permission,
  matchResultSchema,
  tagSetSchema,
  type MatchResult,
  type ReviewBody,
  type TagSet,
  type UploadDetail,
  type UploadStatus,
} from '@hearer/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { hasPermission } from '../auth/permissions.ts';
import type { Db } from '../db/client.ts';
import { UPLOAD_ANALYZE_JOB } from '../jobs/uploadProbe.ts';
import { requests, uploads, users } from '../db/schema.ts';
import { HttpError, forbidden, notFound } from '../lib/http-error.ts';
import type { SettingsService } from './settings.ts';
import type { UploadRow, UploadsService } from './uploads.ts';
import type { AuthUser } from './users.ts';

/** Registered by H-15. Until then an approved upload just waits in APPROVED. */
export const UPLOAD_IMPORT_JOB = 'upload.import';

/**
 * The slice of the event bus (H-11) this module uses. The bus may not exist yet; callers pass
 * a getter that returns it when it does.
 */
export interface UploadEventSink {
  emit: (event: string, payload: Record<string, unknown>) => unknown;
}

export interface UploadReviewDeps {
  db: Db;
  uploads: UploadsService;
  settings: Pick<SettingsService, 'get'>;
  jobs: {
    enqueue: (type: string, payload: unknown, options?: { uniqueKey?: string }) => number;
    registry: { has: (type: string) => boolean };
  };
  events: () => UploadEventSink | undefined;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/** States a reviewer can still reject from. */
const REJECTABLE: readonly UploadStatus[] = ['NEEDS_REVIEW', 'DUPLICATE', 'APPROVED', 'FAILED'];
/** States a re-run of the analysis makes sense from. */
const REANALYZABLE: readonly UploadStatus[] = ['NEEDS_REVIEW', 'DUPLICATE', 'FAILED'];
/** A request an upload may fulfil. */
const OPEN_REQUEST_STATUSES = ['AWAITING_UPLOAD', 'PROCESSING', 'APPROVED'];

export class UploadReviewService {
  readonly #deps: UploadReviewDeps;

  constructor(deps: UploadReviewDeps) {
    this.#deps = deps;
  }

  // --- reading ------------------------------------------------------------------------------

  /** What analysis stored, or null when there is nothing (or it predates this format). */
  parseMatch(row: Pick<UploadRow, 'matchJson'>): MatchResult | null {
    const parsed = matchResultSchema.safeParse(row.matchJson);
    return parsed.success ? parsed.data : null;
  }

  parseChosen(row: Pick<UploadRow, 'chosenJson'>): TagSet | null {
    const parsed = tagSetSchema.safeParse(row.chosenJson);
    return parsed.success ? parsed.data : null;
  }

  #isManager(user: AuthUser): boolean {
    return hasPermission(user.permissions, Permission.MANAGE_UPLOADS);
  }

  /** The upload when the caller owns it or manages uploads; 404 otherwise (no existence leak). */
  visibleRow(user: AuthUser, id: string): UploadRow {
    const row = this.#deps.uploads.get(id);
    if (!row || (row.uploaderId !== user.id && !this.#isManager(user))) {
      throw notFound('Upload not found');
    }
    return row;
  }

  canKeep(user: AuthUser, row: UploadRow): boolean {
    if (row.status !== 'DUPLICATE') return false;
    if (this.#isManager(user)) return true;
    return (
      row.uploaderId === user.id &&
      hasPermission(user.permissions, Permission.UPLOAD) &&
      this.#deps.settings.get('uploads').allowDuplicateOverride
    );
  }

  detail(user: AuthUser, id: string): UploadDetail {
    const row = this.visibleRow(user, id);
    const dto = this.#deps.uploads.getDto(row.id);
    if (!dto) throw notFound('Upload not found');
    return {
      ...dto,
      match: this.parseMatch(row),
      chosen: this.parseChosen(row),
      canKeep: this.canKeep(user, row),
    };
  }

  // --- helpers ------------------------------------------------------------------------------

  /** Fire an event if the bus exists. A broken subscriber must never fail the upload. */
  emit(event: string, row: UploadRow, extra: Record<string, unknown> = {}): void {
    const sink = this.#deps.events();
    if (!sink) return;
    const chosen = this.parseChosen(row);
    try {
      sink.emit(event, {
        uploadId: row.id,
        uploaderId: row.uploaderId,
        batchId: row.batchId,
        originalName: row.originalName,
        title: chosen?.title ?? null,
        artist: chosen?.artist ?? null,
        ...extra,
      });
    } catch (err) {
      this.#deps.log.warn({ err, event, uploadId: row.id }, 'upload event handler failed');
    }
  }

  #enqueueImport(id: string): void {
    const { jobs } = this.#deps;
    if (jobs.registry.has(UPLOAD_IMPORT_JOB)) {
      jobs.enqueue(UPLOAD_IMPORT_JOB, { uploadId: id }, { uniqueKey: `import:${id}` });
    }
  }

  /** NEEDS_REVIEW to APPROVED (atomically) and start the import. Undefined when it moved on. */
  #approveRow(id: string): UploadRow | undefined {
    const { db } = this.#deps;
    const row = db
      .update(uploads)
      .set({ status: 'APPROVED', error: null })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'NEEDS_REVIEW')))
      .returning()
      .get() as UploadRow | undefined;
    if (row) this.#enqueueImport(id);
    return row;
  }

  #writeMatch(id: string, match: MatchResult, where: UploadStatus[]): UploadRow | undefined {
    return this.#deps.db
      .update(uploads)
      .set({ matchJson: match })
      .where(and(eq(uploads.id, id), inArray(uploads.status, where)))
      .returning()
      .get();
  }

  /**
   * An upload that finished analysis and is waiting: approve it when the uploader may
   * auto-approve and the top candidate scored high enough, else tell the reviewers once.
   * Safe to call repeatedly (it acts at most once per upload).
   */
  finalize(id: string, options: { allowAuto?: boolean } = {}): void {
    const { db } = this.#deps;
    const row = this.#deps.uploads.get(id);
    if (row?.status !== 'NEEDS_REVIEW') return;
    const match = this.parseMatch(row);
    if (!match || match.notified) return;
    const chosen = this.parseChosen(row);
    const top = match.candidates[0];
    const uploader = db
      .select({ permissions: users.permissions })
      .from(users)
      .where(eq(users.id, row.uploaderId))
      .get();
    const threshold = this.#deps.settings.get('uploads').autoApproveThreshold;
    const eligible =
      options.allowAuto !== false &&
      chosen !== null &&
      top !== undefined &&
      match.duplicate === null &&
      match.kept === null &&
      top.score >= threshold &&
      uploader !== undefined &&
      hasPermission(uploader.permissions, Permission.AUTO_APPROVE_UPLOAD);
    if (eligible) {
      const approved = this.#approveRow(id);
      if (approved)
        this.#writeMatch(id, { ...match, autoApproved: true, notified: true }, [
          'APPROVED',
          'IMPORTING',
          'IMPORTED',
        ]);
      return;
    }
    if (this.#writeMatch(id, { ...match, notified: true }, ['NEEDS_REVIEW'])) {
      this.emit('upload.needs_review', row, { score: top?.score ?? null });
    }
  }

  // --- review actions -----------------------------------------------------------------------

  /** Check that a request can be fulfilled by a file tagged like this. Throws 400 when not. */
  #checkTargetRequest(requestId: string, tags: TagSet): void {
    const bad = (message: string) => new HttpError(400, 'invalid_target_request', message);
    const request = this.#deps.db.select().from(requests).where(eq(requests.id, requestId)).get();
    if (!request) throw bad('That request does not exist');
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) {
      throw bad(`That request is ${request.status}; only open requests can be fulfilled`);
    }
    if (request.type === 'track' && request.mbid !== tags.mbRecordingId) {
      throw bad('The tags describe a different recording than the request asks for');
    }
    if (request.type === 'album' && request.mbid !== tags.mbReleaseGroupId) {
      throw bad('The tags describe a different album than the request asks for');
    }
    if (request.type === 'artist') throw bad('An upload cannot fulfil an artist request');
  }

  /** Store the reviewer's final tags (and the request to fulfil). */
  review(user: AuthUser, id: string, body: ReviewBody): UploadDetail {
    const row = this.visibleRow(user, id);
    if (row.status !== 'NEEDS_REVIEW') {
      throw new HttpError(
        409,
        'not_reviewable',
        `An upload in ${row.status} cannot be edited; only NEEDS_REVIEW can`,
      );
    }
    const match = this.parseMatch(row);
    if (
      body.candidateId !== undefined &&
      !match?.candidates.some((c) => c.id === body.candidateId)
    ) {
      throw new HttpError(400, 'unknown_candidate', 'That candidate is not one of the matches');
    }
    const target = body.targetRequestId === undefined ? row.targetRequestId : body.targetRequestId;
    if (target !== null) this.#checkTargetRequest(target, body.tags);
    const next: MatchResult | null = match
      ? { ...match, chosenCandidateId: body.candidateId ?? null, reviewed: true }
      : null;
    const updated = this.#deps.db
      .update(uploads)
      .set({
        chosenJson: body.tags,
        targetRequestId: target,
        ...(next ? { matchJson: next } : {}),
      })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'NEEDS_REVIEW')))
      .returning({ id: uploads.id })
      .all();
    if (updated.length === 0) {
      throw new HttpError(409, 'not_reviewable', 'The upload changed state; reload and try again');
    }
    return this.detail(user, id);
  }

  #mayApprove(user: AuthUser, row: UploadRow): boolean {
    return (
      this.#isManager(user) ||
      (row.uploaderId === user.id &&
        hasPermission(user.permissions, Permission.AUTO_APPROVE_UPLOAD))
    );
  }

  approve(user: AuthUser, id: string): UploadDetail {
    const row = this.visibleRow(user, id);
    if (!this.#mayApprove(user, row)) throw forbidden();
    this.#approveChecked(row);
    return this.detail(user, id);
  }

  #approveChecked(row: UploadRow): void {
    if (row.status !== 'NEEDS_REVIEW') {
      throw new HttpError(409, 'not_approvable', `An upload in ${row.status} cannot be approved`);
    }
    if (this.parseChosen(row) === null) {
      throw new HttpError(409, 'no_tags', 'Choose or enter the tags before approving');
    }
    if (!this.#approveRow(row.id)) {
      throw new HttpError(409, 'not_approvable', 'The upload changed state; reload and try again');
    }
  }

  async reject(user: AuthUser, id: string, reason: string): Promise<UploadDetail> {
    const row = this.visibleRow(user, id);
    const rejected = this.#deps.uploads.reject(row.id, reason, REJECTABLE);
    if (!rejected) {
      throw new HttpError(409, 'not_rejectable', `An upload in ${row.status} cannot be rejected`);
    }
    await this.#deps.uploads.removeFiles(row);
    return this.detail(user, id);
  }

  /** "Keep as alternate version": a duplicate goes back to review. */
  keep(user: AuthUser, id: string, reason: string | undefined): UploadDetail {
    const row = this.visibleRow(user, id);
    if (row.status !== 'DUPLICATE') {
      throw new HttpError(409, 'not_duplicate', 'Only duplicates can be kept');
    }
    if (!this.canKeep(user, row)) throw forbidden('You may not override duplicate detection');
    const match = this.parseMatch(row);
    if (!match) throw new HttpError(409, 'not_duplicate', 'This duplicate has no analysis to keep');
    const kept: MatchResult = {
      ...match,
      kept: { by: user.id, reason: reason ?? null, at: new Date().toISOString() },
      notified: false,
    };
    const updated = this.#deps.db
      .update(uploads)
      .set({ status: 'NEEDS_REVIEW', error: null, matchJson: kept })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'DUPLICATE')))
      .returning({ id: uploads.id })
      .all();
    if (updated.length === 0) throw new HttpError(409, 'not_duplicate', 'The upload changed state');
    this.finalize(id, { allowAuto: false });
    return this.detail(user, id);
  }

  /** Run the analysis again (new AcoustID key, a MusicBrainz fix). Keeps a duplicate override. */
  reanalyze(user: AuthUser, id: string): UploadDetail {
    const row = this.visibleRow(user, id);
    if (!REANALYZABLE.includes(row.status)) {
      throw new HttpError(
        409,
        'not_reanalyzable',
        `An upload in ${row.status} cannot be re-analyzed`,
      );
    }
    if (row.stagingPath === null) {
      throw new HttpError(409, 'not_reanalyzable', 'The staged file is gone; upload it again');
    }
    const updated = this.#deps.db
      .update(uploads)
      .set({ status: 'RECEIVED', error: null })
      .where(and(eq(uploads.id, id), eq(uploads.status, row.status)))
      .returning({ id: uploads.id })
      .all();
    if (updated.length === 0)
      throw new HttpError(409, 'not_reanalyzable', 'The upload changed state');
    this.#deps.jobs.enqueue(UPLOAD_ANALYZE_JOB, { uploadId: id }, { uniqueKey: `analyze:${id}` });
    return this.detail(user, id);
  }

  /** Approve every reviewable file of an album at once. */
  batchApprove(
    user: AuthUser,
    batchId: string,
  ): { approved: string[]; skipped: { id: string; reason: string }[] } {
    const rows = this.#deps.db.select().from(uploads).where(eq(uploads.batchId, batchId)).all();
    const visible = rows.filter((r) => r.uploaderId === user.id || this.#isManager(user));
    if (visible.length === 0) throw notFound('Batch not found');
    if (!visible.every((r) => this.#mayApprove(user, r))) throw forbidden();
    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const row of visible) {
      try {
        this.#approveChecked(row);
        approved.push(row.id);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        skipped.push({ id: row.id, reason: err.message });
      }
    }
    return { approved, skipped };
  }
}
