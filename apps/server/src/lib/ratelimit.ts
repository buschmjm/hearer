/**
 * An async serial rate limiter: callers wait in FIFO order and at most one is released per
 * `intervalMs`. MusicBrainz allows 1 request/second per client, so every MusicBrainz call in the
 * process (search routes and background jobs alike) must go through the one shared instance
 * from `getMusicBrainzLimiter()`.
 */

export interface RateLimiterOptions {
  /** Minimum time between two released callers. 0 disables spacing (tests). */
  intervalMs: number;
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export class RateLimiter {
  readonly intervalMs: number;
  readonly #now: () => number;
  readonly #queue: Waiter[] = [];
  #nextAt = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError('intervalMs must be a non-negative number');
    }
    this.intervalMs = options.intervalMs;
    this.#now = options.now ?? Date.now;
  }

  /** Number of callers still waiting for their turn. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Resolves when it is this caller's turn. Rejects with the signal's reason when aborted. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  /** Wait for a turn, then run `fn`. The turn is spent even if `fn` throws. */
  async run<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    return fn();
  }

  /**
   * Push every future release back by at least `ms` from now (the server told us to back off,
   * e.g. via Retry-After). Never moves the schedule earlier.
   */
  penalize(ms: number): void {
    this.#nextAt = Math.max(this.#nextAt, this.#now() + Math.max(0, ms));
    // The armed timer, if any, was set for the old schedule; re-arm it.
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#pump();
    }
  }

  #pump(): void {
    if (this.#timer || this.#queue.length === 0) return;
    const wait = this.#nextAt - this.#now();
    if (wait <= 0) {
      this.#release();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#release();
    }, wait);
  }

  #release(): void {
    const waiter = this.#queue.shift();
    if (!waiter) return;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.#nextAt = this.#now() + this.intervalMs;
    waiter.resolve();
    this.#pump();
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

/** MusicBrainz asks for no more than one request per second. */
export const MUSICBRAINZ_INTERVAL_MS = 1000;

let musicBrainzLimiter: RateLimiter | undefined;

/** The process-global MusicBrainz limiter. Every MusicBrainz request must pass through it. */
export function getMusicBrainzLimiter(): RateLimiter {
  musicBrainzLimiter ??= new RateLimiter({ intervalMs: MUSICBRAINZ_INTERVAL_MS });
  return musicBrainzLimiter;
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds, or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
