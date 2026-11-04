import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_UPLOAD_CHUNK_BYTES,
  Permission,
  TUS_PATH,
  type UploadConfig,
  type UploadDto,
  type UploadListQuery,
  type UploadStatus,
} from '@hearer/shared';
import { and, count, desc, eq, gte, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { hasPermission } from '../auth/permissions.ts';
import type { Db } from '../db/client.ts';
import { requests, uploads, users } from '../db/schema.ts';
import { assertInside, sanitizeFileName } from '../lib/paths.ts';
import type { AuthUser } from './users.ts';
import type { SettingsService } from './settings.ts';

export type UploadRow = typeof uploads.$inferSelect;

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;
/** A RECEIVING upload this old has lost its tus files to cleanup; it no longer counts as in flight. */
export const STALE_RECEIVING_MS = 24 * 3_600_000;
export const MAX_FILE_NAME_CHARS = 255;

/** States in which an upload can still be cancelled (nothing has been imported yet). */
export const CANCELLABLE_STATUSES: readonly UploadStatus[] = [
  'RECEIVING',
  'RECEIVED',
  'ANALYZING',
  'NEEDS_REVIEW',
  'APPROVED',
  'DUPLICATE',
  'FAILED',
];

/** A refusal with an HTTP status; the tus hooks and the REST routes both render it. */
export class UploadRejection extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'UploadRejection';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface UploadMetadata {
  filename: string;
  batchId: string | null;
  targetRequestId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The settings' allowed formats as file extensions (`aif` rides along with `aiff`). */
export function allowedExtensions(formats: readonly string[]): Set<string> {
  const set = new Set(formats.map((f) => f.trim().toLowerCase().replace(/^\./u, '')));
  if (set.has('aiff')) set.add('aif');
  return set;
}

export interface QuotaStatus {
  limitMb: number;
  days: number;
  usedBytes: number;
  remainingBytes: number | null;
  unlimited: boolean;
}

export interface UploadsServiceOptions {
  db: Db;
  settings: SettingsService;
  /** `STAGING_DIR`. */
  stagingDir: string;
  now?: () => number;
}

export class UploadsService {
  readonly #db: Db;
  readonly #settings: SettingsService;
  readonly #now: () => number;
  readonly stagingDir: string;
  /** Where tus keeps in-progress uploads. */
  readonly tmpDir: string;

  constructor(options: UploadsServiceOptions) {
    this.#db = options.db;
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.stagingDir = options.stagingDir;
    this.tmpDir = join(options.stagingDir, 'tmp');
  }

  // --- limits -----------------------------------------------------------------------------

  get maxFileSizeBytes(): number {
    return this.#settings.get('uploads').maxFileSizeMb * MB;
  }

  /** The user's own override, else the general default. `mb` 0 means unlimited. */
  quotaFor(userId: string): { mb: number; days: number } {
    const row = this.#db
      .select({ mb: users.uploadQuotaMb, days: users.uploadQuotaDays })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    const fallback = this.#settings.get('general').defaultUploadQuota;
    return { mb: row?.mb ?? fallback.mb, days: row?.days ?? fallback.days };
  }

  /** Bytes uploaded in the window, in-flight uploads included, rejected/cancelled ones not. */
  usedBytes(userId: string, days: number, db: Db = this.#db): number {
    const now = this.#now();
    const windowStart = new Date(now - days * DAY_MS);
    const staleBefore = new Date(now - STALE_RECEIVING_MS);
    const row = db
      .select({ total: sql<number>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .where(
        and(
          eq(uploads.uploaderId, userId),
          gte(uploads.createdAt, windowStart),
          ne(uploads.status, 'REJECTED'),
          or(ne(uploads.status, 'RECEIVING'), gte(uploads.createdAt, staleBefore)),
        ),
      )
      .get();
    return row?.total ?? 0;
  }

  quotaStatus(user: AuthUser): QuotaStatus {
    const { mb, days } = this.quotaFor(user.id);
    const usedBytes = this.usedBytes(user.id, days);
    const unlimited = mb === 0 || hasPermission(user.permissions, Permission.ADMIN);
    return {
      limitMb: mb,
      days,
      usedBytes,
      unlimited,
      remainingBytes: unlimited ? null : Math.max(0, mb * MB - usedBytes),
    };
  }

  config(user: AuthUser): UploadConfig {
    const settings = this.#settings.get('uploads');
    return {
      tusPath: TUS_PATH,
      maxChunkSizeBytes: MAX_UPLOAD_CHUNK_BYTES,
      maxFileSizeMb: settings.maxFileSizeMb,
      allowedFormats: settings.allowedFormats,
      quota: this.quotaStatus(user),
    };
  }

  // --- creation ---------------------------------------------------------------------------

  /** Validate the decoded `Upload-Metadata`. Throws a 400 `UploadRejection`. */
  parseMetadata(meta: Record<string, string | null | undefined> | undefined): UploadMetadata {
    const filename = meta?.filename;
    if (typeof filename !== 'string' || filename.trim() === '') {
      throw new UploadRejection(400, 'filename_required', 'Upload-Metadata must include filename');
    }
    if (filename.length > MAX_FILE_NAME_CHARS || filename.includes('\0')) {
      throw new UploadRejection(400, 'filename_invalid', 'The file name is too long or invalid');
    }
    const optionalUuid = (key: 'batchId' | 'targetRequestId'): string | null => {
      const value = meta?.[key];
      if (value === undefined || value === null || value === '') return null;
      if (!UUID.test(value)) {
        throw new UploadRejection(400, 'metadata_invalid', `${key} must be a UUID`);
      }
      return value.toLowerCase();
    };
    return {
      filename,
      batchId: optionalUuid('batchId'),
      targetRequestId: optionalUuid('targetRequestId'),
    };
  }

  /**
   * Check everything that can refuse an upload and insert the RECEIVING row, atomically (the
   * quota read and the insert share one transaction, so parallel creates cannot overshoot).
   */
  createReceiving(input: {
    user: AuthUser;
    tusId: string;
    size: number | undefined;
    metadata: UploadMetadata;
  }): UploadRow {
    const { user, tusId, size, metadata } = input;
    if (size === undefined) {
      throw new UploadRejection(400, 'length_required', 'Deferred upload length is not supported');
    }
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new UploadRejection(400, 'length_invalid', 'Upload-Length must be at least 1');
    }
    const { maxFileSizeMb, allowedFormats } = this.#settings.get('uploads');
    if (size > maxFileSizeMb * MB) {
      throw new UploadRejection(
        413,
        'file_too_large',
        `Files may be at most ${String(maxFileSizeMb)} MB`,
      );
    }
    const ext = extensionOf(sanitizeFileName(metadata.filename));
    if (!allowedExtensions(allowedFormats).has(ext)) {
      throw new UploadRejection(
        400,
        'format_not_allowed',
        `Files of type ${ext === '' ? '(none)' : `.${ext}`} are not accepted. Allowed: ${allowedFormats.join(', ')}`,
      );
    }
    return this.#db.transaction((tx) => {
      const { mb, days } = this.quotaFor(user.id);
      if (mb > 0 && !hasPermission(user.permissions, Permission.ADMIN)) {
        const used = this.usedBytes(user.id, days, tx);
        if (used + size > mb * MB) {
          throw new UploadRejection(
            403,
            'quota_exceeded',
            `Upload quota exceeded: ${String(mb)} MB per ${String(days)} day(s)`,
          );
        }
      }
      if (metadata.batchId !== null) {
        const other = tx
          .select({ id: uploads.id })
          .from(uploads)
          .where(and(eq(uploads.batchId, metadata.batchId), ne(uploads.uploaderId, user.id)))
          .limit(1)
          .get();
        if (other) {
          throw new UploadRejection(400, 'batch_invalid', 'That batchId belongs to another user');
        }
      }
      if (metadata.targetRequestId !== null) {
        const found = tx
          .select({ id: requests.id })
          .from(requests)
          .where(eq(requests.id, metadata.targetRequestId))
          .get();
        if (!found) throw new UploadRejection(400, 'metadata_invalid', 'Unknown targetRequestId');
      }
      return tx
        .insert(uploads)
        .values({
          id: randomUUID(),
          tusId,
          uploaderId: user.id,
          originalName: metadata.filename,
          size,
          batchId: metadata.batchId,
          targetRequestId: metadata.targetRequestId,
          status: 'RECEIVING',
        })
        .returning()
        .get();
    });
  }

  // --- lookups ----------------------------------------------------------------------------

  getByTusId(tusId: string): UploadRow | undefined {
    return this.#db.select().from(uploads).where(eq(uploads.tusId, tusId)).get();
  }

  get(id: string): UploadRow | undefined {
    return this.#db.select().from(uploads).where(eq(uploads.id, id)).get();
  }

  getDto(id: string): UploadDto | undefined {
    const row = this.#db
      .select({ upload: uploads, uploaderName: users.username })
      .from(uploads)
      .leftJoin(users, eq(users.id, uploads.uploaderId))
      .where(eq(uploads.id, id))
      .get();
    return row ? toDto(row.upload, row.uploaderName) : undefined;
  }

  list(
    user: AuthUser,
    query: UploadListQuery,
  ): { items: UploadDto[]; total: number; offset: number; limit: number } {
    const filters: SQL[] = [];
    if (query.all !== true) filters.push(eq(uploads.uploaderId, user.id));
    if (query.status) filters.push(eq(uploads.status, query.status));
    if (query.batchId) filters.push(eq(uploads.batchId, query.batchId));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const total = this.#db.select({ n: count() }).from(uploads).where(where).get()?.n ?? 0;
    const rows = this.#db
      .select({ upload: uploads, uploaderName: users.username })
      .from(uploads)
      .leftJoin(users, eq(users.id, uploads.uploaderId))
      .where(where)
      .orderBy(desc(uploads.createdAt), desc(uploads.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return {
      items: rows.map((r) => toDto(r.upload, r.uploaderName)),
      total,
      offset: query.offset,
      limit: query.limit,
    };
  }

  // --- state changes ----------------------------------------------------------------------

  /** RECEIVING to RECEIVED (the last tus byte arrived). False when the row moved on (cancelled). */
  markReceived(tusId: string): UploadRow | undefined {
    return this.#db
      .update(uploads)
      .set({ status: 'RECEIVED' })
      .where(and(eq(uploads.tusId, tusId), eq(uploads.status, 'RECEIVING')))
      .returning()
      .get();
  }

  /** Mark rejected/cancelled when still in a cancellable state. Returns the row, or undefined. */
  reject(id: string, error: string, from: readonly UploadStatus[]): UploadRow | undefined {
    return this.#db
      .update(uploads)
      .set({ status: 'REJECTED', error, stagingPath: null })
      .where(and(eq(uploads.id, id), inArray(uploads.status, [...from])))
      .returning()
      .get();
  }

  /** Cancel an upload in a pre-import state and delete its files. */
  async cancel(id: string): Promise<UploadRow | undefined> {
    const row = this.reject(id, 'cancelled', CANCELLABLE_STATUSES);
    if (row) await this.removeFiles(row);
    return row;
  }

  /** Where an upload's file lives once validated: `<staging>/<uploadId>/<sanitized name>`. */
  stagingPathFor(uploadId: string, originalName: string): string {
    const dir = join(this.stagingDir, uploadId);
    return assertInside(this.stagingDir, join(dir, sanitizeFileName(originalName)));
  }

  /** Delete the tus temp files and the staging directory of an upload. Never touches the library. */
  async removeFiles(row: Pick<UploadRow, 'id' | 'tusId'>): Promise<void> {
    if (row.tusId) {
      const tusFile = assertInside(this.tmpDir, row.tusId);
      await rm(tusFile, { force: true });
      await rm(`${tusFile}.json`, { force: true });
    }
    const dir = assertInside(this.stagingDir, join(this.stagingDir, row.id));
    await rm(dir, { recursive: true, force: true });
  }
}

export function toDto(row: UploadRow, uploaderName: string | null): UploadDto {
  const probe = row.probeJson;
  return {
    id: row.id,
    batchId: row.batchId,
    tusId: row.tusId,
    uploaderId: row.uploaderId,
    uploaderName,
    originalName: row.originalName,
    size: row.size,
    status: row.status,
    sha256: row.sha256,
    format: row.format,
    codec: probe?.codec ?? null,
    durationMs: row.durationMs,
    bitrate: row.bitrate,
    sampleRate: row.sampleRate,
    channels: probe?.channels ?? null,
    targetRequestId: row.targetRequestId,
    libraryPath: row.libraryPath,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
