import type { FastifyBaseLogger as Logger } from 'fastify';
import type { z } from 'zod';
import type { Db } from '../db/client.ts';

/**
 * Terminal-state model (one rule, no exceptions):
 *   - `succeeded`: the handler resolved.
 *   - `dead`: the job will never run again, whether it was a PermanentJobError, its attempts
 *     were exhausted, or its stored payload no longer validates. `last_error` says why.
 *   - `failed` exists in the shared enum but the runner never writes it.
 * Between attempts a job is `queued` with a later `run_after`.
 */

/** Throw from a handler to fail the job at once (no retries): bad input, a 4xx, a missing file. */
export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

export interface BackoffOptions {
  /** Delay before the second attempt. Default 5 000 ms. */
  baseMs: number;
  /** Upper bound on the delay (before jitter). Default 15 minutes. */
  maxMs: number;
  /** Fraction of the delay randomised in both directions, 0 to 1. Default 0.2. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, maxMs: 15 * 60_000, jitter: 0.2 };
export const DEFAULT_MAX_ATTEMPTS = 5;

/** `min(base * 2^(attempt-1), max)` with +/- jitter. `attempt` is the one that just failed (1-based). */
export function computeBackoffMs(
  attempt: number,
  backoff: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 40);
  const base = Math.min(backoff.baseMs * 2 ** exponent, backoff.maxMs);
  const spread = base * backoff.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(base + spread));
}

export type EnqueueFn = (type: string, payload: unknown, options?: EnqueueOptions) => number;

export interface JobContext {
  jobId: number;
  /** 1-based number of this attempt. */
  attempt: number;
  /** Aborted on shutdown or timeout; long handlers should pass it to fetch/fs calls. */
  signal: AbortSignal;
  log: Logger;
  db: Db;
  /** Enqueue a follow-up job (validated at runtime against its registered schema). */
  enqueue: EnqueueFn;
}

export interface JobDefinition<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: z.ZodType<TPayload>;
  /** Max simultaneous runs of this type in one runner. MB-bound types use 1. */
  concurrency: number;
  maxAttempts?: number;
  /** Abort the handler and count a failed attempt after this long. Default: no timeout. */
  timeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  handler: (payload: TPayload, ctx: JobContext) => Promise<void> | void;
}

export interface EnqueueOptions {
  /** Absolute time (ms since epoch or Date) before which the job must not run. */
  runAfter?: number | Date;
  /** Relative form of runAfter. Ignored when runAfter is given. */
  delayMs?: number;
  /** Higher runs first among due jobs. Default 0. */
  priority?: number;
  /** While a job with this key is queued or running, enqueueing it again returns that job's id. */
  uniqueKey?: string;
  maxAttempts?: number;
}

/** Declare a job; the type parameters infer from the zod schema so `handler` is fully typed. */
export function defineJob<TType extends string, TPayload>(
  definition: JobDefinition<TType, TPayload>,
): JobDefinition<TType, TPayload> {
  if (!Number.isInteger(definition.concurrency) || definition.concurrency < 1) {
    throw new RangeError(`job ${definition.type}: concurrency must be an integer >= 1`);
  }
  if (
    definition.maxAttempts !== undefined &&
    (!Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1)
  ) {
    throw new RangeError(`job ${definition.type}: maxAttempts must be an integer >= 1`);
  }
  if (definition.timeoutMs !== undefined && !(definition.timeoutMs > 0)) {
    throw new RangeError(`job ${definition.type}: timeoutMs must be > 0`);
  }
  return definition;
}

/** Holds the job definitions known to a runner. */
export class JobRegistry {
  // Definitions of different payload types share one map; each is only used through its own schema.
  readonly #jobs = new Map<string, JobDefinition>();

  register<TType extends string, TPayload>(definition: JobDefinition<TType, TPayload>): void {
    if (this.#jobs.has(definition.type)) {
      throw new Error(`job type already registered: ${definition.type}`);
    }
    this.#jobs.set(definition.type, definition as unknown as JobDefinition);
  }

  get(type: string): JobDefinition | undefined {
    return this.#jobs.get(type);
  }

  has(type: string): boolean {
    return this.#jobs.has(type);
  }

  types(): string[] {
    return [...this.#jobs.keys()];
  }

  definitions(): JobDefinition[] {
    return [...this.#jobs.values()];
  }
}
