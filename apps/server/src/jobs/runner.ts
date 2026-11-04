import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { Database_ } from '../db/client.ts';
import {
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  JobRegistry,
  PermanentJobError,
  computeBackoffMs,
  type BackoffOptions,
  type EnqueueOptions,
  type JobContext,
  type JobDefinition,
} from './registry.ts';
import { Scheduler, type ScheduleSpec } from './scheduler.ts';

export interface JobRunnerOptions {
  database: Database_;
  logger: Logger;
  /**
   * Identifies this process in `jobs.locked_by`. On start, `running` rows with this id are
   * assumed to be left over from a previous run of the same process and are recovered at once.
   * index.ts passes a stable value; the default is random (then only stale locks are recovered).
   */
  workerId?: string;
  /** Poll interval when idle. Default 1 000 ms. */
  pollIntervalMs?: number;
  /** Max jobs running at once across all types. Default 4. */
  maxConcurrency?: number;
  /** A `running` job whose lock is older than this is taken back. Default 5 minutes. */
  staleLockMs?: number;
  /** How often held locks are refreshed and foreign stale locks recovered. Default staleLockMs / 3. */
  housekeepingMs?: number;
  /** How long stop() waits for aborted handlers to settle. Default 1 000 ms. */
  abortWaitMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  random?: () => number;
}

interface Row {
  id: number;
  type: string;
  payload_json: string | null;
  status: string;
  priority: number;
  unique_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_by: string | null;
  locked_at: number | null;
  last_error: string | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface JobRecord {
  id: number;
  type: string;
  payload: unknown;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  priority: number;
  uniqueKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lockedBy: string | null;
  lockedAt: number | null;
  lastError: string | null;
  finishedAt: number | null;
}

const MAX_ERROR_CHARS = 4_000;

export function formatJobError(err: unknown): string {
  const text =
    err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
      : `non-error thrown: ${String(err)}`;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}... [truncated]` : text;
}

class TimeoutAbort extends Error {
  constructor(ms: number) {
    super(`job timed out after ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}
class ShutdownAbort extends Error {
  constructor() {
    super('runner is shutting down');
    this.name = 'JobShutdownError';
  }
}

interface Run {
  row: Row;
  controller: AbortController;
  done: Promise<void>;
}

function toRecord(row: Row): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as unknown),
    status: row.status as JobRecord['status'],
    priority: row.priority,
    uniqueKey: row.unique_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lastError: row.last_error,
    finishedAt: row.finished_at,
  };
}

/**
 * DB-backed job runner. State lives in the `jobs` table, so any number of runners (processes)
 * may share one database file: a job is claimed by a single `UPDATE ... RETURNING`, which
 * SQLite executes under its write lock, so two runners can never claim the same row.
 *
 * Attempt accounting: `attempts` is incremented at claim time.
 *   - Graceful stop or shutdown abort: the attempt is refunded (not the job's fault).
 *   - Crash / stale lock recovery: the attempt stays consumed (a job that kills the process
 *     must not loop forever); if that exhausts the attempts the job goes `dead`.
 */
export class JobRunner {
  readonly registry = new JobRegistry();
  readonly workerId: string;
  readonly #sqlite: Database_['sqlite'];
  readonly #database: Database_;
  readonly #log: Logger;
  readonly #pollMs: number;
  readonly #maxConcurrency: number;
  readonly #staleMs: number;
  readonly #housekeepingMs: number;
  readonly #abortWaitMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #scheduler: Scheduler;
  readonly #inflight = new Map<number, Run>();
  readonly #perType = new Map<string, number>();
  #started = false;
  #accepting = false;
  #pollTimer: NodeJS.Timeout | undefined;
  #housekeepingTimer: NodeJS.Timeout | undefined;
  #wakePending = false;

  constructor(opts: JobRunnerOptions) {
    this.#database = opts.database;
    this.#sqlite = opts.database.sqlite;
    this.#log = opts.logger.child({ component: 'jobs' });
    this.workerId = opts.workerId ?? randomUUID();
    this.#pollMs = opts.pollIntervalMs ?? 1_000;
    this.#maxConcurrency = opts.maxConcurrency ?? 4;
    this.#staleMs = opts.staleLockMs ?? 5 * 60_000;
    this.#housekeepingMs = opts.housekeepingMs ?? Math.max(1_000, Math.floor(this.#staleMs / 3));
    this.#abortWaitMs = opts.abortWaitMs ?? 1_000;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? Math.random;
    if (this.#maxConcurrency < 1) throw new RangeError('maxConcurrency must be >= 1');
    this.#scheduler = new Scheduler({
      now: this.#now,
      enqueue: (spec, uniqueKey) => {
        this.enqueue(spec.type, spec.payload ?? {}, { uniqueKey });
      },
      onError: (err, spec) => {
        this.#log.error({ err, type: spec.type }, 'scheduled enqueue failed');
      },
    });
  }

  define<TType extends string, TPayload>(definition: JobDefinition<TType, TPayload>): this {
    this.registry.register(definition);
    return this;
  }

  /** Register a recurring job. Takes effect immediately when the runner is already started. */
  schedule(spec: ScheduleSpec): this {
    if (!this.registry.has(spec.type)) {
      throw new Error(`cannot schedule unregistered job type: ${spec.type}`);
    }
    this.#scheduler.add(spec);
    return this;
  }

  /** Registered recurring jobs and when each fires next (null while the runner is stopped). */
  schedules(): { key: string; type: string; nextRunAt: number | null; everyMs: number | null }[] {
    return this.#scheduler.list().map(({ spec, key, nextRunAt }) => ({
      key,
      type: spec.type,
      nextRunAt,
      everyMs: 'every' in spec ? spec.every : null,
    }));
  }

  /**
   * Validate the payload and insert a job; returns its id. With a `uniqueKey` that is already
   * queued or running, nothing is inserted and the existing id is returned.
   */
  enqueue<TPayload>(
    job: string | JobDefinition<string, TPayload>,
    payload: unknown,
    options: EnqueueOptions = {},
  ): number {
    const type = typeof job === 'string' ? job : job.type;
    const def = this.registry.get(type);
    if (!def) throw new Error(`unknown job type: ${type}`);
    const parsed = def.payload.parse(payload); // throws ZodError on bad input
    const now = this.#now();
    const runAfter =
      options.runAfter !== undefined
        ? Number(options.runAfter)
        : now + Math.max(0, options.delayMs ?? 0);
    const maxAttempts = options.maxAttempts ?? def.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('maxAttempts must be an integer >= 1');
    }
    const insert = this.#sqlite.transaction((): number => {
      if (options.uniqueKey !== undefined) {
        const existing = this.#sqlite
          .prepare(
            `SELECT id FROM jobs WHERE unique_key = ? AND status IN ('queued','running') LIMIT 1`,
          )
          .get(options.uniqueKey) as { id: number } | undefined;
        if (existing) return existing.id;
      }
      const result = this.#sqlite
        .prepare(
          `INSERT INTO jobs (type, payload_json, priority, unique_key, max_attempts, run_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          type,
          JSON.stringify(parsed ?? null),
          options.priority ?? 0,
          options.uniqueKey ?? null,
          maxAttempts,
          runAfter,
          now,
          now,
        );
      return Number(result.lastInsertRowid);
    });
    // IMMEDIATE takes the write lock up front, so the existence check and insert are atomic
    // across processes sharing the file.
    const id = insert.immediate();
    this.wake();
    return id;
  }

  get(id: number): JobRecord | undefined {
    const row = this.#sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  get inFlight(): number {
    return this.#inflight.size;
  }

  get running(): boolean {
    return this.#started;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#accepting = true;
    this.recoverOnStart();
    this.#scheduler.start();
    this.#housekeepingTimer = setInterval(() => {
      try {
        this.housekeeping();
      } catch (err) {
        this.#log.error({ err }, 'job housekeeping failed');
      }
    }, this.#housekeepingMs);
    this.#housekeepingTimer.unref();
    this.#armPoll();
    this.wake();
    this.#log.info({ workerId: this.workerId, types: this.registry.types() }, 'job runner started');
  }

  /**
   * Stop claiming, give in-flight jobs `graceMs` to finish, then abort the rest and put them
   * back in the queue (attempt refunded) for the next start.
   */
  async stop({ graceMs = 10_000 }: { graceMs?: number } = {}): Promise<void> {
    if (!this.#started) return;
    this.#accepting = false;
    this.#started = false;
    this.#scheduler.stop();
    clearTimeout(this.#pollTimer);
    clearInterval(this.#housekeepingTimer);
    if (this.#inflight.size > 0) {
      const settled = (): Promise<void> =>
        Promise.all([...this.#inflight.values()].map((r) => r.done)).then(() => undefined);
      await Promise.race([settled(), sleep(graceMs)]);
      if (this.#inflight.size > 0) {
        this.#log.warn({ count: this.#inflight.size }, 'aborting in-flight jobs for shutdown');
        for (const run of this.#inflight.values()) run.controller.abort(new ShutdownAbort());
        await Promise.race([settled(), sleep(this.#abortWaitMs)]);
      }
    }
    this.#log.info('job runner stopped');
  }

  /** Resolves when nothing is in flight (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight.values()].map((r) => r.done));
    }
  }

  /** Ask for a claim pass soon (coalesced). Called by enqueue and after each job finishes. */
  wake(): void {
    if (!this.#accepting || this.#wakePending) return;
    this.#wakePending = true;
    setImmediate(() => {
      this.#wakePending = false;
      this.tick();
    });
  }

  /** Claim and dispatch as many due jobs as capacity allows. Returns how many started. */
  tick(): number {
    if (!this.#accepting) return 0;
    let started = 0;
    while (this.#inflight.size < this.#maxConcurrency) {
      const row = this.#claim();
      if (!row) break;
      this.#dispatch(row);
      started++;
    }
    return started;
  }

  // --- claiming ----------------------------------------------------------------------------

  #claim(): Row | undefined {
    const types = this.registry
      .definitions()
      .filter((d) => (this.#perType.get(d.type) ?? 0) < d.concurrency)
      .map((d) => d.type);
    if (types.length === 0) return undefined;
    const now = this.#now();
    const marks = types.map(() => '?').join(',');
    return this.#sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'running', locked_by = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = (
            SELECT id FROM jobs
             WHERE status = 'queued' AND run_after <= ? AND type IN (${marks})
             ORDER BY priority DESC, run_after ASC, id ASC
             LIMIT 1)
        RETURNING *`,
      )
      .get(this.workerId, now, now, now, ...types) as Row | undefined;
  }

  #armPoll(): void {
    clearTimeout(this.#pollTimer);
    if (!this.#accepting) return;
    this.#pollTimer = setTimeout(() => {
      try {
        this.tick();
      } catch (err) {
        this.#log.error({ err }, 'job poll failed');
      }
      this.#armPoll();
    }, this.#pollMs);
    this.#pollTimer.unref();
  }

  // --- execution ---------------------------------------------------------------------------

  #dispatch(row: Row): void {
    const controller = new AbortController();
    const run: Run = { row, controller, done: Promise.resolve() };
    this.#inflight.set(row.id, run);
    this.#perType.set(row.type, (this.#perType.get(row.type) ?? 0) + 1);
    run.done = this.#execute(run).finally(() => {
      this.#inflight.delete(row.id);
      this.#perType.set(row.type, (this.#perType.get(row.type) ?? 1) - 1);
      this.wake();
    });
  }

  async #execute(run: Run): Promise<void> {
    const { row, controller } = run;
    const log = this.#log.child({ jobId: row.id, jobType: row.type, attempt: row.attempts });
    const def = this.registry.get(row.type);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!def) throw new PermanentJobError(`no handler registered for ${row.type}`);
      const payloadResult = def.payload.safeParse(
        row.payload_json === null ? null : JSON.parse(row.payload_json),
      );
      if (!payloadResult.success) {
        throw new PermanentJobError(`stored payload is invalid: ${payloadResult.error.message}`);
      }
      const ctx: JobContext = {
        jobId: row.id,
        attempt: row.attempts,
        signal: controller.signal,
        log,
        db: this.#database.db,
        enqueue: (type, payload, options) => this.enqueue(type, payload, options),
      };
      // Race the handler against abort so a handler that ignores its signal cannot hold the
      // slot forever; its eventual result is then discarded.
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- reason is always one of our Error subclasses
          reject(controller.signal.reason);
        });
      });
      aborted.catch(() => undefined);
      if (def.timeoutMs !== undefined) {
        const ms = def.timeoutMs;
        timer = setTimeout(() => {
          controller.abort(new TimeoutAbort(ms));
        }, ms);
      }
      const handled = (async () => def.handler(payloadResult.data, ctx))();
      handled.catch(() => undefined); // an abandoned (timed-out) handler may still reject later
      await Promise.race([handled, aborted]);
      this.#finishSucceeded(row);
      log.debug('job succeeded');
    } catch (err) {
      this.#finishFailed(row, err, def, log);
    } finally {
      clearTimeout(timer);
    }
  }

  #finishSucceeded(row: Row): void {
    const now = this.#now();
    this.#sqlite
      .prepare(
        `UPDATE jobs SET status='succeeded', finished_at=?, updated_at=?, locked_by=NULL, locked_at=NULL
          WHERE id=? AND status='running' AND locked_by=?`,
      )
      .run(now, now, row.id, this.workerId);
  }

  #finishFailed(row: Row, err: unknown, def: JobDefinition | undefined, log: Logger): void {
    const now = this.#now();
    const message = formatJobError(err);
    const guard = `WHERE id = ? AND status = 'running' AND locked_by = ?`;
    if (err instanceof ShutdownAbort) {
      this.#sqlite
        .prepare(
          `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), locked_by=NULL, locked_at=NULL,
                  updated_at=? ${guard}`,
        )
        .run(now, row.id, this.workerId);
      log.warn('job interrupted by shutdown, re-queued');
      return;
    }
    const permanent = err instanceof PermanentJobError;
    const exhausted = row.attempts >= row.max_attempts;
    if (permanent || exhausted) {
      this.#sqlite
        .prepare(
          `UPDATE jobs SET status='dead', last_error=?, finished_at=?, updated_at=?, locked_by=NULL, locked_at=NULL ${guard}`,
        )
        .run(message, now, now, row.id, this.workerId);
      log.error({ err, permanent }, 'job dead');
      return;
    }
    const backoff: BackoffOptions = { ...DEFAULT_BACKOFF, ...def?.backoff };
    const delay = computeBackoffMs(row.attempts, backoff, this.#random);
    this.#sqlite
      .prepare(
        `UPDATE jobs SET status='queued', last_error=?, run_after=?, updated_at=?, locked_by=NULL, locked_at=NULL ${guard}`,
      )
      .run(message, now + delay, now, row.id, this.workerId);
    log.warn({ err, retryInMs: delay }, 'job failed, will retry');
  }

  // --- recovery ----------------------------------------------------------------------------

  /** On start: take back our own leftovers (previous run, same workerId) and any stale locks. */
  recoverOnStart(): number {
    return this.#recover(`(locked_by = ? OR locked_at IS NULL OR locked_at < ?)`, [
      this.workerId,
      this.#now() - this.#staleMs,
    ]);
  }

  /** Refresh locks we hold and take back stale locks of other workers. */
  housekeeping(): number {
    const now = this.#now();
    if (this.#inflight.size > 0) {
      const ids = [...this.#inflight.keys()];
      this.#sqlite
        .prepare(
          `UPDATE jobs SET locked_at = ? WHERE locked_by = ? AND status = 'running' AND id IN (${ids.map(() => '?').join(',')})`,
        )
        .run(now, this.workerId, ...ids);
    }
    return this.#recover(`(locked_by IS NOT ? AND (locked_at IS NULL OR locked_at < ?))`, [
      this.workerId,
      now - this.#staleMs,
    ]);
  }

  #recover(condition: string, params: unknown[]): number {
    const now = this.#now();
    const note = 'interrupted: worker lost or lock expired';
    const run = this.#sqlite.transaction((): number => {
      const dead = this.#sqlite
        .prepare(
          `UPDATE jobs SET status='dead', last_error=?, finished_at=?, updated_at=?, locked_by=NULL, locked_at=NULL
            WHERE status='running' AND attempts >= max_attempts AND ${condition}`,
        )
        .run(`${note}; attempts exhausted`, now, now, ...params).changes;
      const requeued = this.#sqlite
        .prepare(
          `UPDATE jobs SET status='queued', last_error=?, run_after=?, updated_at=?, locked_by=NULL, locked_at=NULL
            WHERE status='running' AND ${condition}`,
        )
        .run(note, now, now, ...params).changes;
      if (dead + requeued > 0) {
        this.#log.warn({ requeued, dead }, 'recovered interrupted jobs');
      }
      return requeued + dead;
    });
    return run.immediate();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
