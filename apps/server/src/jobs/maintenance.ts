import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { z } from 'zod';
import type { Database_ } from '../db/client.ts';
import { defineJob } from './registry.ts';

export const MAINTENANCE_JOB = 'maintenance.cleanup';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface CleanupOptions {
  database: Pick<Database_, 'sqlite'>;
  /** `STAGING_DIR`; only `<stagingDir>/tmp` is touched. */
  stagingDir: string;
  log: Logger;
  now?: () => number;
  /** Finished (succeeded/failed) jobs older than this are deleted. Default 7 days. */
  keepFinishedDays?: number;
  /** Dead jobs are kept longer for debugging. Default 30 days. */
  keepDeadDays?: number;
  /** Stale tus artifacts older than this are deleted. Default 24 hours. */
  tusMaxAgeMs?: number;
}

export interface CleanupResult {
  expiredSessions: number;
  expiredMbCache: number;
  prunedJobs: number;
  prunedDeadJobs: number;
  staleUploadFiles: number;
  /** Symlinks inside staging/tmp that were left alone (never followed or removed). */
  skippedSymlinks: number;
}

/**
 * Remove stale tus artifacts from `<stagingDir>/tmp`. A tus upload is `<id>` plus `<id>.json`;
 * a pair is stale when the newest of its members is older than `maxAgeMs`. Only regular files
 * directly inside the directory are removed. Symlinks are never followed or deleted, and if
 * `tmp` itself is a symlink nothing is touched, so nothing outside the staging dir is reachable.
 */
export async function cleanStagingTmp(
  stagingDir: string,
  maxAgeMs: number,
  now: number,
  log: Logger,
): Promise<{ removed: number; skippedSymlinks: number }> {
  const tmp = join(stagingDir, 'tmp');
  let tmpStat;
  try {
    tmpStat = await lstat(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, skippedSymlinks: 0 };
    throw err;
  }
  if (!tmpStat.isDirectory()) {
    // lstat does not follow, so a symlinked tmp reports isSymbolicLink and lands here.
    log.warn({ tmp }, 'staging tmp is not a real directory, skipping cleanup');
    return { removed: 0, skippedSymlinks: 0 };
  }

  const groups = new Map<string, { names: string[]; newest: number }>();
  let skippedSymlinks = 0;
  for (const name of await readdir(tmp)) {
    const stat = await lstat(join(tmp, name)).catch(() => undefined);
    if (!stat) continue; // vanished
    if (stat.isSymbolicLink()) {
      skippedSymlinks++;
      log.warn({ name }, 'symlink in staging tmp left untouched');
      continue;
    }
    if (!stat.isFile()) continue;
    const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
    const group = groups.get(base) ?? { names: [], newest: 0 };
    group.names.push(name);
    group.newest = Math.max(group.newest, stat.mtimeMs);
    groups.set(base, group);
  }

  let removed = 0;
  for (const group of groups.values()) {
    if (now - group.newest <= maxAgeMs) continue;
    for (const name of group.names) {
      try {
        await unlink(join(tmp, name));
        removed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ err, name }, 'could not remove stale upload artifact');
        }
      }
    }
  }
  return { removed, skippedSymlinks };
}

export async function runCleanup(opts: CleanupOptions): Promise<CleanupResult> {
  const now = (opts.now ?? Date.now)();
  const { sqlite } = opts.database;
  const finishedCutoff = now - (opts.keepFinishedDays ?? 7) * DAY_MS;
  const deadCutoff = now - (opts.keepDeadDays ?? 30) * DAY_MS;

  const expiredSessions = sqlite
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(now).changes;
  const expiredMbCache = sqlite
    .prepare('DELETE FROM mb_cache WHERE fetched_at + ttl_seconds * 1000 < ?')
    .run(now).changes;
  const prunedJobs = sqlite
    .prepare(
      `DELETE FROM jobs WHERE status IN ('succeeded','failed') AND COALESCE(finished_at, updated_at) < ?`,
    )
    .run(finishedCutoff).changes;
  const prunedDeadJobs = sqlite
    .prepare(`DELETE FROM jobs WHERE status = 'dead' AND COALESCE(finished_at, updated_at) < ?`)
    .run(deadCutoff).changes;
  const staging = await cleanStagingTmp(opts.stagingDir, opts.tusMaxAgeMs ?? DAY_MS, now, opts.log);

  const result: CleanupResult = {
    expiredSessions,
    expiredMbCache,
    prunedJobs,
    prunedDeadJobs,
    staleUploadFiles: staging.removed,
    skippedSymlinks: staging.skippedSymlinks,
  };
  opts.log.info(result, 'maintenance cleanup finished');
  return result;
}

/** The registered job. Schedule it hourly with `runner.schedule({ type, every: HOUR_MS })`. */
export function maintenanceJob(deps: {
  database: Pick<Database_, 'sqlite'>;
  stagingDir: string;
  now?: () => number;
}) {
  return defineJob({
    type: MAINTENANCE_JOB,
    payload: z.object({}),
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 5 * 60_000,
    handler: async (_payload, ctx) => {
      await runCleanup({ ...deps, log: ctx.log });
    },
  });
}

export const MAINTENANCE_INTERVAL_MS = HOUR_MS;
