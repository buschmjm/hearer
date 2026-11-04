import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { MAINTENANCE_JOB, runCleanup } from '../src/jobs/maintenance.ts';

const logger = pino({ level: 'silent' });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

let root: string;
let staging: string;
let database: Database_;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hearer-maint-'));
  staging = join(root, 'staging');
  mkdirSync(join(staging, 'tmp'), { recursive: true });
  database = openDatabase(':memory:');
  runMigrations(database.db);
});
afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

function touch(path: string, ageMs: number): void {
  writeFileSync(path, 'x');
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
}

function seedUser(): void {
  database.sqlite
    .prepare(
      `insert into users (id, username, auth_type, permissions) values ('u1', 'bob', 'local', 0)`,
    )
    .run();
}

const run = (extra: Partial<Parameters<typeof runCleanup>[0]> = {}) =>
  runCleanup({ database, stagingDir: staging, log: logger, now: () => NOW, ...extra });

describe('maintenance.cleanup', () => {
  it('deletes only expired sessions', async () => {
    seedUser();
    const ins = database.sqlite.prepare(
      `insert into sessions (id, user_id, expires_at) values (?, 'u1', ?)`,
    );
    ins.run('expired', NOW - 1);
    ins.run('valid', NOW + 1);
    const result = await run();
    expect(result.expiredSessions).toBe(1);
    expect(database.sqlite.prepare('select id from sessions').all()).toEqual([{ id: 'valid' }]);
  });

  it('purges mb_cache rows past fetched_at + ttl', async () => {
    const ins = database.sqlite.prepare(
      `insert into mb_cache (url_key, body_json, fetched_at, ttl_seconds) values (?, '{}', ?, ?)`,
    );
    ins.run('stale', NOW - 3_601_000, 3600);
    ins.run('fresh', NOW - 3_599_000, 3600);
    ins.run('long-ttl', NOW - 10 * DAY, 30 * 86_400);
    const result = await run();
    expect(result.expiredMbCache).toBe(1);
    expect(database.sqlite.prepare('select url_key k from mb_cache order by k').all()).toEqual([
      { k: 'fresh' },
      { k: 'long-ttl' },
    ]);
  });

  it('prunes finished jobs after 7 days and dead jobs after 30, never active ones', async () => {
    const rows: [string, string, number | null][] = [
      ['ok-old', 'succeeded', NOW - 8 * DAY],
      ['ok-new', 'succeeded', NOW - 6 * DAY],
      ['dead-mid', 'dead', NOW - 10 * DAY],
      ['dead-old', 'dead', NOW - 31 * DAY],
      ['queued-old', 'queued', null],
      ['running-old', 'running', null],
    ];
    for (const [type, status, finished] of rows) {
      database.sqlite
        .prepare(
          `insert into jobs (type, status, finished_at, updated_at, created_at) values (?, ?, ?, ?, ?)`,
        )
        .run(type, status, finished, finished ?? NOW - 99 * DAY, NOW - 99 * DAY);
    }
    const result = await run();
    expect(result).toMatchObject({ prunedJobs: 1, prunedDeadJobs: 1 });
    expect(
      database.sqlite
        .prepare('select type from jobs order by id')
        .all()
        .map((r) => (r as { type: string }).type),
    ).toEqual(['ok-new', 'dead-mid', 'queued-old', 'running-old']);
  });

  it('removes stale tus files with their .json, keeps fresh pairs', async () => {
    const tmp = join(staging, 'tmp');
    touch(join(tmp, 'old'), 25 * HOUR);
    touch(join(tmp, 'old.json'), 25 * HOUR);
    touch(join(tmp, 'fresh'), 1 * HOUR);
    touch(join(tmp, 'fresh.json'), 1 * HOUR);
    touch(join(tmp, 'half'), 30 * HOUR); // stale data, but metadata was touched recently: alive
    touch(join(tmp, 'half.json'), 2 * HOUR);
    touch(join(tmp, 'orphan.json'), 48 * HOUR);
    mkdirSync(join(tmp, 'subdir'));
    touch(join(staging, 'outside-tmp'), 99 * HOUR);
    const result = await run();
    expect(result.staleUploadFiles).toBe(3);
    expect(['old', 'old.json', 'orphan.json'].some((n) => existsSync(join(tmp, n)))).toBe(false);
    for (const n of ['fresh', 'fresh.json', 'half', 'half.json', 'subdir']) {
      expect(existsSync(join(tmp, n))).toBe(true);
    }
    expect(existsSync(join(staging, 'outside-tmp'))).toBe(true);
  });

  it('does not follow symlinks out of the staging dir', async () => {
    const tmp = join(staging, 'tmp');
    const outside = join(root, 'precious');
    mkdirSync(outside);
    touch(join(outside, 'keep.bin'), 100 * HOUR);
    touch(join(outside, 'keep.bin.json'), 100 * HOUR);
    symlinkSync(outside, join(tmp, 'dirlink'));
    symlinkSync(join(outside, 'keep.bin'), join(tmp, 'filelink'));
    symlinkSync(join(outside, 'keep.bin.json'), join(tmp, 'filelink.json'));
    const result = await run();
    expect(result.staleUploadFiles).toBe(0);
    expect(result.skippedSymlinks).toBe(3);
    expect(existsSync(join(outside, 'keep.bin'))).toBe(true);
    expect(existsSync(join(outside, 'keep.bin.json'))).toBe(true);
    expect(existsSync(join(tmp, 'filelink'))).toBe(true); // links themselves are left alone too
  });

  it('refuses to clean when tmp itself is a symlink', async () => {
    const outside = join(root, 'elsewhere');
    mkdirSync(outside);
    touch(join(outside, 'victim'), 100 * HOUR);
    rmSync(join(staging, 'tmp'), { recursive: true });
    symlinkSync(outside, join(staging, 'tmp'));
    const result = await run();
    expect(result.staleUploadFiles).toBe(0);
    expect(existsSync(join(outside, 'victim'))).toBe(true);
  });

  it('tolerates a missing staging tmp directory', async () => {
    rmSync(join(staging, 'tmp'), { recursive: true });
    await expect(run()).resolves.toMatchObject({ staleUploadFiles: 0 });
  });
});

describe('app wiring', () => {
  it('exposes the runner, registers and schedules maintenance, and does not start by default', async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', STAGING_DIR: staging });
    const app = await buildApp(config);
    await app.ready();
    expect(app.hearer.jobs.registry.has(MAINTENANCE_JOB)).toBe(true);
    expect(app.hearer.jobs.running).toBe(false);
    await app.close();
  });

  it('starts on ready and stops before the database closes when startJobs is set', async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', STAGING_DIR: staging });
    const app = await buildApp(config, { startJobs: true });
    await app.ready();
    expect(app.hearer.jobs.running).toBe(true);
    // The scheduler enqueued the hourly cleanup at start; it runs and completes.
    const deadline = Date.now() + 5_000;
    const status = (): string | undefined =>
      (
        app.hearer.database.sqlite
          .prepare('select status from jobs where type = ?')
          .get(MAINTENANCE_JOB) as { status: string } | undefined
      )?.status;
    while (status() !== 'succeeded' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(status()).toBe('succeeded');
    await app.close(); // would throw if the db were closed first
    expect(app.hearer.jobs.running).toBe(false);
  });
});
