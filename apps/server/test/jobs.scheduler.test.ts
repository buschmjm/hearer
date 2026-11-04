import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { defineJob } from '../src/jobs/registry.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import { nextDailyRun } from '../src/jobs/scheduler.ts';

const logger = pino({ level: 'silent' });
let database: Database_;
let runner: JobRunner;

const sync = defineJob({
  type: 'library.sync',
  payload: z.object({}),
  concurrency: 1,
  // Never settles, so a claimed job stays "running" and the tests only observe enqueueing.
  handler: () => new Promise<void>(() => undefined),
});

function count(type = 'library.sync'): number {
  return (
    database.sqlite.prepare('select count(*) c from jobs where type = ?').get(type) as { c: number }
  ).c;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
  database = openDatabase(':memory:');
  runMigrations(database.db);
  runner = new JobRunner({ database, logger, pollIntervalMs: 1_000_000_000 });
  runner.define(sync);
});
afterEach(async () => {
  vi.useRealTimers();
  await runner.stop({ graceMs: 0 });
  database.close();
});

describe('nextDailyRun', () => {
  it('returns the next local occurrence, strictly after now', () => {
    const noon = new Date(2026, 0, 10, 12, 0, 0).getTime();
    expect(new Date(nextDailyRun(noon, 3))).toEqual(new Date(2026, 0, 11, 3, 0, 0));
    expect(new Date(nextDailyRun(noon, 15))).toEqual(new Date(2026, 0, 10, 15, 0, 0));
    expect(new Date(nextDailyRun(noon, 12))).toEqual(new Date(2026, 0, 11, 12, 0, 0));
  });
});

describe('scheduler', () => {
  it('rejects bad specs and unregistered types', () => {
    expect(() => runner.schedule({ type: 'nope', every: 1000 })).toThrow(/unregistered/);
    expect(() => runner.schedule({ type: 'library.sync', every: 0 })).toThrow(/every/);
    expect(() => runner.schedule({ type: 'library.sync', dailyAtHour: 24 })).toThrow(/dailyAtHour/);
    runner.schedule({ type: 'library.sync', every: 1000 });
    expect(() => runner.schedule({ type: 'library.sync', every: 1000 })).toThrow(/already/);
  });

  it('enqueues at start and on every interval, never piling up while one is pending', async () => {
    runner.schedule({ type: 'library.sync', every: 15 * 60_000 });
    expect(count()).toBe(0); // nothing before start
    runner.start();
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(count()).toBe(1); // first still queued/running (no tick ran): deduped
    expect(database.sqlite.prepare('select unique_key k from jobs').get()).toEqual({
      k: 'schedule:library.sync',
    });
    // let it finish, the next interval then enqueues a fresh one
    database.sqlite.prepare("update jobs set status='succeeded'").run();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(count()).toBe(2);
  });

  it('runs a daily schedule at the configured hour, not at start', async () => {
    runner.schedule({ type: 'library.sync', dailyAtHour: 3 });
    runner.start();
    expect(count()).toBe(0);
    await vi.advanceTimersByTimeAsync(14 * 3_600_000); // 12:00 -> 02:00 next day
    expect(count()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000); // 03:00
    expect(count()).toBe(1);
    database.sqlite.prepare("update jobs set status='succeeded'").run();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(count()).toBe(2);
  });

  it('stops scheduling on stop and starts when added to a running runner', async () => {
    runner.start();
    runner.schedule({ type: 'library.sync', every: 1000 });
    expect(count()).toBe(1);
    const stopping = runner.stop({ graceMs: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    database.sqlite.prepare("update jobs set status='succeeded'").run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count()).toBe(1);
  });
});
