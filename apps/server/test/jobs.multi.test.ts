import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { defineJob } from '../src/jobs/registry.ts';
import { JobRunner } from '../src/jobs/runner.ts';

const logger = pino({ level: 'silent' });
let dir: string;
let dbs: Database_[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hearer-jobs-'));
  dbs = [];
});
afterEach(() => {
  for (const d of dbs) d.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(): Database_ {
  const d = openDatabase(dir);
  dbs.push(d);
  return d;
}

describe('two runners sharing one database file', () => {
  it('never run the same job twice', async () => {
    const first = open();
    runMigrations(first.db);
    const second = open();
    const runs = new Map<number, string[]>();
    const make = (database: Database_, name: string): JobRunner => {
      const r = new JobRunner({ database, logger, maxConcurrency: 3, pollIntervalMs: 5 });
      r.define(
        defineJob({
          type: 'work',
          payload: z.object({ n: z.number() }),
          concurrency: 3,
          handler: async (_p, ctx) => {
            const list = runs.get(ctx.jobId) ?? [];
            list.push(name);
            runs.set(ctx.jobId, list);
            await new Promise((res) => setTimeout(res, 1));
          },
        }),
      );
      return r;
    };
    const a = make(first, 'a');
    const b = make(second, 'b');
    const total = 120;
    for (let i = 0; i < total; i++) a.enqueue('work', { n: i });
    a.start();
    b.start();
    const deadline = Date.now() + 15_000;
    const done = (): number =>
      (
        first.sqlite.prepare("select count(*) c from jobs where status='succeeded'").get() as {
          c: number;
        }
      ).c;
    while (done() < total && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await Promise.all([a.stop(), b.stop()]);
    expect(done()).toBe(total);
    expect(runs.size).toBe(total);
    for (const who of runs.values()) expect(who).toHaveLength(1);
    const byWorker = new Set([...runs.values()].map((w) => w[0]));
    expect(byWorker.size).toBe(2); // both actually took part
    expect(first.sqlite.prepare('select max(attempts) m from jobs').get()).toEqual({ m: 1 });
  });

  it('dedupes uniqueKey across processes', () => {
    const first = open();
    runMigrations(first.db);
    const second = open();
    const def = defineJob({
      type: 'u',
      payload: z.object({}),
      concurrency: 1,
      handler: () => undefined,
    });
    const a = new JobRunner({ database: first, logger }).define(def);
    const b = new JobRunner({ database: second, logger }).define(def);
    const id = a.enqueue('u', {}, { uniqueKey: 'same' });
    expect(b.enqueue('u', {}, { uniqueKey: 'same' })).toBe(id);
    expect(first.sqlite.prepare('select count(*) c from jobs').get()).toEqual({ c: 1 });
  });
});
