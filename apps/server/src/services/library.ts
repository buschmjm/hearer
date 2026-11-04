import type { LibraryItemKind, SettingsValue } from '@hearer/shared';
import { count, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { z } from 'zod';
import type { LibraryItem, MediaServerAdapter } from '../adapters/mediaserver/types.ts';
import type { Db } from '../db/client.ts';
import { libraryItems, settings } from '../db/schema.ts';
import { normKey, normalizeArtist } from '../lib/normalize.ts';

export type SyncMode = 'incremental' | 'full';

/**
 * `server_item_id` prefix of the provisional rows the upload import (H-15) writes so badges and
 * request availability update before the media server has scanned the new file. A sync never
 * sweeps them as "not seen"; it removes one once a real item has the same path or recording id,
 * or after `PROVISIONAL_MAX_AGE_MS` when the file never showed up.
 */
export const PROVISIONAL_ID_PREFIX = 'hearer-upload:';
export const PROVISIONAL_MAX_AGE_MS = 7 * 24 * 3_600_000;

/**
 * Sync state lives in the `settings` table under an internal key. It is deliberately NOT part of
 * the shared settings catalog: the settings API only serves catalog keys, so it can neither be
 * read nor overwritten from the UI. No schema change is needed.
 */
export const SYNC_STATE_KEY = 'library.syncState';

const counts = z.object({
  seen: z.number().int(),
  upserted: z.number().int(),
  removed: z.number().int(),
});
export const syncStateSchema = z.object({
  /** Start time (ms) of the last successful run of either mode; the next incremental starts here minus the overlap. */
  lastIncrementalAt: z.number().int().nullable().default(null),
  /** Start time (ms) of the last successful full run. */
  lastFullAt: z.number().int().nullable().default(null),
  lastMode: z.enum(['incremental', 'full']).nullable().default(null),
  /** Counts of the last successful run. */
  lastCounts: counts.nullable().default(null),
  /** Message of the last failed run; cleared by the next success. */
  lastError: z.string().nullable().default(null),
  lastErrorAt: z.number().int().nullable().default(null),
});
export type SyncState = z.infer<typeof syncStateSchema>;

export interface SyncResult {
  mode: SyncMode;
  /** Set when nothing was done. */
  skipped?: 'not_configured';
  seen: number;
  upserted: number;
  removed: number;
  /** True when a full run found nothing and therefore kept the index (see `sync`). */
  sweepSkipped?: boolean;
}

export interface LibraryStatus {
  configured: boolean;
  state: SyncState;
  counts: Record<LibraryItemKind, number>;
  total: number;
}

export interface PathMapping {
  serverPath: string;
  localPath: string;
}

const isSep = (ch: string | undefined): boolean => ch === '/' || ch === '\\';
const trimSep = (path: string): string => {
  let end = path.length;
  while (end > 0 && isSep(path[end - 1])) end--;
  return path.slice(0, end);
};

/** Convert separators of `rest` to the style `target` uses (backslash only when it has no slash). */
function withSeparators(rest: string, target: string): string {
  const windows = target.includes('\\') && !target.includes('/');
  return windows ? rest.replaceAll('/', '\\') : rest.replaceAll('\\', '/');
}

function mapPrefix(path: string, from: string, to: string): string | undefined {
  const prefix = trimSep(from);
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  // Separator-safe: "/music" must not match "/musical/x".
  if (rest !== '' && !isSep(rest[0])) return undefined;
  return trimSep(to) + withSeparators(rest, to);
}

function translate(
  mappings: readonly PathMapping[],
  path: string,
  from: 'serverPath' | 'localPath',
  to: 'serverPath' | 'localPath',
): string {
  // Longest source prefix wins, so a nested mapping overrides its parent.
  const ordered = [...mappings].sort((a, b) => trimSep(b[from]).length - trimSep(a[from]).length);
  for (const mapping of ordered) {
    const mapped = mapPrefix(path, mapping[from], mapping[to]);
    if (mapped !== undefined) return mapped;
  }
  return path;
}

/** A path as the media server sees it -> the path inside Hearer's container. Unmapped paths pass through. */
export function toLocalPath(mappings: readonly PathMapping[], serverPath: string): string {
  return translate(mappings, serverPath, 'serverPath', 'localPath');
}

/** A path inside Hearer's container -> the path the media server knows (for `notifyPathsChanged`). */
export function toServerPath(mappings: readonly PathMapping[], localPath: string): string {
  return translate(mappings, localPath, 'localPath', 'serverPath');
}

/** The `norm_key` for an index row: `artist|title` for tracks and albums, the artist name for artists. */
export function indexKey(item: Pick<LibraryItem, 'kind' | 'name' | 'artistName'>): string | null {
  if (item.kind === 'artist') return normalizeArtist(item.name) || null;
  return normKey(item.artistName, item.name);
}

export interface LibraryServiceDeps {
  db: Db;
  settings: { get: (key: 'mediaServer') => SettingsValue<'mediaServer'> };
  mediaServer: { isConfigured: () => boolean; get: () => MediaServerAdapter };
  now?: () => number;
  /** Rows per transaction. Default 500. */
  batchSize?: number;
  /** An incremental run re-reads this much before the last start, to cover clock skew. Default 5 minutes. */
  overlapMs?: number;
}

type Row = typeof libraryItems.$inferInsert;

export class LibraryService {
  readonly #db: Db;
  readonly #settings: LibraryServiceDeps['settings'];
  readonly #mediaServer: LibraryServiceDeps['mediaServer'];
  readonly #now: () => number;
  readonly #batchSize: number;
  readonly #overlapMs: number;

  constructor(deps: LibraryServiceDeps) {
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#mediaServer = deps.mediaServer;
    this.#now = deps.now ?? Date.now;
    this.#batchSize = deps.batchSize ?? 500;
    this.#overlapMs = deps.overlapMs ?? 5 * 60_000;
  }

  isConfigured(): boolean {
    return this.#mediaServer.isConfigured();
  }

  // --- path mapping -------------------------------------------------------------------------

  toLocalPath(serverPath: string): string {
    return toLocalPath(this.#settings.get('mediaServer').pathMappings, serverPath);
  }

  toServerPath(localPath: string): string {
    return toServerPath(this.#settings.get('mediaServer').pathMappings, localPath);
  }

  // --- state --------------------------------------------------------------------------------

  getState(): SyncState {
    const row = this.#db.select().from(settings).where(eq(settings.key, SYNC_STATE_KEY)).get();
    if (row) {
      try {
        const parsed = syncStateSchema.safeParse(JSON.parse(row.valueJson));
        if (parsed.success) return parsed.data;
      } catch {
        // fall through to the empty state; the next run rewrites it
      }
    }
    return syncStateSchema.parse({});
  }

  #saveState(patch: Partial<SyncState>): void {
    const valueJson = JSON.stringify({ ...this.getState(), ...patch });
    this.#db
      .insert(settings)
      .values({ key: SYNC_STATE_KEY, valueJson })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
      .run();
  }

  status(): LibraryStatus {
    const rows = this.#db
      .select({ kind: libraryItems.kind, n: count() })
      .from(libraryItems)
      .groupBy(libraryItems.kind)
      .all();
    const byKind: Record<LibraryItemKind, number> = { artist: 0, album: 0, track: 0 };
    for (const row of rows) byKind[row.kind] = row.n;
    return {
      configured: this.isConfigured(),
      state: this.getState(),
      counts: byKind,
      total: byKind.artist + byKind.album + byKind.track,
    };
  }

  // --- sync ---------------------------------------------------------------------------------

  /**
   * Pull the library from the media server into `library_items`.
   *
   * - `incremental`: items the server saved since the last successful run (minus an overlap).
   *   Without a previous run it reads everything but never deletes.
   * - `full`: reads everything, then deletes rows not seen in THIS run (mark and sweep on
   *   `synced_at`). The sweep happens only after the whole iteration finished without error; a
   *   failure mid-way keeps every existing row. It is also skipped when the server returned no
   *   items at all while the index is not empty (a wrong library filter or a server that is
   *   still scanning would otherwise wipe the index).
   *
   * Rows are written in transactions of `batchSize`. Errors are recorded in the sync state and
   * rethrown (the job runner retries). Not configured is a quiet no-op.
   */
  async sync(
    mode: SyncMode,
    opts: { signal?: AbortSignal | undefined; log?: Pick<Logger, 'debug' | 'info' | 'warn'> } = {},
  ): Promise<SyncResult> {
    const log = opts.log;
    if (!this.#mediaServer.isConfigured()) {
      log?.debug({ mode }, 'library sync skipped: no media server configured');
      return { mode, skipped: 'not_configured', seen: 0, upserted: 0, removed: 0 };
    }
    const adapter = this.#mediaServer.get();
    const startedAt = this.#now();
    const state = this.getState();
    const since =
      mode === 'incremental' && state.lastIncrementalAt !== null
        ? new Date(state.lastIncrementalAt - this.#overlapMs)
        : undefined;

    let seen = 0;
    let upserted = 0;
    let removed = 0;
    let sweepSkipped = false;
    let batch: Row[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      upserted += this.#upsert(batch);
      batch = [];
    };

    try {
      for await (const item of adapter.iterateLibrary({ since, signal: opts.signal })) {
        seen++;
        batch.push(toRow(item, startedAt));
        if (batch.length >= this.#batchSize) flush();
      }
      flush();
      if (mode === 'full') {
        const existing = this.#db.select({ n: count() }).from(libraryItems).get()?.n ?? 0;
        if (seen === 0 && existing > 0) {
          sweepSkipped = true;
          log?.warn(
            { existing },
            'full library sync returned no items; keeping the existing index',
          );
        } else {
          removed = this.#db
            .delete(libraryItems)
            .where(
              sql`${libraryItems.syncedAt} < ${startedAt} and ${libraryItems.serverItemId} not like ${`${PROVISIONAL_ID_PREFIX}%`}`,
            )
            .run().changes;
        }
      }
    } catch (err) {
      if (!opts.signal?.aborted) {
        this.#saveState({
          lastError: err instanceof Error ? err.message : String(err),
          lastErrorAt: this.#now(),
        });
      }
      throw err;
    }

    this.#reapProvisional(startedAt);
    this.#saveState({
      lastIncrementalAt: startedAt,
      ...(mode === 'full' ? { lastFullAt: startedAt } : {}),
      lastMode: mode,
      lastCounts: { seen, upserted, removed },
      lastError: sweepSkipped ? 'The media server returned no items; the index was kept' : null,
      lastErrorAt: sweepSkipped ? this.#now() : null,
    });
    log?.info({ mode, seen, upserted, removed }, 'library sync finished');
    return { mode, seen, upserted, removed, ...(sweepSkipped ? { sweepSkipped } : {}) };
  }

  /** Drop provisional upload rows that a real item has replaced (or that never got indexed). */
  #reapProvisional(now: number): number {
    const like = `${PROVISIONAL_ID_PREFIX}%`;
    const staleBefore = now - PROVISIONAL_MAX_AGE_MS;
    return this.#db.run(sql`
      delete from library_items
      where server_item_id like ${like}
        and (
          synced_at < ${staleBefore}
          or exists (
            select 1 from library_items r
            where r.server_item_id not like ${like}
              and r.kind = 'track'
              and (
                (r.path is not null and r.path = library_items.path)
                or (r.mb_recording_id is not null
                    and r.mb_recording_id = library_items.mb_recording_id)
              )
          )
        )`).changes;
  }

  #upsert(rows: Row[]): number {
    this.#db.transaction((tx) => {
      tx.insert(libraryItems)
        .values(rows)
        .onConflictDoUpdate({
          target: libraryItems.serverItemId,
          set: {
            kind: sql`excluded.kind`,
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
    });
    return rows.length;
  }
}

function toRow(item: LibraryItem, syncedAt: number): Row {
  return {
    serverItemId: item.serverItemId,
    kind: item.kind,
    name: item.name,
    artistName: item.artistName,
    albumName: item.albumName,
    durationMs: item.durationMs,
    mbRecordingId: item.mbRecordingId,
    mbReleaseGroupId: item.mbReleaseGroupId,
    mbArtistId: item.mbArtistId,
    normKey: indexKey(item),
    path: item.path,
    syncedAt: new Date(syncedAt),
  };
}
