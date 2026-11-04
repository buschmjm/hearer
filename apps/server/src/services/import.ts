/**
 * Import of an approved upload into the library (PLAN upload pipeline steps 5 and 6).
 *
 * `ImportService.run(uploadId)` is the body of the `upload.import` job. It is built to be re-run
 * after a crash at any point, so every step is idempotent and the staged original is deleted only
 * after the destination has been verified (size and sha256):
 *
 *   1. APPROVED (or IMPORTING, when resuming) -> IMPORTING.
 *   2. Copy the staged file to `<staging>/<id>/.work-<name>`, write tags and the cover into the
 *      work file, hash it.
 *   3. Render the destination (`lib/pathTemplate.ts`), then persist `uploads.library_path` and the
 *      import state (work sha256 and size, relative path) in `match_json.import` BEFORE moving.
 *   4. Move into the library (`lib/atomicMove.ts`: rename, or copy + fsync + verify + rename on a
 *      different filesystem). A destination holding the same bytes counts as already imported;
 *      a different file is never overwritten, the next free " (n)" name is used.
 *   5. Announce: provisional `library_items` row (`hearer-upload:<id>`, replaced by the next
 *      library sync that sees the real item), `notifyPathsChanged` (best effort), an incremental
 *      `library.sync` two minutes later, link the request (`fulfillFromUpload`), queue
 *      `requests.availability`, set IMPORTED, emit `upload.imported`, delete the staging folder.
 *
 * Resuming: if the state is saved and the destination already verifies, steps 2 to 4 are skipped;
 * if the work file still matches the saved hash it is reused; otherwise it is rebuilt from the
 * staged original. A staged original that is gone while the destination is not verified is a
 * permanent failure.
 *
 * Errors: `ImportPermanentError` and anything else the pipeline cannot fix by waiting (bad tags,
 * path validation, a broken file) set FAILED with the message and keep the staging folder for an
 * admin retry (`POST /uploads/:id/retry-import`). Other errors are rethrown for the job runner's
 * backoff; on the last attempt they set FAILED too.
 */
import { copyFile, rm, stat, type rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { tagSetSchema, type SettingsValue, type TagSet, type UploadStatus } from '@hearer/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CoverImage as FetchedCover } from '../adapters/metadata/coverart.ts';
import { CoverArtError, fetchFrontCover } from '../adapters/metadata/coverart.ts';
import { MetadataError, type MetadataProvider } from '../adapters/metadata/types.ts';
import type { MediaServerAdapter } from '../adapters/mediaserver/types.ts';
import type { Db } from '../db/client.ts';
import { libraryItems, uploads } from '../db/schema.ts';
import {
  DestinationExistsError,
  MoveVerificationError,
  moveIntoLibrary,
  sha256File,
  type MovePoint,
} from '../lib/atomicMove.ts';
import type { EventBus } from '../lib/events.ts';
import { HttpError } from '../lib/http-error.ts';
import { PathEscapeError, assertInside } from '../lib/paths.ts';
import {
  renderLibraryPath,
  resolveDestination,
  useSinglesTemplate,
  valuesFromTags,
} from '../lib/pathTemplate.ts';
import { TagWriteError, fitCover, writeTags, type CoverImage } from '../lib/tagger.ts';
import type { AvailabilityMatcher } from './availability.ts';
import { AVAILABILITY_JOB, LIBRARY_SYNC_JOB, syncUniqueKey } from '../jobs/librarySync.ts';
import { PROVISIONAL_ID_PREFIX, indexKey, type LibraryService } from './library.ts';
import type { RequestsService } from './requests.ts';
import { UPLOAD_IMPORT_JOB } from './uploadReview.ts';
import type { UploadRow } from './uploads.ts';

export { UPLOAD_IMPORT_JOB };
/** Delay before the follow-up incremental library sync (Jellyfin needs a moment to scan). */
export const POST_IMPORT_SYNC_DELAY_MS = 2 * 60_000;
export const PROVISIONAL_PREFIX = PROVISIONAL_ID_PREFIX;

export const provisionalItemId = (uploadId: string): string => `${PROVISIONAL_PREFIX}${uploadId}`;

/** A failure that waiting will not fix. The upload becomes FAILED immediately. */
export class ImportPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImportPermanentError';
  }
}

/** Named steps, for crash-injection hooks in tests. */
export type ImportPoint =
  | 'started'
  | 'work-copied'
  | 'tags-written'
  | 'state-saved'
  | `move:${MovePoint}`
  | 'moved'
  | 'verified'
  | 'announce:library-item'
  | 'announce:rescan'
  | 'announce:sync-scheduled'
  | 'announce:request'
  | 'announce:availability'
  | 'imported'
  | 'cleaned';

export interface ImportState {
  version: 1;
  /** File name of the work file inside the upload's staging folder. */
  workName: string;
  workSha256: string;
  workSize: number;
  /** Rendered path below the library root, before any collision suffix. */
  relativePath: string;
  /** Absolute destination (collision suffix included). */
  libraryPath: string;
  coverEmbedded: boolean;
}

export interface ImportDeps {
  db: Db;
  settings: {
    get: <K extends 'library' | 'uploads' | 'metadata'>(key: K) => SettingsValue<K>;
  };
  /** `MUSIC_DIR`. */
  musicDir: string;
  /** `STAGING_DIR`. */
  stagingDir: string;
  library: Pick<LibraryService, 'toServerPath'>;
  mediaServer: { isConfigured: () => boolean; get: () => MediaServerAdapter };
  metadata: Pick<MetadataProvider, 'getReleaseGroup'>;
  requests: Pick<RequestsService, 'find' | 'fulfillFromUpload'>;
  availability: Pick<AvailabilityMatcher, 'evaluateRequest' | 'newRun'>;
  events: Pick<EventBus, 'emit'>;
  jobs: {
    enqueue: (
      type: string,
      payload: unknown,
      options?: { uniqueKey?: string; delayMs?: number },
    ) => number;
    registry: { has: (type: string) => boolean };
  };
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  version?: string;
  /** Cover download (tests replace it). */
  fetchCover?: typeof fetchFrontCover;
  ffmpegBinary?: string;
  /** Crash injection: called at each named step; a throw simulates a crash there. */
  hook?: (point: ImportPoint) => void | Promise<void>;
  /** `fs.rename` replacement (tests simulate EXDEV). */
  rename?: typeof rename;
  umask?: number;
  now?: () => number;
}

export interface RunContext {
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

const FILE_EXTENSIONS = new Set(['flac', 'mp3', 'm4a', 'ogg', 'opus', 'wav', 'aiff', 'aif']);
const RESUMABLE: readonly UploadStatus[] = ['APPROVED', 'IMPORTING'];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function exists(path: string): Promise<{ size: number } | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? { size: stats.size } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class ImportService {
  readonly #d: ImportDeps;

  constructor(deps: ImportDeps) {
    this.#d = deps;
  }

  // --- state in uploads.match_json ----------------------------------------------------------

  /** The saved import state, if any (`match_json.import`). */
  readState(row: Pick<UploadRow, 'matchJson'>): ImportState | null {
    const match = row.matchJson;
    if (typeof match !== 'object' || match === null) return null;
    const state = (match as { import?: unknown }).import;
    if (typeof state !== 'object' || state === null) return null;
    const s = state as Partial<ImportState>;
    return s.version === 1 &&
      typeof s.workName === 'string' &&
      typeof s.workSha256 === 'string' &&
      typeof s.workSize === 'number' &&
      typeof s.relativePath === 'string' &&
      typeof s.libraryPath === 'string'
      ? (s as ImportState)
      : null;
  }

  #saveState(id: string, state: ImportState): void {
    const { db } = this.#d;
    db.transaction((tx) => {
      const row = tx.select().from(uploads).where(eq(uploads.id, id)).get();
      const base =
        typeof row?.matchJson === 'object' && row.matchJson !== null
          ? (row.matchJson as Record<string, unknown>)
          : {};
      tx.update(uploads)
        .set({ matchJson: { ...base, import: state }, libraryPath: state.libraryPath })
        .where(eq(uploads.id, id))
        .run();
    });
  }

  async #hook(point: ImportPoint): Promise<void> {
    await this.#d.hook?.(point);
  }

  // --- the job body -------------------------------------------------------------------------

  async run(uploadId: string, ctx: RunContext): Promise<void> {
    const { db, log } = this.#d;
    const row = db.select().from(uploads).where(eq(uploads.id, uploadId)).get();
    if (!row) {
      log.warn({ uploadId }, 'upload.import: the upload no longer exists');
      return;
    }
    if (row.status === 'IMPORTED') {
      // A crash between IMPORTED and the cleanup: finish the cleanup, once the library copy checks out.
      const state = this.readState(row);
      if (state && (await this.#destinationOk(state))) await this.#cleanup(row);
      else
        log.warn({ uploadId }, 'imported upload kept its staging folder: library copy unverified');
      return;
    }
    if (!RESUMABLE.includes(row.status)) {
      log.info({ uploadId, status: row.status }, 'upload.import: nothing to do in this state');
      return;
    }
    try {
      await this.#import(row, ctx);
    } catch (err) {
      const permanent = this.#isPermanent(err);
      if (permanent || ctx.attempt >= ctx.maxAttempts) {
        this.#fail(row, errorMessage(err));
        // Permanent: the runner must not retry. The job wrapper turns this into PermanentJobError.
        throw permanent ? new ImportPermanentError(errorMessage(err), { cause: err }) : err;
      }
      throw err;
    }
  }

  #isPermanent(err: unknown): boolean {
    return (
      err instanceof ImportPermanentError ||
      err instanceof PathEscapeError ||
      err instanceof TagWriteError ||
      err instanceof DestinationExistsError
    );
  }

  #fail(row: UploadRow, message: string): void {
    const failed = this.#d.db
      .update(uploads)
      .set({ status: 'FAILED', error: message })
      .where(and(eq(uploads.id, row.id), inArray(uploads.status, ['APPROVED', 'IMPORTING'])))
      .returning()
      .all()[0];
    this.#d.log.error({ uploadId: row.id, error: message }, 'upload import failed');
    if (failed) {
      this.#d.events.emit('upload.failed', this.#payload(failed, { detail: message }));
    }
  }

  // --- the pipeline -------------------------------------------------------------------------

  async #import(initial: UploadRow, ctx: RunContext): Promise<void> {
    const { db, stagingDir } = this.#d;
    const claimed = db
      .update(uploads)
      .set({ status: 'IMPORTING', error: null })
      .where(and(eq(uploads.id, initial.id), inArray(uploads.status, [...RESUMABLE])))
      .returning()
      .all()[0];
    if (!claimed) return;
    await this.#hook('started');

    const parsed = tagSetSchema.safeParse(claimed.chosenJson);
    if (!parsed.success) {
      throw new ImportPermanentError('The upload has no valid tags to write');
    }
    const tags = parsed.data;
    if (claimed.stagingPath === null) {
      throw new ImportPermanentError('The upload has no staged file');
    }
    const original = assertInside(stagingDir, claimed.stagingPath);

    let state = this.readState(claimed);
    // Resume: the destination of an earlier run already holds the finished file.
    if (state && (await this.#destinationOk(state))) {
      await this.#hook('verified');
    } else {
      state = await this.#prepareAndMove(claimed, tags, original, state, ctx);
      await this.#hook('verified');
    }
    await this.#announce(claimed, tags, state, ctx);
  }

  async #destinationOk(state: ImportState): Promise<boolean> {
    const found = await exists(state.libraryPath);
    return (
      found !== null &&
      found.size === state.workSize &&
      (await sha256File(state.libraryPath)) === state.workSha256
    );
  }

  async #prepareAndMove(
    row: UploadRow,
    tags: TagSet,
    original: string,
    previous: ImportState | null,
    ctx: RunContext,
  ): Promise<ImportState> {
    const { stagingDir, musicDir } = this.#d;
    const ext = extname(original).slice(1).toLowerCase();
    if (!FILE_EXTENSIONS.has(ext)) {
      throw new ImportPermanentError(`Unsupported file type ".${ext}"`);
    }
    const workName = `.work-${basename(original)}`;
    const work = assertInside(stagingDir, join(dirname(original), workName));

    // Reuse the work file of an earlier run only if it still matches what was recorded.
    let reuse = false;
    if (previous?.workName === workName) {
      const found = await exists(work);
      reuse =
        found !== null &&
        found.size === previous.workSize &&
        (await sha256File(work)) === previous.workSha256;
    }

    let workSha256 = previous?.workSha256 ?? '';
    let workSize = previous?.workSize ?? 0;
    let coverEmbedded = previous?.coverEmbedded ?? false;
    if (!reuse) {
      if ((await exists(original)) === null) {
        throw new ImportPermanentError(
          'The staged file is gone and the library copy is not verified; upload it again',
        );
      }
      await rm(work, { force: true });
      await copyFile(original, work);
      await this.#hook('work-copied');
      const cover = await this.#loadCover(row, tags, ctx);
      const written = await writeTags(work, ext, tags, {
        cover,
        ...(this.#d.ffmpegBinary ? { ffmpegBinary: this.#d.ffmpegBinary } : {}),
      });
      coverEmbedded = written.coverEmbedded;
      if (written.method === 'ffmpeg') {
        this.#d.log.warn(
          { uploadId: row.id, reason: written.fallbackReason },
          'tags written with the ffmpeg fallback',
        );
      }
      await this.#hook('tags-written');
      workSha256 = await sha256File(work);
      workSize = (await stat(work)).size;
    }

    const relativePath = await this.#render(tags, ext);
    const target = await resolveDestination(musicDir, relativePath, {
      size: workSize,
      sha256: workSha256,
    });
    const state: ImportState = {
      version: 1,
      workName,
      workSha256,
      workSize,
      relativePath,
      libraryPath: target.path,
      coverEmbedded,
    };
    this.#saveState(row.id, state);
    await this.#hook('state-saved');

    if (target.identical) {
      // The same bytes are already in the library (an earlier run got that far).
      await rm(work, { force: true });
    } else {
      await this.#move(work, state, row.id);
    }
    if (!(await this.#destinationOk(state))) {
      throw new MoveVerificationError('The library file does not match the tagged work file');
    }
    return state;
  }

  async #move(work: string, state: ImportState, id: string): Promise<void> {
    const { musicDir } = this.#d;
    // A different file may have appeared at the destination since it was resolved: pick again.
    for (let attempt = 0; ; attempt++) {
      try {
        await moveIntoLibrary(work, state.libraryPath, {
          root: musicDir,
          expected: { size: state.workSize, sha256: state.workSha256 },
          hook: (point) => this.#hook(`move:${point}`),
          ...(this.#d.rename ? { rename: this.#d.rename } : {}),
          ...(this.#d.umask === undefined ? {} : { umask: this.#d.umask }),
          ...(this.#d.now ? { now: this.#d.now } : {}),
        });
        break;
      } catch (err) {
        if (!(err instanceof DestinationExistsError) || attempt >= 4) throw err;
        const next = await resolveDestination(musicDir, state.relativePath, {
          size: state.workSize,
          sha256: state.workSha256,
        });
        state.libraryPath = next.path;
        this.#saveState(id, state);
      }
    }
    await this.#hook('moved');
  }

  /** The relative library path for these tags (naming or singles template). */
  async #render(tags: TagSet, ext: string): Promise<string> {
    const library = this.#d.settings.get('library');
    const type = await this.#releaseGroupType(tags);
    const template = useSinglesTemplate(tags, type)
      ? library.singlesTemplate
      : library.namingTemplate;
    return renderLibraryPath(template, valuesFromTags(tags, ext));
  }

  /** MusicBrainz primary type of the release group; null when unknown (never fails the import). */
  async #releaseGroupType(tags: TagSet): Promise<string | null> {
    try {
      return (await this.#d.metadata.getReleaseGroup(tags.mbReleaseGroupId)).primaryType;
    } catch (err) {
      if (!(err instanceof MetadataError)) throw err;
      this.#d.log.warn(
        { releaseGroup: tags.mbReleaseGroupId, error: err.message },
        'release group type unavailable; using the album template',
      );
      return null;
    }
  }

  /** The front cover to embed, fitted to `uploads.coverMaxPx`; null to keep the file's own. */
  async #loadCover(row: UploadRow, tags: TagSet, ctx: RunContext): Promise<CoverImage | null> {
    const source = tags.coverSource ?? { type: 'caa' as const, releaseMbid: tags.mbReleaseId };
    if (source.type === 'embedded') return null;
    const { settings, log } = this.#d;
    try {
      const fetched: FetchedCover | null = await (this.#d.fetchCover ?? fetchFrontCover)(
        source.releaseMbid,
        1200,
        {
          baseUrl: settings.get('metadata').coverArtBaseUrl,
          entity: 'release',
          ...(this.#d.version ? { version: this.#d.version } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      if (!fetched) {
        log.info({ uploadId: row.id, release: source.releaseMbid }, 'no cover art available');
        return null;
      }
      return await fitCover(
        { data: fetched.data, mimeType: fetched.contentType },
        settings.get('uploads').coverMaxPx,
        dirname(assertInside(this.#d.stagingDir, row.stagingPath ?? '')),
        this.#d.ffmpegBinary ? { ffmpegBinary: this.#d.ffmpegBinary } : {},
      );
    } catch (err) {
      if (err instanceof CoverArtError && ctx.attempt < ctx.maxAttempts) throw err;
      log.warn({ uploadId: row.id, error: errorMessage(err) }, 'cover art skipped');
      return null;
    }
  }

  // --- announce -----------------------------------------------------------------------------

  #payload(row: UploadRow, extra: Record<string, unknown> = {}) {
    const chosen = tagSetSchema.safeParse(row.chosenJson);
    return {
      uploadId: row.id,
      uploaderId: row.uploaderId,
      batchId: row.batchId,
      originalName: row.originalName,
      title: chosen.success ? chosen.data.title : null,
      artist: chosen.success ? chosen.data.artist : null,
      ...extra,
    };
  }

  async #announce(
    row: UploadRow,
    tags: TagSet,
    state: ImportState,
    ctx: RunContext,
  ): Promise<void> {
    const { db, log, jobs, mediaServer, library } = this.#d;
    const serverPath = library.toServerPath(state.libraryPath);

    this.#upsertProvisional(row, tags, serverPath);
    await this.#hook('announce:library-item');

    if (mediaServer.isConfigured()) {
      try {
        await mediaServer.get().notifyPathsChanged([serverPath]);
      } catch (err) {
        log.warn({ uploadId: row.id, error: errorMessage(err) }, 'media server rescan failed');
      }
    }
    await this.#hook('announce:rescan');

    if (jobs.registry.has(LIBRARY_SYNC_JOB)) {
      jobs.enqueue(
        LIBRARY_SYNC_JOB,
        { mode: 'incremental' },
        { delayMs: POST_IMPORT_SYNC_DELAY_MS, uniqueKey: syncUniqueKey('incremental') },
      );
    }
    await this.#hook('announce:sync-scheduled');

    await this.#linkRequest(row, tags, ctx);
    await this.#hook('announce:request');

    if (jobs.registry.has(AVAILABILITY_JOB)) {
      jobs.enqueue(AVAILABILITY_JOB, {}, { uniqueKey: AVAILABILITY_JOB });
    }
    await this.#hook('announce:availability');

    const done = db
      .update(uploads)
      .set({ status: 'IMPORTED', error: null, libraryPath: state.libraryPath })
      .where(and(eq(uploads.id, row.id), eq(uploads.status, 'IMPORTING')))
      .returning()
      .all()[0];
    if (done) {
      this.#d.events.emit(
        'upload.imported',
        this.#payload(done, {
          libraryPath: state.libraryPath,
          targetRequestId: done.targetRequestId,
        }),
      );
    }
    await this.#hook('imported');
    // The destination was verified above; only now may the staged original go.
    if (!(await this.#destinationOk(state))) {
      throw new MoveVerificationError('The library file vanished before the staging cleanup');
    }
    await this.#cleanup(done ?? row);
  }

  /** The row a library sync will replace with the real item (see `LibraryService.sync`). */
  #upsertProvisional(row: UploadRow, tags: TagSet, serverPath: string): void {
    const values = {
      serverItemId: provisionalItemId(row.id),
      kind: 'track' as const,
      name: tags.title,
      artistName: tags.artist,
      albumName: tags.album,
      durationMs: row.durationMs,
      mbRecordingId: tags.mbRecordingId,
      mbReleaseGroupId: tags.mbReleaseGroupId,
      mbArtistId: tags.mbArtistId,
      normKey: indexKey({ kind: 'track', name: tags.title, artistName: tags.artist }),
      path: serverPath,
      syncedAt: new Date((this.#d.now ?? Date.now)()),
    };
    this.#d.db
      .insert(libraryItems)
      .values(values)
      .onConflictDoUpdate({
        target: libraryItems.serverItemId,
        set: {
          name: sql`excluded.name`,
          artistName: sql`excluded.artist_name`,
          albumName: sql`excluded.album_name`,
          durationMs: sql`excluded.duration_ms`,
          mbRecordingId: sql`excluded.mb_recording_id`,
          mbReleaseGroupId: sql`excluded.mb_release_group_id`,
          mbArtistId: sql`excluded.mb_artist_id`,
          normKey: sql`excluded.norm_key`,
          path: sql`excluded.path`,
          syncedAt: sql`excluded.synced_at`,
        },
      })
      .run();
  }

  /**
   * Link `target_request_id`. A track request is complete with this file. An album request is
   * PARTIALLY_AVAILABLE until the availability matcher finds every track of the representative
   * release in the library (the provisional row above counts), then AVAILABLE. A request that
   * can no longer be fulfilled (cancelled, declined) is left alone.
   */
  async #linkRequest(row: UploadRow, tags: TagSet, ctx: RunContext): Promise<void> {
    const { requests, availability, log } = this.#d;
    if (row.targetRequestId === null) return;
    const request = requests.find(row.targetRequestId);
    if (!request) {
      log.warn({ uploadId: row.id, requestId: row.targetRequestId }, 'target request is gone');
      return;
    }
    if (request.fulfilledByUploadId === row.id && request.status === 'AVAILABLE') return;

    let partial = false;
    let note = 'Fulfilled by an upload';
    if (request.type === 'album') {
      try {
        const result = await availability.evaluateRequest(
          {
            type: 'album',
            mbid: request.mbid,
            title: request.title,
            artistName: request.artistName,
          },
          availability.newRun(ctx.signal),
        );
        partial = result.status !== 'AVAILABLE';
      } catch (err) {
        if (!(err instanceof MetadataError) || ctx.attempt < ctx.maxAttempts) throw err;
        partial = true;
        log.warn({ requestId: request.id, error: err.message }, 'album completeness unknown');
      }
      note = partial
        ? `Imported "${tags.title}"; the album is not complete yet`
        : `Imported "${tags.title}"; the album is complete`;
    }
    try {
      requests.fulfillFromUpload(request.id, row.id, {
        actorId: row.uploaderId,
        partial,
        note,
      });
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 409) throw err;
      log.warn({ requestId: request.id, status: request.status }, 'request could not be fulfilled');
    }
  }

  // --- cleanup ------------------------------------------------------------------------------

  /** Delete `<staging>/<id>` (work file and original). Only called once the library copy verified. */
  async #cleanup(row: UploadRow): Promise<void> {
    const dir = assertInside(this.#d.stagingDir, join(this.#d.stagingDir, row.id));
    await rm(dir, { recursive: true, force: true });
    this.#d.db.update(uploads).set({ stagingPath: null }).where(eq(uploads.id, row.id)).run();
    await this.#hook('cleaned');
  }
}
