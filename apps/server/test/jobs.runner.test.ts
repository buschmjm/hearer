import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { JobRunner } from '../src/jobs/runner.ts';
import { PermanentJobError, computeBackoffMs, defineJob } from '../src/jobs/registry.ts';

const logger = pino({ level: 'silent' });
const noJitter = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };

let database: Database_;
let clock: number;
let runner: JobRunner;

function makeRunner(extra: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}): JobRunner {
  return new JobRunner({
    database,
    logger,
    now: () => clock,
    random: () => 0.5,
    pollIntervalMs: 10_000,
    ...extra,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  database = openDatabase(':memory:');
  runMigrations(database.db);
  clock = 1_700_000_000_000;
  runner = makeRunner();
});
afterEach(async () => {
  await runner.stop({ graceMs: 0 });
  database.close();
});

const noop = z.object({ n: z.number().optional() });

describe('computeBackoffMs', () => {
  it('doubles per attempt up to the cap, with jitter in range', () => {
    const b = { baseMs: 1000, maxMs: 10_000, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6].map((a) => computeBackoffMs(a, b))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
    const j = { baseMs: 1000, maxMs: 10_000, jitter: 0.2 };
    expect(computeBackoffMs(1, j, () => 0)).toBe(800);
    expect(computeBackoffMs(1, j, () => 1)).toBe(1200);
    expect(computeBackoffMs(1, j, () => 0.5)).toBe(1000);
  });
});

describe('defineJob / enqueue', () => {
  it('validates definitions', () => {
    const base = { type: 'x', payload: noop, handler: () => undefined };
    expect(() => defineJob({ ...base, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => defineJob({ ...base, concurrency: 1, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => defineJob({ ...base, concurrency: 1, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it('rejects duplicate registration, unknown types and invalid payloads', () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: z.object({ id: z.string() }),
        concurrency: 1,
        handler: () => undefined,
      }),
    );
    expect(() =>
      runner.define(
        defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }),
      ),
    ).toThrow(/already registered/);
    expect(() => runner.enqueue('nope', {})).toThrow(/unknown job type/);
    expect(() => runner.enqueue('a', { id: 5 })).toThrow(z.ZodError);
    expect(() => runner.enqueue('a', { id: 'x' }, { maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(database.sqlite.prepare('select count(*) c from jobs').get()).toEqual({ c: 0 });
    const id = runner.enqueue('a', { id: 'x' });
    expect(runner.get(id)).toMatchObject({
      type: 'a',
      status: 'queued',
      payload: { id: 'x' },
      attempts: 0,
      maxAttempts: 5,
    });
  });

  it('stores the parsed payload, priority, runAfter/delayMs and maxAttempts', () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: z.object({ n: z.coerce.number() }),
        concurrency: 1,
        maxAttempts: 2,
        handler: () => undefined,
      }),
    );
    const id = runner.enqueue('a', { n: '7' }, { priority: 3, delayMs: 500 });
    expect(runner.get(id)).toMatchObject({
      payload: { n: 7 },
      priority: 3,
      runAfter: clock + 500,
      maxAttempts: 2,
    });
    const id2 = runner.enqueue('a', { n: 1 }, { runAfter: new Date(clock + 9), maxAttempts: 9 });
    expect(runner.get(id2)).toMatchObject({ runAfter: clock + 9, maxAttempts: 9 });
  });

  it('dedupes on uniqueKey while queued or running, but not after finishing', async () => {
    const gate = deferred();
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => gate.promise }),
    );
    const first = runner.enqueue('a', {}, { uniqueKey: 'k' });
    expect(runner.enqueue('a', {}, { uniqueKey: 'k' })).toBe(first);
    expect(runner.enqueue('a', {}, { uniqueKey: 'other' })).not.toBe(first);
    runner.start();
    runner.tick();
    expect(runner.get(first)?.status).toBe('running');
    expect(runner.enqueue('a', {}, { uniqueKey: 'k' })).toBe(first);
    gate.resolve();
    await runner.drain();
    expect(runner.get(first)?.status).toBe('succeeded');
    expect(runner.enqueue('a', {}, { uniqueKey: 'k' })).not.toBe(first);
  });
});

describe('claiming', () => {
  it('runs by priority desc, then run_after, then id, and skips future jobs', async () => {
    const order: string[] = [];
    runner.define(
      defineJob({
        type: 'a',
        payload: z.object({ name: z.string() }),
        concurrency: 1,
        handler: (p) => {
          order.push(p.name);
        },
      }),
    );
    runner.enqueue('a', { name: 'low-late' }, { runAfter: clock - 10 });
    runner.enqueue('a', { name: 'low-early' }, { runAfter: clock - 100 });
    runner.enqueue('a', { name: 'high' }, { priority: 5, runAfter: clock - 1 });
    runner.enqueue('a', { name: 'tie-1' }, { runAfter: clock - 10 });
    const future = runner.enqueue('a', { name: 'future' }, { priority: 99, delayMs: 60_000 });
    runner.start();
    for (let i = 0; i < 5; i++) {
      runner.tick();
      await runner.drain();
    }
    expect(order).toEqual(['high', 'low-early', 'low-late', 'tie-1']);
    expect(runner.get(future)?.status).toBe('queued');
    clock += 60_000;
    runner.tick();
    await runner.drain();
    expect(order.at(-1)).toBe('future');
  });

  it('never claims types it has no definition for', () => {
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }),
    );
    const other = makeRunner();
    other.define(defineJob({ type: 'b', payload: noop, concurrency: 1, handler: () => undefined }));
    const b = other.enqueue('b', {});
    runner.start();
    expect(runner.tick()).toBe(0);
    expect(runner.get(b)?.status).toBe('queued');
  });

  it('respects per-type and global concurrency', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const active = { a: 0, b: 0, maxA: 0, maxB: 0 };
    const handler = (key: 'a' | 'b') => async () => {
      active[key]++;
      active[key === 'a' ? 'maxA' : 'maxB'] = Math.max(
        active[key === 'a' ? 'maxA' : 'maxB'],
        active[key],
      );
      const g = deferred();
      gates.push(g);
      await g.promise;
      active[key]--;
    };
    runner = makeRunner({ maxConcurrency: 3 });
    runner.define(defineJob({ type: 'a', payload: noop, concurrency: 2, handler: handler('a') }));
    runner.define(defineJob({ type: 'b', payload: noop, concurrency: 1, handler: handler('b') }));
    for (let i = 0; i < 4; i++) runner.enqueue('a', {});
    for (let i = 0; i < 3; i++) runner.enqueue('b', {});
    runner.start();
    expect(runner.tick()).toBe(3); // global cap 3: two a + one b
    expect(active).toMatchObject({ a: 2, b: 1 });
    expect(runner.tick()).toBe(0);
    while (runner.inFlight > 0 || gates.length < 7) {
      gates.shift()?.resolve();
      await new Promise((r) => setImmediate(r));
      runner.tick();
      expect(runner.inFlight).toBeLessThanOrEqual(3);
      if (gates.length === 0 && runner.inFlight === 0) break;
    }
    await runner.drain();
    expect(active.maxA).toBeLessThanOrEqual(2);
    expect(active.maxB).toBe(1);
    expect(
      database.sqlite.prepare("select count(*) c from jobs where status='succeeded'").get(),
    ).toEqual({ c: 7 });
  });

  it('wakes immediately on enqueue without waiting for the poll interval', async () => {
    const ran = deferred();
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        handler: () => {
          ran.resolve();
        },
      }),
    );
    runner.start(); // poll interval is 10 s, so only the wake can run this
    runner.enqueue('a', {});
    await ran.promise;
    await runner.drain();
  });
});

describe('retry, backoff and terminal states', () => {
  it('retries with exponential backoff, then succeeds', async () => {
    let calls = 0;
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        backoff: noJitter,
        handler: (_p, ctx) => {
          calls++;
          expect(ctx.attempt).toBe(calls);
          if (calls < 3) throw new Error(`boom ${calls}`);
        },
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      runAfter: clock + 1_000,
    });
    expect(runner.get(id)?.lastError).toMatch(/boom 1/);
    expect(runner.tick()).toBe(0); // not yet due
    clock += 999;
    expect(runner.tick()).toBe(0);
    clock += 1;
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({
      status: 'queued',
      attempts: 2,
      runAfter: clock + 2_000,
    });
    clock += 2_000;
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(runner.get(id)?.finishedAt).toBe(clock);
  });

  it('goes dead after maxAttempts and keeps a truncated stack', async () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        maxAttempts: 2,
        backoff: noJitter,
        handler: () => {
          throw new Error('x'.repeat(10_000));
        },
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    clock += 1_000;
    runner.tick();
    await runner.drain();
    const job = runner.get(id);
    expect(job).toMatchObject({ status: 'dead', attempts: 2, finishedAt: clock });
    expect(job?.lastError?.length).toBeLessThan(4_100);
    expect(job?.lastError).toMatch(/^Error: x+/);
    expect(job?.lastError).toMatch(/truncated\]$/);
    expect(runner.tick()).toBe(0);
  });

  it('PermanentJobError fails immediately without retry', async () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        handler: () => {
          throw new PermanentJobError('bad input');
        },
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({ status: 'dead', attempts: 1 });
    expect(runner.get(id)?.lastError).toMatch(/PermanentJobError: bad input/);
  });

  it('records non-Error throws and async rejections', async () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        maxAttempts: 1,
        handler: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising non-Error throws
          throw 'plain string';
        },
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({ status: 'dead' });
    expect(runner.get(id)?.lastError).toMatch(/plain string/);
  });

  it('kills a job whose stored payload no longer validates', async () => {
    let called = false;
    runner.define(
      defineJob({
        type: 'a',
        payload: z.object({ id: z.string() }),
        concurrency: 1,
        handler: () => {
          called = true;
        },
      }),
    );
    database.sqlite
      .prepare(`insert into jobs (type, payload_json, run_after) values ('a', '{"id":5}', 0)`)
      .run();
    runner.start();
    runner.tick();
    await runner.drain();
    expect(called).toBe(false);
    expect(database.sqlite.prepare('select status, last_error from jobs').get()).toMatchObject({
      status: 'dead',
    });
  });

  it('gives handlers a working ctx (log, db, enqueue)', async () => {
    runner.define(
      defineJob({
        type: 'child',
        payload: z.object({ from: z.number() }),
        concurrency: 1,
        handler: () => undefined,
      }),
    );
    let childId = 0;
    runner.define(
      defineJob({
        type: 'parent',
        payload: noop,
        concurrency: 1,
        handler: (_p, ctx) => {
          ctx.log.info('hello');
          expect(ctx.db).toBeDefined();
          expect(ctx.signal.aborted).toBe(false);
          childId = ctx.enqueue('child', { from: ctx.jobId });
        },
      }),
    );
    const id = runner.enqueue('parent', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(runner.get(childId)).toMatchObject({ type: 'child', payload: { from: id } });
  });
});

describe('timeouts', () => {
  it('aborts the handler via its signal and counts a failed attempt', async () => {
    let aborted = false;
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        timeoutMs: 20,
        backoff: noJitter,
        handler: (_p, ctx) =>
          new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          }),
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(aborted).toBe(true);
    expect(runner.get(id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(runner.get(id)?.lastError).toMatch(/timed out after 20 ms/);
  });

  it('frees the slot even when the handler ignores the signal, and ends dead when exhausted', async () => {
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        timeoutMs: 20,
        maxAttempts: 1,
        handler: () => new Promise<void>(() => undefined), // never settles
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.drain();
    expect(runner.get(id)).toMatchObject({ status: 'dead', attempts: 1 });
    expect(runner.inFlight).toBe(0);
  });
});

describe('restart resume', () => {
  function crashRows(): void {
    // Rows a dead process would leave behind: running, locked by some worker.
    database.sqlite
      .prepare(
        `insert into jobs (type, payload_json, status, attempts, max_attempts, locked_by, locked_at)
         values ('a', '{}', 'running', ?, ?, ?, ?)`,
      )
      .run(1, 5, 'main', clock - 1_000);
    database.sqlite
      .prepare(
        `insert into jobs (type, payload_json, status, attempts, max_attempts, locked_by, locked_at)
         values ('a', '{}', 'running', 3, 3, 'main', ?)`,
      )
      .run(clock - 1_000);
  }

  it('re-queues own leftovers on start (attempt stays consumed) and finishes them', async () => {
    crashRows();
    const ran: number[] = [];
    runner = makeRunner({ workerId: 'main' });
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 2,
        handler: (_p, ctx) => {
          ran.push(ctx.attempt);
        },
      }),
    );
    runner.start();
    await new Promise((r) => setImmediate(r));
    await runner.drain();
    expect(ran).toEqual([2]); // consumed attempt 1, so this is attempt 2
    const rows = database.sqlite
      .prepare('select status, attempts, last_error from jobs order by id')
      .all();
    expect(rows[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    // The second had exhausted its attempts when the process died, so it must not loop.
    expect(rows[1]).toMatchObject({ status: 'dead', attempts: 3 });
    expect((rows[1] as { last_error: string }).last_error).toMatch(/attempts exhausted/);
  });

  it('leaves a live peer alone but recovers its lock once stale', () => {
    crashRows();
    runner = makeRunner({ workerId: 'other', staleLockMs: 60_000, housekeepingMs: 1_000 });
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }),
    );
    runner.start();
    expect(
      database.sqlite.prepare("select count(*) c from jobs where status='running'").get(),
    ).toEqual({ c: 2 });
    clock += 60_000;
    expect(runner.housekeeping()).toBe(2);
    expect(
      database.sqlite.prepare("select count(*) c from jobs where status='running'").get(),
    ).toEqual({ c: 0 });
  });

  it('recovers stale locks of any worker on start', () => {
    crashRows();
    clock += 10 * 60_000;
    runner = makeRunner({ workerId: 'someone-new', staleLockMs: 60_000 });
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }),
    );
    expect(runner.recoverOnStart()).toBe(2);
  });

  it('refreshes held locks so a long job is not taken by a peer', async () => {
    const gate = deferred();
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => gate.promise }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    clock += 200_000;
    runner.housekeeping();
    expect(runner.get(id)?.lockedAt).toBe(clock);
    const peer = makeRunner({ staleLockMs: 300_000 });
    peer.define(defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }));
    clock += 200_000;
    expect(peer.housekeeping()).toBe(0);
    gate.resolve();
    await runner.drain();
  });
});

describe('graceful stop', () => {
  it('waits for in-flight jobs within the grace period', async () => {
    const gate = deferred();
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => gate.promise }),
    );
    const id = runner.enqueue('a', {});
    const queuedLater = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    const stopping = runner.stop({ graceMs: 5_000 });
    setTimeout(() => {
      gate.resolve();
    }, 20);
    await stopping;
    expect(runner.get(id)?.status).toBe('succeeded');
    expect(runner.get(queuedLater)?.status).toBe('queued'); // nothing new claimed while stopping
    expect(runner.tick()).toBe(0);
  });

  it('aborts after the grace period and leaves the job queued with the attempt refunded', async () => {
    let signal: AbortSignal | undefined;
    runner.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        handler: (_p, ctx) => {
          signal = ctx.signal;
          return new Promise<void>((_res, rej) => {
            ctx.signal.addEventListener('abort', () => {
              rej(new Error('aborted'));
            });
          });
        },
      }),
    );
    const id = runner.enqueue('a', {});
    runner.start();
    runner.tick();
    await runner.stop({ graceMs: 10 });
    expect(signal?.aborted).toBe(true);
    expect(runner.get(id)).toMatchObject({ status: 'queued', attempts: 0, lockedBy: null });
    // and a fresh runner picks it up
    const next = makeRunner();
    let done = false;
    next.define(
      defineJob({
        type: 'a',
        payload: noop,
        concurrency: 1,
        handler: () => {
          done = true;
        },
      }),
    );
    next.start();
    next.tick();
    await next.drain();
    expect(done).toBe(true);
    await next.stop();
  });

  it('is idempotent and restartable', async () => {
    runner.define(
      defineJob({ type: 'a', payload: noop, concurrency: 1, handler: () => undefined }),
    );
    runner.start();
    runner.start();
    await runner.stop();
    await runner.stop();
    runner.start();
    const id = runner.enqueue('a', {});
    runner.tick();
    await runner.drain();
    expect(runner.get(id)?.status).toBe('succeeded');
  });
});
